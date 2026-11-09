import { type FormEvent, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { handoffWaiting } from '../../../shared/handoff.ts';
import { LiveParser, toPagePoint } from '../../../shared/live-view.ts';
import type { Bot, BrowserHandover, BrowserHandoverInput, BrowserHandoverResult, HandoverNotice, Message } from '../../../shared/types.ts';
import { ApiError, api } from '../api.ts';
import { copyText } from '../copy.ts';
import { errorText, modalStore } from '../feedback.ts';
import { useStore } from '../state.ts';
import { keyAction, takeover, useTakeover } from '../takeover.ts';
import { clock, dateTime } from '../util.ts';
import { BotonAvatar } from './Avatar.tsx';
import { BackIcon, CloseIcon, RefreshIcon } from './Icons.tsx';
import { Toasts } from './Toasts.tsx';

/*
 * The owner driving a Boton's browser in a live view over the chat: a sheet on a phone, a large window on a desktop
 * (full screen with one tap). The server streams the page as it paints and takes the owner's own input straight from
 * the view: the pointer, the wheel or a finger, keys and typing into whatever the page has focused, copy and paste.
 * What the owner types goes to the page and nowhere else, only this device drives it, and the Boton can't use its
 * browser until the owner taps Done. Where the stream can't run, frames are fetched one after another instead.
 */

type Input = BrowserHandoverInput extends infer T ? (T extends { handover: string } ? Omit<T, 'handover'> : never) : never;

const HOVER_EVERY_MS = 60;
const DRAG_EVERY_MS = 25;
const POLL_EVERY_MS = 250;

/** The Boton's browser in a handover is open for this device: drawn over everything, from wherever it was opened. */
export function TakeoverHost() {
  const botId = useTakeover();
  const bot = useStore((s) => (botId ? (s.bots.find((b) => b.id === botId) ?? null) : null));
  if (!botId || !bot) return null;
  return <Takeover key={botId} bot={bot} onClose={() => takeover.close()} />;
}

/** One at a time, in order; moves keep only the newest, wheel turns add up and text typed in a row goes as one. */
class Sender {
  #queue: Input[] = [];
  #busy = false;
  constructor(
    private send: (i: Input) => Promise<BrowserHandoverResult | null>,
    private onResult: (i: Input, r: BrowserHandoverResult) => void,
  ) {}
  push(i: Input) {
    const last = this.#queue.at(-1);
    if (last && last.action === 'move' && i.action === 'move') this.#queue[this.#queue.length - 1] = i;
    else if (last && last.action === 'wheel' && i.action === 'wheel') this.#queue[this.#queue.length - 1] = { ...i, dx: clampWheel(last.dx + i.dx), dy: clampWheel(last.dy + i.dy) };
    else if (last && last.action === 'type' && i.action === 'type' && last.text.length + i.text.length <= 1000) this.#queue[this.#queue.length - 1] = { action: 'type', text: last.text + i.text };
    else this.#queue.push(i);
    void this.#run();
  }
  async #run() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#queue.length) {
        const next = this.#queue.shift()!;
        const r = await this.send(next);
        if (r) this.onResult(next, r);
      }
    } finally {
      this.#busy = false;
    }
  }
  clear() {
    this.#queue = [];
  }
}
const clampWheel = (v: number) => Math.max(-4000, Math.min(4000, Math.round(v)));

/** The view's size on screen, for the page to follow. */
function boxOf(el: HTMLElement | null) {
  const r = el?.getBoundingClientRect();
  return r ? { width: Math.floor(r.width), height: Math.floor(r.height) } : { width: 1280, height: 800 };
}

