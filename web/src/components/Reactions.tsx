import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Message } from '../../../shared/types.ts';
import { attempt, showToast } from '../feedback.ts';
import { actions, useStore } from '../state.ts';
import { clip, clock, cx, dateTime } from '../util.ts';
import type { RowBot } from './Approvals.tsx';
import { BotonAvatar } from './Avatar.tsx';
import { deferred, useDeferred } from './Deferred.tsx';
import { SmileIcon } from './Icons.tsx';

/*
 * Reactions in the chat. The owner reacts to the Boton's messages (role bot) only: never to an approval or a card,
 * which are decided with their own buttons (the server refuses those too). The Boton's reaction shows on the owner's
 * message with its avatar. Nothing changes on screen until the server has the change: its answer, or the
 * message.updated every device gets, puts it there (state.ts keeps a late answer from undoing a newer event).
 *
 * The picker is one for the whole chat, opened from a row's React button or a long press on its bubble, and its code
 * (with the full emoji catalog, a chunk of its own again) loads the first time it is wanted: a row holds only its
 * button and its reactions, and opening the picker re-renders no row.
 */

const pickerPart = deferred(() => import('./ReactionPicker.tsx'));
const preload = () => void pickerPart.load().catch(() => {});

interface Picking {
  botId: string;
  messageId: string;
  anchor: HTMLElement;
  /** Where focus goes when the picker closes: the row's React button. */
  returnTo: HTMLElement | null;
}

let picking: Picking | null = null;
const listeners = new Set<() => void>();
const pickerStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  get: () => picking,
};
function setPicking(p: Picking | null) {
  picking = p;
  for (const l of listeners) l();
}

/** Puts on or takes off one of the owner's reactions; a refusal (say, more than 10) is a toast saying why. */
export function toggleReaction(m: Message, emoji: string, botName: string): Promise<boolean> {
  const mine = m.reactions?.some((r) => r.by === 'owner' && r.emoji === emoji);
  return attempt(mine ? `take off your ${emoji}` : `react ${emoji} to ${botName}'s message`, () => (mine ? actions.unreact(m, emoji) : actions.react(m, emoji)));
}

/** The row's React button: a hover or focus shows it, a touch screen always (faintly). */
export function ReactButton({ m, bot }: { m: Message; bot: RowBot }) {
  const ref = useRef<HTMLButtonElement>(null);
  const open = useSyncExternalStore(pickerStore.subscribe, () => pickerStore.get()?.messageId === m.id);

  return (
    <button
      ref={ref}
      type="button"
      className="msg-react"
      aria-label={`React to ${bot.name}'s message`}
      title="Add a reaction"
      aria-haspopup="dialog"
      aria-expanded={open}
      onPointerEnter={preload}
      onFocus={preload}
      onClick={() => {
        if (open) return setPicking(null);
        const anchor = ref.current?.closest('.msg')?.querySelector<HTMLElement>('.bubble') ?? ref.current!;
        setPicking({ botId: m.botId, messageId: m.id, anchor, returnTo: ref.current });
      }}
    >
      <SmileIcon size={14} />
    </button>
  );
}

const LONG_PRESS_MS = 500;
/** A finger that moves this far is scrolling or selecting, not pressing. */
const SLOP_PX = 10;

/**
 * A long press on a Boton's bubble, by touch, opens the picker on it. A swipe that moves the finger, a lift, or a
 * scroll cancels it; nothing is prevented, so the page still scrolls and the text can still be selected.
 */
export function onBubblePress(e: ReactPointerEvent<HTMLElement>, m: Message) {
  if (e.pointerType !== 'touch' || !e.isPrimary) return;
  const bubble = e.currentTarget;
  const x = e.clientX;
  const y = e.clientY;
  preload();
  const stop = () => {
    clearTimeout(timer);
    removeEventListener('pointermove', move, true);
    removeEventListener('pointerup', stop, true);
    removeEventListener('pointercancel', stop, true);
    removeEventListener('scroll', stop, true);
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId === e.pointerId && Math.hypot(ev.clientX - x, ev.clientY - y) > SLOP_PX) stop();
  };
  const timer = setTimeout(() => {
    stop();
    const returnTo = bubble.closest('.msg')?.querySelector<HTMLElement>('.msg-react') ?? null;
    setPicking({ botId: m.botId, messageId: m.id, anchor: bubble, returnTo });
  }, LONG_PRESS_MS);
  addEventListener('pointermove', move, true);
  addEventListener('pointerup', stop, true);
  addEventListener('pointercancel', stop, true);
  addEventListener('scroll', stop, true);
}

