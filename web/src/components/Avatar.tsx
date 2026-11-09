import { type CSSProperties, useId, useMemo, useState } from 'react';
import { storedValue } from '../../../shared/legacy-names.mjs';
import { hash32 } from '../../../shared/look.ts';
import { botonInner } from '../../../shared/boton.ts';
import type { AvatarState, Bot, BotonLook } from '../../../shared/types.ts';

/**
 * A Boton's avatar, drawn by the shared renderer. Its state shows in its face, arms and cues; the app's
 * busy dot, approval badge and preview text still say the same thing, so the avatar is never the only signal.
 * Decorative unless `label` is given (the Boton's name is next to it nearly everywhere).
 */
export function BotonAvatar(props: {
  look: BotonLook;
  size?: number;
  state?: AvatarState;
  /** Seeds the blink rate and motion phase, so a list of Botons never blinks in step. */
  seed?: string;
  /** No animation: brand marks, and chips too small for a blink to show. */
  still?: boolean;
  label?: string;
}) {
  const { look, size = 40, state = 'idle', seed = '', label } = props;
  const still = props.still ?? size < 24;
  const uid = `av${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  // The look's fields, not its identity: a store update that keeps the look keeps the markup.
  const key = `${look.shape} ${look.shell} ${look.glow} ${look.eyes} ${look.brows} ${look.mouth} ${look.top} ${look.ears} ${look.visor} ${look.panel} ${look.arms} ${look.backdrop} ${look.cheeks}`;
  const html = useMemo(() => botonInner(look, { size, state, uid, still }), [key, size, state, uid, still]);
  const h = hash32(seed);
  const style = { '--ph': ((h % 997) / 99.7).toFixed(2), '--blink': `${(5 + (h % 3001) / 1000).toFixed(2)}s` } as CSSProperties;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className="avatar"
      style={style}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** What a Boton's avatar shows: waiting for approval first, then working, then no working brain, then a failed last turn. */
export function avatarState(bot: Pick<Bot, 'status' | 'lastMessage'>, waiting: number, noBrain = false): AvatarState {
  if (waiting > 0) return 'approval';
  if (bot.status.state === 'working') return 'working';
  if (noBrain) return 'asleep';
  if (bot.status.state === 'idle' && bot.lastMessage?.role === 'error') return 'error';
  return 'idle';
}

const MOTION_KEY = 'botons.avatarMotion';

function storedMotion(): boolean {
  try {
    return storedValue(window.localStorage, MOTION_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** Puts this device's avatar motion choice on <html>, where the stylesheet reads it. Call once at startup. */
export function applyAvatarMotion(on = storedMotion()): void {
  document.documentElement.dataset.avatarMotion = on ? 'on' : 'off';
}

/** The pause control for avatar animation (blinks, bobs, waves), kept on this device. Reduced motion stops it too. */
export function AvatarMotionSetting() {
  const [on, setOn] = useState(storedMotion);
  return (
    <section className="server-info" aria-labelledby="avatar-motion-title">
      <h4 id="avatar-motion-title">On this device</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const next = e.target.checked;
            setOn(next);
            try {
              window.localStorage.setItem(MOTION_KEY, next ? 'on' : 'off');
            } catch {}
            applyAvatarMotion(next);
          }}
        />
        <span>Animate Botons</span>
      </label>
      <p className="hint">Blinks, the thinking ring and waves. Off, every Boton keeps still and its face and pose still show what it is doing. Your system's reduced-motion setting turns them off too.</p>
    </section>
  );
}