export function Takeover({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const keys = useRef<HTMLTextAreaElement>(null);
  const [handover, setHandover] = useState<BrowserHandover | null>(null);
  const [problem, setProblem] = useState<{ text: string; elsewhere?: { id: string; device: string } } | null>(null);
  const [page, setPage] = useState<{ url: string; title: string } | null>(null);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [siteError, setSiteError] = useState<{ url: string; status: number } | null>(null);
  const [paused, setPaused] = useState<{ url: string; why: string; n: number } | null>(null);
  const [details, setDetails] = useState(false);
  const [full, setFull] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const size = useRef({ width: 1280, height: 800 });
  const ended = useRef(false);
  const touchy = useRef(false);
  const modal = useRef<number | null>(null);
  const [modalId, setModalId] = useState<number | null>(null);
  const newest = useSyncExternalStore(modalStore.subscribe, modalStore.top, () => null);

  // Registered as the newest modal (so toasts show in it), and shown as one.
  useLayoutEffect(() => {
    const id = modalStore.open();
    modal.current = id;
    setModalId(id);
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => {
      modalStore.close(id);
      if (d?.open) d.close();
    };
  }, []);

  // Done: the handover ends whatever this view thinks of it (ending one already over changes nothing), and one still
  // being taken over as the owner leaves is ended as soon as it arrives.
  const closing = useRef(false);
  const finish = async () => {
    closing.current = true;
    ended.current = true;
    const h = handoverRef.current;
    if (h) await api.finishHandover(bot.id, h.id).catch(() => null);
    onClose();
  };
  const endedHere = (text: string) => {
    ended.current = true;
    setProblem({ text });
  };

  // The handover: this device's if it has one, else taken now at this view's size.
  useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const status = await api.browser(bot.id);
        const h = status.handover;
        if (gone) {
          // Done while this was loading: this device's handover ends all the same.
          if (closing.current && h?.byThisDevice) void api.finishHandover(bot.id, h.id).catch(() => null);
          return;
        }
        if (h && !h.byThisDevice) {
          setProblem({ text: `${bot.name}'s browser is open on ${h.deviceLabel}.`, elsewhere: { id: h.id, device: h.deviceLabel } });
          return;
        }
        const box = boxOf(view.current);
        const taken = h ?? (await api.takeOverBrowser(bot.id, { width: box.width, height: box.height }));
        if (gone) {
          if (closing.current) void api.finishHandover(bot.id, taken.id).catch(() => null);
          return;
        }
        size.current = taken.viewport;
        setHandover(taken);
        setPage(taken.page);
      } catch (e) {
        if (!gone) setProblem({ text: errorText(e) });
      }
    })();
    return () => {
      gone = true;
    };
  }, [bot.id]);

  // Draws a frame: only the newest one waiting is decoded, so a slow device skips frames instead of falling behind.
  const draw = useRef<(jpeg: Blob, w: number, h: number) => void>(() => {});
  useEffect(() => {
    let pending: { jpeg: Blob; w: number; h: number } | null = null;
    let decoding = false;
    const run = async () => {
      if (decoding) return;
      decoding = true;
      while (pending) {
        const { jpeg, w, h } = pending;
        pending = null;
        try {
          const img = await createImageBitmap(jpeg);
          const c = canvas.current;
          if (c) {
            if (c.width !== img.width || c.height !== img.height) {
              c.width = img.width;
              c.height = img.height;
            }
            c.getContext('2d')?.drawImage(img, 0, 0);
            size.current = { width: w, height: h };
            setDrawn(true);
          }
          img.close();
        } catch {}
      }
      decoding = false;
    };
    draw.current = (jpeg, w, h) => {
      pending = { jpeg, w, h };
      void run();
    };
  }, []);

  // The live stream while the page is visible; frames one after another where it can't run.
  useEffect(() => {
    if (!handover) return;
    let stop = false;
    let ctl = new AbortController();
    let failures = 0;
    let poll = false;
    const notice = (n: HandoverNotice) => {
      if (n.type === 'page') {
        setPage({ url: n.url, title: n.title });
        setSiteError((e) => (e && e.url === n.url ? e : null));
      } else if (n.type === 'site-error') setSiteError({ url: n.url, status: n.status });
      else if (n.type === 'paused') setPaused((p) => ({ url: n.url, why: n.why, n: (p?.n ?? 0) + 1 }));
      else if (n.type === 'ended') endedHere(`${bot.name} has its browser back.`);
    };
    const streamOnce = async () => {
      const res = await api.handoverStream(bot.id, ctl.signal);
      const reader = res.body!.getReader();
      const parser = new LiveParser();
      let frames = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (stop) return;
        // Ended without a frame: the server couldn't cast (frames are fetched instead after two of these).
        if (done) {
          if (!frames && !ended.current) throw new Error('The live view sent no frames');
          return;
        }
        for (const c of parser.push(value)) {
          if (c.kind === 'frame') {
            if (!frames++) failures = 0;
            draw.current(new Blob([c.jpeg as BlobPart], { type: 'image/jpeg' }), c.width, c.height);
          } else notice(c.notice as HandoverNotice);
        }
      }
    };
    const pollOnce = async () => {
      const blob = await api.handoverFrame(bot.id, ctl.signal);
      const img = await createImageBitmap(blob);
      // A polled frame is the page at its CSS size.
      draw.current(blob, img.width, img.height);
      img.close();
      await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    };
    const loop = async () => {
      while (!stop && !ended.current) {
        if (document.visibilityState !== 'visible') {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        try {
          if (poll) await pollOnce();
          else await streamOnce();
        } catch (e) {
          if (stop) return;
          if (e instanceof ApiError && (e.status === 409 || e.status === 403)) return endedHere(errorText(e));
          if (!poll && ++failures >= 2 && !(e instanceof DOMException)) poll = true;
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    };
    const onVisible = () => {
      // Hidden: the stream closes (the idle limit runs); shown again, it opens anew.
      ctl.abort();
      ctl = new AbortController();
    };
    document.addEventListener('visibilitychange', onVisible);
    void loop();
    return () => {
      stop = true;
      ctl.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [handover?.id]);

  // Inputs, in order.
  const sender = useRef<Sender | null>(null);
  if (!sender.current) {
    sender.current = new Sender(
      async (i) => {
        if (ended.current || !handoverRef.current) return null;
        try {
          return await api.handoverInput(bot.id, { ...i, handover: handoverRef.current.id } as BrowserHandoverInput);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            sender.current?.clear();
            endedHere(errorText(e));
          } else if (!(e instanceof ApiError && e.status === 429)) setNote(errorText(e));
          return null;
        }
      },
      (i, r) => {
        if (r.outcome === 'refused') setNote(r.message);
        const navigated = i.action === 'open' || i.action === 'resume' || i.action === 'back' || i.action === 'forward' || i.action === 'reload';
        if (navigated && r.outcome !== 'refused') setNote(null);
        if (r.page && navigated) setPage(r.page);
        if (i.action === 'copy' && r.copied) void copyText(r.copied);
        // A phone shows its keyboard only while the page has a text field focused.
        if (touchy.current && r.editable === false) keys.current?.blur();
      },
    );
  }
  const handoverRef = useRef<BrowserHandover | null>(null);
  handoverRef.current = handover;
  const send = (i: Input) => sender.current!.push(i);

  // The page follows the view's size.
  useEffect(() => {
    if (!handover || !view.current) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const box = boxOf(view.current);
        if (box.width > 0 && box.height > 0) send({ action: 'resize', ...box });
      }, 250);
    });
    ro.observe(view.current);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [handover?.id]);

  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return toPagePoint(e.clientX, e.clientY, { left: r.left, top: r.top, width: r.width, height: r.height }, size.current);
  };
  const focusKeys = () => keys.current?.focus({ preventScroll: true });

  // The pointer: a mouse or pen presses, moves and releases as itself; a finger taps to click and drags to scroll.
  const lastMove = useRef(0);
  const touch = useRef<{ x: number; y: number; lastX: number; lastY: number; scrolled: boolean } | null>(null);
  const buttons = ['left', 'middle', 'right'] as const;
  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!handover) return;
    e.preventDefault();
    touchy.current = e.pointerType === 'touch';
    if (e.pointerType === 'touch') {
      touch.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, scrolled: false };
      return;
    }
    focusKeys();
    const p = point(e);
    if (!p) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    send({ action: 'down', ...p, button: buttons[e.button] ?? 'left', ...(e.detail > 1 ? { count: Math.min(3, e.detail) } : {}) });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!handover) return;
    if (e.pointerType === 'touch') {
      const t = touch.current;
      if (!t) return;
      if (!t.scrolled && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 8) return;
      t.scrolled = true;
      const p = point(e) ?? point({ clientX: t.x, clientY: t.y });
      const scale = canvas.current ? size.current.width / canvas.current.getBoundingClientRect().width : 1;
      if (p) send({ action: 'wheel', ...p, dx: clampWheel((t.lastX - e.clientX) * scale), dy: clampWheel((t.lastY - e.clientY) * scale) });
      t.lastX = e.clientX;
      t.lastY = e.clientY;
      return;
    }
    const now = performance.now();
    if (now - lastMove.current < (e.buttons ? DRAG_EVERY_MS : HOVER_EVERY_MS)) return;
    lastMove.current = now;
    const p = point(e);
    if (p) send({ action: 'move', ...p });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!handover) return;
    if (e.pointerType === 'touch') {
      const t = touch.current;
      touch.current = null;
      if (!t || t.scrolled) return;
      // In the tap itself, so a phone may show its keyboard; hidden again if the page has no text field focused.
      focusKeys();
      const p = point(e);
      if (p) send({ action: 'click', ...p });
      return;
    }
    const p = point(e);
    if (p) send({ action: 'up', ...p, button: buttons[e.button] ?? 'left', ...(e.detail > 1 ? { count: Math.min(3, e.detail) } : {}) });
  };

  // The wheel and a trackpad scroll the page under the pointer.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = point(e);
      if (!p) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.current.height : 1;
      send({ action: 'wheel', ...p, dx: clampWheel(e.deltaX * unit), dy: clampWheel(e.deltaY * unit) });
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [handover?.id]);

  // Keys and text: typed into a hidden box that has the focus whenever the view does, so a phone's keyboard and input
  // methods work; named keys and editing shortcuts are pressed, the rest is typed.
  const composing = useRef(false);
  useEffect(() => {
    const k = keys.current;
    if (!k) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (composing.current || e.isComposing) return;
      const a = keyAction(e);
      if (a.kind === 'own' || a.kind === 'text' || a.kind === 'paste') return;
      e.preventDefault();
      e.stopPropagation();
      if (a.kind === 'copy') {
        send({ action: 'copy' });
        if (a.cut) send({ action: 'key', key: 'Backspace' });
      } else send({ action: 'key', key: a.key, ...(a.mods.length ? { mods: a.mods } : {}) });
    };
    const onBeforeInput = (e: InputEvent) => {
      if (e.inputType === 'insertCompositionText') return;
      e.preventDefault();
      if ((e.inputType === 'insertText' || e.inputType === 'insertReplacementText') && e.data) typeText(e.data);
      else if (e.inputType === 'deleteContentBackward') send({ action: 'key', key: 'Backspace' });
      else if (e.inputType === 'deleteContentForward') send({ action: 'key', key: 'Delete' });
      else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') send({ action: 'key', key: 'Enter' });
    };
    const onCompositionStart = () => (composing.current = true);
    const onCompositionEnd = (e: CompositionEvent) => {
      composing.current = false;
      if (e.data) typeText(e.data);
      k.value = '';
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData?.getData('text/plain') ?? '';
      for (let i = 0; i < text.length; i += 5000) send({ action: 'paste', text: text.slice(i, i + 5000) });
    };
    k.addEventListener('keydown', onKeyDown);
    k.addEventListener('beforeinput', onBeforeInput);
    k.addEventListener('compositionstart', onCompositionStart);
    k.addEventListener('compositionend', onCompositionEnd);
    k.addEventListener('paste', onPaste);
    return () => {
      k.removeEventListener('keydown', onKeyDown);
      k.removeEventListener('beforeinput', onBeforeInput);
      k.removeEventListener('compositionstart', onCompositionStart);
      k.removeEventListener('compositionend', onCompositionEnd);
      k.removeEventListener('paste', onPaste);
    };
  }, [handover?.id]);
  const typeText = (text: string) => {
    // Control characters are keys, not text: a tab or new line typed in one go is pressed.
    for (const part of text.split(/([\t\n])/)) {
      if (part === '\t') send({ action: 'key', key: 'Tab' });
      else if (part === '\n') send({ action: 'key', key: 'Enter' });
      else if (part) for (let i = 0; i < part.length; i += 1000) send({ action: 'type', text: part.slice(i, i + 1000).replace(/[\u0000-\u001f\u007f]/g, '') });
    }
  };

  const open = (e: FormEvent) => {
    e.preventDefault();
    const url = address.trim();
    if (!url) return;
    setEditing(false);
    // The address is said again once it is left; a phone's keyboard closes with it.
    (document.activeElement as HTMLElement | null)?.blur();
    send({ action: 'open', url });
    if (!touchy.current && !matchMedia('(pointer: coarse)').matches) focusKeys();
  };
  const shownUrl = page?.url ?? '';
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  const busy = !handover && !problem;

  return createPortal(
    <dialog
      ref={dialog}
      className={['takeover', full && 'full'].filter(Boolean).join(' ')}
      aria-label={`${bot.name}'s browser`}
      onCancel={(e) => {
        // Esc belongs to the page while it has the keys; the owner leaves with Done.
        e.preventDefault();
      }}
    >
      <div className="takeover-bar">
        <span className="takeover-who">
          <BotonAvatar look={bot.look} size={22} seed={bot.id} />
          <span className="takeover-name">{bot.name}</span>
        </span>
        <div className="takeover-nav" role="group" aria-label="Navigation">
          <button type="button" className="icon-btn round" aria-label="Back" title="Back" disabled={!handover} onClick={() => send({ action: 'back' })}>
            <BackIcon />
          </button>
          <button type="button" className="icon-btn round takeover-forward" aria-label="Forward" title="Forward" disabled={!handover} onClick={() => send({ action: 'forward' })}>
            <BackIcon style={{ transform: 'scaleX(-1)' }} />
          </button>
          <button type="button" className="icon-btn round" aria-label="Reload" title="Reload" disabled={!handover} onClick={() => send({ action: 'reload' })}>
            <RefreshIcon />
          </button>
        </div>
        <form className="takeover-url" onSubmit={open}>
          <input
            aria-label="Address"
            value={editing ? address : shownUrl}
            placeholder="Search or type an address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            inputMode="url"
            enterKeyHint="go"
            disabled={!handover}
            onFocus={(e) => {
              setEditing(true);
              setAddress(shownUrl);
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
          />
        </form>
        <button type="button" className="icon-btn round desktop-only" aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen' : 'Full screen'} onClick={() => setFull((f) => !f)}>
          <ExpandIcon full={full} />
        </button>
        <button type="button" className="btn primary takeover-done" onClick={() => void finish()}>
          Done — hand back
        </button>
      </div>
      <p className="takeover-line">
        Only you drive it. {bot.name} waits until you hand back.{' '}
        <button type="button" className="link-btn" aria-expanded={details} onClick={() => setDetails((d) => !d)}>
          Details
        </button>
      </p>
      {details && (
        <p className="takeover-details">
          What you type goes into the page and nowhere else: Botons doesn't keep, log or show it, and {bot.name} never sees it. Only this device drives the
          browser, and only {bot.name}'s sites load. A sign-in stays in {bot.name}'s browser after you hand back. It hands back by itself after 10 quiet
          minutes.
        </p>
      )}
      {siteError && (
        <p className="takeover-site" role="status">
          <strong>{host(siteError.url)}</strong> answered with an error ({siteError.status}). That's the site's own page, not Botons.
        </p>
      )}
      {paused && (
        <p className="takeover-paused" role="status" title={paused.why}>
          Botons paused {paused.n > 1 ? `${paused.n} requests` : 'a request'} {host(paused.url)} sent on its own. What you click and type still goes.
        </p>
      )}
      <div className="takeover-view" ref={view}>
        <canvas
          ref={canvas}
          className={drawn ? 'shown' : ''}
          aria-label={page ? `${bot.name}'s browser: ${page.title || page.url}` : `${bot.name}'s browser`}
          role="img"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (touch.current = null)}
          onContextMenu={(e) => e.preventDefault()}
        />
        <textarea ref={keys} className="takeover-keys" aria-label="Type into the page" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
        {busy && <p className="takeover-state">Opening {bot.name}'s browser…</p>}
        {problem && (
          <div className="takeover-state">
            <p>{problem.text}</p>
            {problem.elsewhere && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void api
                    .finishHandover(bot.id, problem.elsewhere!.id)
                    .then(() => onClose())
                    .catch((e) => setProblem({ text: errorText(e) }))
                }
              >
                End it there
              </button>
            )}
            <button type="button" className="btn primary" onClick={onClose}>
              Close
            </button>
          </div>
        )}
        {handover && drawn && !page && !problem && (
          <div className="takeover-start">
            {handover.resume ? (
              <button type="button" className="btn primary" onClick={() => send({ action: 'resume' })}>
                Open {host(handover.resume)}
              </button>
            ) : (
              <p>Type an address above to begin.</p>
            )}
          </div>
        )}
        {note && !problem && (
          <p className="takeover-note" role="status">
            {note}
          </p>
        )}
      </div>
      {modalId !== null && newest === modalId && <Toasts />}
    </dialog>,
    document.body,
  );
}