/** The chat's one picker, for the message being reacted to, as the store has it now. */
export function ReactionPickerHost({ bot }: { bot: RowBot }) {
  const p = useSyncExternalStore(pickerStore.subscribe, pickerStore.get);
  const forThisChat = p && p.botId === bot.id ? p : null;
  const m = useStore((s) => (forThisChat ? s.messages[bot.id]?.items.find((x) => x.id === forThisChat.messageId) : undefined));
  // Another chat, or the message let go from the window: nothing to react to.
  useEffect(() => {
    if (p && (!forThisChat || !m)) setPicking(null);
  }, [p, forThisChat, m]);
  // The chat left with the picker open.
  useEffect(() => () => setPicking(null), [bot.id]);
  return forThisChat && m ? <OpenPicker key={m.id} p={forThisChat} m={m} bot={bot} /> : null;
}

/** Only while a picker is wanted: its code is fetched the first time. */
function OpenPicker({ p, m, bot }: { p: Picking; m: Message; bot: RowBot }) {
  const followUps = useStore((s) => s.settings?.reactionFollowUps);
  const { mod, failed } = useDeferred(pickerPart);
  useEffect(() => {
    if (!failed) return;
    setPicking(null);
    showToast({ kind: 'error', text: "Couldn't load the reactions. Check the connection to the server, or reload the page if Botons was updated." }, 8000);
  }, [failed]);
  if (!mod) return null;
  const close = (refocus: boolean) => {
    setPicking(null);
    if (refocus && p.returnTo?.isConnected) p.returnTo.focus({ preventScroll: true });
  };
  return (
    <mod.ReactionPicker
      m={m}
      botName={bot.name}
      anchor={p.anchor}
      followUps={followUps ?? []}
      onPick={(emoji) => {
        close(true);
        void toggleReaction(m, emoji, bot.name);
      }}
      onClose={close}
    />
  );
}

/**
 * The reactions on a message. The owner's own, on the Boton's message, are toggle buttons that take it off; the
 * Boton's, on the owner's message, carry its avatar.
 */
export function ReactionBar({ m, bot }: { m: Message; bot: RowBot }) {
  const list = m.reactions;
  if (!list?.length) return null;
  const owner = list.filter((r) => r.by === 'owner');
  const boton = list.filter((r) => r.by === 'boton');
  return (
    <div className="reactions" role="group" aria-label={m.role === 'bot' ? 'Your reactions' : `${bot.name}'s reaction`}>
      {owner.map((r) => (
        <OwnerReaction key={r.emoji} m={m} emoji={r.emoji} at={r.at} botName={bot.name} />
      ))}
      {boton.map((r) => (
        <BotonReaction key={r.emoji} botId={bot.id} name={bot.name} emoji={r.emoji} at={r.at} />
      ))}
    </div>
  );
}

function OwnerReaction({ m, emoji, at, botName }: { m: Message; emoji: string; at: string; botName: string }) {
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      className="reaction mine"
      aria-pressed="true"
      aria-label={emoji}
      title={`You reacted ${emoji} at ${clock(at)}. Click to take it off.`}
      disabled={busy}
      onClick={async () => {
        // The button goes with the reaction: focus moves on to the one beside it, or to the row's React button.
        const row = ref.current?.closest('.msg');
        const next = (ref.current?.nextElementSibling ?? ref.current?.previousElementSibling) as HTMLElement | null;
        setBusy(true);
        const ok = await toggleReaction(m, emoji, botName);
        if (ref.current?.isConnected) setBusy(false);
        if (ok && !ref.current?.isConnected) (next?.isConnected ? next : row?.querySelector<HTMLElement>('.msg-react'))?.focus({ preventScroll: true });
      }}
    >
      {emoji}
    </button>
  );
}

function BotonReaction({ botId, name, emoji, at }: { botId: string; name: string; emoji: string; at: string }) {
  const look = useStore((s) => s.bots.find((b) => b.id === botId)?.look);
  return (
    <span className="reaction theirs" role="img" aria-label={`${name} reacted ${emoji}`} title={`${name} reacted ${emoji} · ${dateTime(at)}`}>
      {look && <BotonAvatar look={look} size={16} still />}
      <span aria-hidden="true">{emoji}</span>
    </span>
  );
}

/**
 * The owner's follow-up reaction (Settings.reactionFollowUps), as the chat records it: the request for a short
 * follow-up turn, or, taken off before that turn started, that none ran.
 */
export function FollowUpChip({ m, bot }: { m: Message; bot: RowBot }) {
  const target = m.meta?.reactionTo;
  const excerpt = useStore((s) => (target ? s.messages[bot.id]?.items.find((x) => x.id === target)?.text : undefined));
  const emoji = m.meta?.emoji ?? '';
  const withdrawn = !!m.meta?.withdrawn;
  return (
    <div className={cx('event-chip reaction-followup', withdrawn && 'withdrawn')} title={dateTime(m.createdAt)}>
      <span>{withdrawn ? `You took off ${emoji} before ${bot.name} followed up: no follow-up` : `You reacted ${emoji}: ${bot.name} follows up`}</span>
      {excerpt && <span className="chip-quote">“{clip(excerpt.replace(/\s+/g, ' '), 60)}”</span>}
    </div>
  );
}
