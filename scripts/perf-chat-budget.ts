// What scripts/perf-chat.ts injects into the page to count React's renders, and its --budget, apart from the
// harness so a test can run both without Chrome.

// Injected before the app loads: counts React commits and the components that rendered in each,
// the way React DevTools decides it (a fiber that performed work; untouched subtrees are skipped).
export const PAGE_HOOK = String.raw`
(() => {
  const perf = { commits: 0, renders: {}, latencies: [], longTasks: 0, longTaskMs: 0 };
  window.__perf = perf;
  perf.reset = () => { perf.commits = 0; perf.renders = {}; perf.latencies = []; perf.longTasks = 0; perf.longTaskMs = 0; };
  const nameOf = (f) => { const t = f.type; if (!t || typeof t === 'string') return null; return t.displayName || t.name || (t.type && (t.type.displayName || t.type.name)) || (t.render && (t.render.displayName || t.render.name)) || null; };
  const FN = new Set([0, 1, 11, 14, 15]);
  const walk = (f) => {
    while (f) {
      const prev = f.alternate;
      if (FN.has(f.tag)) {
        const did = prev === null || (f.flags & 1) === 1;
        if (did) { const n = nameOf(f) || '?'; perf.renders[n] = (perf.renders[n] || 0) + 1; }
      }
      if (f.child && (prev === null || f.child !== prev.child)) walk(f.child);
      f = f.sibling;
    }
  };
  let id = 0;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(r) { id++; this.renderers.set(id, r); return id; },
    onCommitFiberRoot(_id, root) { perf.commits++; perf.root = root; const cur = root.current; walk(cur.child); },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {}, checkDCE() {},
  };
  // Components of one name in the tree React last committed: one MessageView per message the chat holds.
  perf.mounted = (name) => {
    let n = 0;
    const stack = perf.root ? [perf.root.current] : [];
    while (stack.length) { const f = stack.pop(); if (FN.has(f.tag) && nameOf(f) === name) n++; if (f.sibling) stack.push(f.sibling); if (f.child) stack.push(f.child); }
    return n;
  };
  // Keydown to the frame after it: rAF runs before the paint, the message after it.
  addEventListener('keydown', (e) => {
    const start = e.timeStamp;
    requestAnimationFrame(() => { const ch = new MessageChannel(); ch.port1.onmessage = () => perf.latencies.push(performance.now() - start); ch.port2.postMessage(0); });
  }, true);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { perf.longTasks++; perf.longTaskMs += e.duration; } }).observe({ type: 'longtask' }); } catch {}
})();
`;

/**
 * --budget: typing re-renders no message row, and a turn renders only its own new rows (the message
 * sent and the reply, and the row before each if grouping changes). Returns what went over, empty when within.
 *
 * Most budgets are "no more than", so a count that reads 0 because nothing was counted would pass them. The
 * counters find message rows by their component name (MessageView), which a minified build doesn't keep; so
 * before anything else the counters must have seen rows: opening the chat mounts them, a turn renders its
 * new ones, and a full window holds them in React's tree. When they didn't, nothing below can be trusted.
 */