function ExpandIcon({ full }: { full: boolean }) {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {full ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
    </svg>
  );
}

/** The globe in the chat header: opens the Boton's browser in the live view. */
export function BrowserButton({ bot }: { bot: Bot }) {
  return (
    <button className="icon-btn round" aria-label={`Open ${bot.name}'s browser`} title="Browser" onClick={() => takeover.open(bot.id)}>
      <GlobeIcon />
    </button>
  );
}

export function GlobeIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9s1.3-6.4 3.8-9z" />
    </svg>
  );
}

/** The Boton's request in the chat: Take over while it waits, then how it went. */
export function HandoffCard({ bot, m }: { bot: Pick<Bot, 'id' | 'name'>; m: Message }) {
  const h = m.meta?.browserHandoff;
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().toISOString()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!h) return null;
  const waiting = handoffWaiting(h, now);
  const state = waiting ? 'requested' : h.state === 'requested' ? 'closed' : h.state;
  const take = () => takeover.open(bot.id);
  return (
    <section className={`tcard handoff is-${state}`} id={`card-${m.id}`} aria-label={`Your turn in ${bot.name}'s browser`}>
      <div className="tcard-head">
        <GlobeIcon size={15} />
        <span>{state === 'requested' ? `${bot.name} needs you` : `${bot.name}'s browser`}</span>
        <span className="tcard-time" title={dateTime(m.createdAt)}>
          {clock(m.createdAt)}
        </span>
      </div>
      <h3 className="tcard-title">
        {state === 'requested' ? `Your turn in ${bot.name}'s browser` : state === 'taken' ? `You have ${bot.name}'s browser` : state === 'handed-back' ? 'Handed back' : 'No longer needed'}
      </h3>
      <p className="tcard-text handoff-reason">“{h.reason}”</p>
      {state === 'requested' && (
        <div className="handoff-actions">
          <button type="button" className="btn primary" onClick={take}>
            Take over
          </button>
        </div>
      )}
      {state === 'taken' && (
        <div className="handoff-actions">
          <button type="button" className="btn" onClick={take}>
            Open
          </button>
          {h.takenBy && <span className="tcard-faint">on {h.takenBy}</span>}
        </div>
      )}
      {state === 'handed-back' && <p className="tcard-faint">{h.page ? `Left on ${h.page}` : 'No page open'}{h.how && h.how !== 'finished' ? ` · ${h.how}` : ''}</p>}
    </section>
  );
}
