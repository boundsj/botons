import { useId } from 'react';
import { logoSvg, MARK_VIEWBOX, markInner } from '../../../shared/brand.ts';

const uidFrom = (id: string) => `b${id.replace(/[^A-Za-z0-9_-]/g, '')}`;

/** The brand Boton on its own: the app's mark on setup, the pair screen and wherever the logo has no room. */
export function BrandMark({ size = 40, label }: { size?: number; label?: string }) {
  const uid = uidFrom(useId());
  return (
    <svg
      className="brand-mark"
      width={Math.round((size * 60) / 86)}
      height={size}
      viewBox={MARK_VIEWBOX}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      dangerouslySetInnerHTML={{ __html: markInner(uid) }}
    />
  );
}

/** The logo: the brand Boton and the "botons" wordmark, which takes the text color. Named "Botons" to screen readers. */
export function Logo({ height = 26 }: { height?: number }) {
  const uid = uidFrom(useId());
  return <span className="logo" style={{ height }} dangerouslySetInnerHTML={{ __html: logoSvg({ uid, height }) }} />;
}