export function overBudget(r: any, windowSize: number): string[] {
  const unseen: string[] = [];
  if (!(r.open?.firstRenders?.commits > 0)) unseen.push(`opening the chat counted ${r.open?.firstRenders?.commits ?? 'no'} React commits`);
  if (!(r.open?.firstRenders?.rows > 0)) unseen.push(`opening the chat counted ${r.open?.firstRenders?.rows ?? 'no'} message rows rendered`);
  if (!(r.turn?.commits > 0) || !(r.turn?.messageRowsRendered > 0)) unseen.push(`a turn counted ${r.turn?.commits ?? 'no'} commits and ${r.turn?.messageRowsRendered ?? 'no'} message rows rendered`);
  for (const [where, x] of [['live near the top', r.liveWindow?.nearTop], ['live near the bottom', r.liveWindow?.nearBottom]]) {
    if (!(x?.start?.mounted > 0) || !(x?.maxMessageViews > 0)) unseen.push(`${where}: ${x?.start?.rows ?? '?'} rows on the page but ${x?.start?.mounted ?? 'no'} message rows found in React's tree`);
  }
  if (unseen.length) return [`the render counters saw no message rows, so the budgets can't be checked (is the web app minified? perf-chat builds it unminified unless --skip-build is given):`, ...unseen.map((u) => `  ${u}`)];
  const over: string[] = [];
  for (const [where, t] of [['100 loaded', r.loaded100.typing.desktop], ['100 loaded, 4x CPU', r.loaded100.typing.cpu4x], ['1000 loaded', r.loaded1000.typing.desktop], ['1000 loaded, 4x CPU', r.loaded1000.typing.cpu4x], ['skill picker', r.loaded100.skillPicker]]) {
    if (!t.typedOk) over.push(`${where}: the composer did not end up with the typed text`);
    if (t.messageRowsRenderedPerKey > 0) over.push(`${where}: ${t.messageRowsRenderedPerKey} message rows rendered per keystroke (budget 0)`);
  }
  if (r.turn.messageRowsRendered > 4) over.push(`one turn rendered ${r.turn.messageRowsRendered} message rows (budget 4)`);
  // History paging: the page holds a bounded window, the row being read stays put, and Jump to latest gets there.
  const maxRows = windowSize + 10;
  for (const [where, x] of [['reading back', r.readBack], ['reading forward', r.readForward]]) {
    if (x.maxRowsInDom > maxRows) over.push(`${where}: ${x.maxRowsInDom} rows on the page (budget ${maxRows})`);
    if (x.maxDriftPx > 2) over.push(`${where}: the row in view moved ${x.maxDriftPx}px when a page was added (budget 2)`);
    if (x.rowsLost) over.push(`${where}: the row in view was let go ${x.rowsLost} times`);
  }
  if (r.readBack.newestStillInDom) over.push('at the oldest message the newest is still on the page');
  if (r.readForward.oldestStillInDom) over.push('at the newest message the oldest is still on the page');
  if (r.jumpToLatest.liveInDomWhileBack) over.push('a message that arrived while reading back was added to the window');
  if (!r.jumpToLatest.atBottomAfter || !r.jumpToLatest.pillGoneAfter) over.push('Jump to latest did not end at the newest message');
  // Live messages into a full window read above the bottom: bounded, the row read stays, the right end goes.
  const lw = r.liveWindow;
  for (const [where, x] of [['live near the top', lw.nearTop], ['live near the bottom', lw.nearBottom]]) {
    if (x.start.rows !== windowSize || !x.start.reachesNewest) over.push(`${where}: the window started with ${x.start.rows} rows (reaching the newest: ${x.start.reachesNewest}), not ${windowSize} reaching the newest`);
    if (x.maxRowsInDom > windowSize || x.maxMessageViews > windowSize) over.push(`${where}: ${x.maxRowsInDom} rows on the page, ${x.maxMessageViews} in React (budget ${windowSize})`);
    if (x.maxDriftPx > 2) over.push(`${where}: the row in view moved ${x.maxDriftPx}px (budget 2)`);
    if (x.rowLost) over.push(`${where}: the row in view was let go ${x.rowLost} times`);
  }
  if (!lw.nearTop.detachedAfterFirst || !lw.nearTop.loadNewerShown || lw.nearTop.liveShown) over.push(`live near the top: the newest were not let go (Load newer after the first: ${lw.nearTop.detachedAfterFirst}, live shown ${lw.nearTop.liveShown})`);
  if (lw.nearTop.oldestLetGo) over.push('live near the top: the oldest were let go');
  if (!lw.jump.atBottom || !lw.jump.pillGone || !lw.jump.loadNewerGone || !lw.jump.composerFocused || lw.jump.rowsInDom > windowSize) over.push(`Jump to latest after live messages near the top: ${JSON.stringify(lw.jump)}`);
  if (lw.nearBottom.liveShown !== lw.nearBottom.arrivals || lw.nearBottom.loadNewerShown || !lw.nearBottom.oldestLetGo || !lw.nearBottom.loadEarlierShown) over.push(`live near the bottom: ${lw.nearBottom.liveShown}/${lw.nearBottom.arrivals} shown, Load newer ${lw.nearBottom.loadNewerShown}, oldest let go ${lw.nearBottom.oldestLetGo}`);
  if (r.switches.memory.rowsInDom > 25) over.push(`after 50 switches the small chat shows ${r.switches.memory.rowsInDom} rows`);
  return over;
}

