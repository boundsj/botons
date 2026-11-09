/** Keep Safari's keyboard pan out of the app shell. No React state: typing must not redraw the chat. */
export function lockViewport() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  const update = () => {
    frame = 0;
    // Pinch zoom must remain native; don't resize or reset its pan.
    if (viewport && viewport.scale !== 1) return;
    root.style.setProperty('--app-height', `${viewport?.height ?? window.innerHeight}px`);
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const events: [EventTarget, string][] = [
    [window, 'resize'], [window, 'orientationchange'], [window, 'pageshow'],
    [document, 'visibilitychange'], [document, 'focusout'],
    ...(viewport ? [[viewport, 'resize'], [viewport, 'scroll']] as [EventTarget, string][] : []),
  ];
  for (const [target, event] of events) target.addEventListener(event, schedule);
  update();
  return () => {
    cancelAnimationFrame(frame);
    for (const [target, event] of events) target.removeEventListener(event, schedule);
    root.style.removeProperty('--app-height');
  };
}
