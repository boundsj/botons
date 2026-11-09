// The chat perf harness's render counters (the script it injects into the page) and its --budget, without Chrome:
// the counters run on fiber trees shaped the way React commits them, and the budget refuses results in which
// they found no message rows, as happens when the web app is minified.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { overBudget, PAGE_HOOK } from '../../scripts/perf-chat-budget.ts';

// React's fiber tags and its PerformedWork flag, as the hook reads them.
const FunctionComponent = 0;
const HostComponent = 5;
const MemoComponent = 14;
const SimpleMemoComponent = 15;
const PerformedWork = 1;

type Fiber = { tag: number; type: unknown; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null };
const fiber = (tag: number, type: unknown, children: Fiber[] = [], alternate: Fiber | null = null, flags = 0): Fiber => {
  const f: Fiber = { tag, type, flags, alternate, child: children[0] ?? null, sibling: null };
  children.forEach((c, i) => (c.sibling = children[i + 1] ?? null));
  return f;
};
const named = (name: string) => Object.defineProperty(function () {}, 'name', { value: name });

/** The injected script in a context with what it touches of a page; returns its __perf and the DevTools hook. */
function page() {
  const window: any = {
    addEventListener() {},
    requestAnimationFrame() {},
    MessageChannel: class {},
    PerformanceObserver: class {
      observe() {}
    },
    performance: { now: () => 0 },
  };
  window.window = window;
  runInNewContext(PAGE_HOOK, window);
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  hook.inject({});
  return { perf: window.__perf, commit: (current: Fiber) => hook.onCommitFiberRoot(1, { current }) };
}

/**
 * A chat as React commits it: an App over a list of message rows. The row's component is `memo(function MessageView)`
 * in the app; `rowName` is what a build leaves of its name (a minifier renames it).
 */
function chat(rowName: string, rows: number) {
  const Row = named(rowName);
  const memoRow = { $$typeof: Symbol.for('react.memo'), type: Row };
  const Composer = named('Composer');
  const App = named('App');
  // A simple memo fiber holds the function itself, a memo fiber the memo object.
  // First mount: nothing has an alternate, so every component counts as rendered.
  const mountRows = Array.from({ length: rows }, () => fiber(SimpleMemoComponent, Row));
  const list = fiber(HostComponent, 'div', mountRows);
  const composer = fiber(FunctionComponent, Composer);
  const app = fiber(FunctionComponent, App, [list, composer]);
  const mount = fiber(3, null, [app]);
  // A keystroke: App and Composer render again, the list bails out (its child is the one already committed).
  const list2 = fiber(HostComponent, 'div', [], list);
  list2.child = list.child;
  const composer2 = fiber(FunctionComponent, Composer, [], composer, PerformedWork);
  const app2 = fiber(FunctionComponent, App, [list2, composer2], app, PerformedWork);
  const keystroke = fiber(3, null, [app2], mount);
  // A turn: two new rows mount after the ones already there, which bail out.
  const kept = mountRows.map((r) => fiber(SimpleMemoComponent, Row, [], r));
  const added = [fiber(SimpleMemoComponent, Row), fiber(MemoComponent, memoRow)];
  const list3 = fiber(HostComponent, 'div', [...kept, ...added], list2, PerformedWork);
  const app3 = fiber(FunctionComponent, App, [list3, fiber(FunctionComponent, Composer, [], composer2)], app2, PerformedWork);
  const turn = fiber(3, null, [app3], keystroke);
  return { mount, keystroke, turn };
}

/** Results the way perf-chat records them, from what the counters returned, the DOM checks all within budget. */
function results(open: { commits: number; rows: number }, perKey: number, turn: { commits: number; messageRowsRendered: number }, mounted: number, windowSize: number) {
  const typing = { typedOk: true, messageRowsRenderedPerKey: perKey };
  const live = (extra: object) => ({ start: { rows: windowSize, mounted, reachesNewest: true }, arrivals: 30, maxRowsInDom: windowSize, maxMessageViews: mounted, maxDriftPx: 0, rowLost: 0, ...extra });
  return {
    open: { firstRenders: open },
    loaded100: { typing: { desktop: typing, cpu4x: typing }, skillPicker: typing },
    loaded1000: { typing: { desktop: typing, cpu4x: typing } },
    turn: { ...turn, markdownRendered: 1 },
    readBack: { maxRowsInDom: windowSize, maxDriftPx: 0, rowsLost: 0, newestStillInDom: false },
    readForward: { maxRowsInDom: windowSize, maxDriftPx: 0, rowsLost: 0, oldestStillInDom: false },
    jumpToLatest: { liveInDomWhileBack: false, atBottomAfter: true, pillGoneAfter: true },
    liveWindow: {
      window: windowSize,
      nearTop: live({ liveShown: 0, detachedAfterFirst: true, loadNewerShown: true, oldestLetGo: false }),
      jump: { atBottom: true, pillGone: true, loadNewerGone: true, composerFocused: true, rowsInDom: windowSize, messageViews: mounted },
      nearBottom: live({ liveShown: 30, loadNewerShown: false, oldestLetGo: true, loadEarlierShown: true }),
    },
    switches: { memory: { rowsInDom: 20 } },
  };
}

/** Drive the counters through a mount, a keystroke and a turn, the way the harness reads them. */
function measure(rowName: string, rows: number) {
  const { perf, commit } = page();
  const c = chat(rowName, rows);
  commit(c.mount);
  const open = { commits: perf.commits, rows: perf.renders.MessageView || 0 };
  const mountedAfterOpen = perf.mounted('MessageView');
  perf.reset();
  commit(c.keystroke);
  const perKey = perf.renders.MessageView ?? 0;
  const otherRendersPerKey = { ...perf.renders };
  perf.reset();
  commit(c.turn);
  const turn = { commits: perf.commits, messageRowsRendered: perf.renders.MessageView || 0 };
  return { open, mountedAfterOpen, perKey, otherRendersPerKey, turn, mounted: perf.mounted('MessageView') };
}

test('the counters count the rows a commit rendered, by component name, and the rows React holds', () => {
  const m = measure('MessageView', 6);
  assert.deepEqual(m.open, { commits: 1, rows: 6 });
  assert.equal(m.mountedAfterOpen, 6);
  assert.equal(m.perKey, 0, 'a keystroke renders no message row');
  assert.deepEqual(m.otherRendersPerKey, { App: 1, Composer: 1 }, 'only what performed work counts, and the bailed-out list is not walked');
  assert.deepEqual(m.turn, { commits: 1, messageRowsRendered: 2 }, 'a turn counts its two new rows, not the kept ones');
  assert.equal(m.mounted, 8);
});

test('the budget passes what the counters measure on a build that keeps component names', () => {
  const m = measure('MessageView', 6);
  assert.deepEqual(overBudget(results(m.open, m.perKey, m.turn, m.mounted, 8), 8), []);
});

test('the budget fails closed when the counters found no message rows, as in a minified build', () => {
  const m = measure('a', 6);
  assert.deepEqual(m.open, { commits: 1, rows: 0 });
  assert.equal(m.mounted, 0);
  // Everything a minified run records is "within" the upper bounds; the budget must still refuse it.
  const over = overBudget(results(m.open, m.perKey, m.turn, m.mounted, 8), 8);
  assert.match(over[0], /render counters saw no message rows/);
  assert.match(over.join('\n'), /opening the chat counted 0 message rows/);
  assert.match(over.join('\n'), /a turn counted 1 commits and 0 message rows/);
  assert.match(over.join('\n'), /live near the top: 8 rows on the page but 0 message rows found/);
  assert.match(over.join('\n'), /live near the bottom: 8 rows on the page but 0 message rows found/);
});

test('each missing count fails the budget on its own, and so does a result that lacks it', () => {
  const m = measure('MessageView', 6);
  const good = () => results(m.open, m.perKey, m.turn, m.mounted, 8) as any;
  const cases: [string, (r: any) => void, RegExp][] = [
    ['no commits on open', (r) => (r.open.firstRenders.commits = 0), /opening the chat counted 0 React commits/],
    ['no rows on open', (r) => (r.open.firstRenders.rows = 0), /opening the chat counted 0 message rows/],
    ['no rows in a turn', (r) => (r.turn.messageRowsRendered = 0), /a turn counted 1 commits and 0 message rows/],
    ['no commits in a turn', (r) => (r.turn.commits = 0), /a turn counted 0 commits/],
    ['none mounted near the top', (r) => (r.liveWindow.nearTop.start.mounted = 0), /live near the top: .* 0 message rows found/],
    ['none held near the bottom', (r) => (r.liveWindow.nearBottom.maxMessageViews = 0), /live near the bottom/],
    ['no open result', (r) => delete r.open, /opening the chat counted no React commits/],
    ['no turn result', (r) => delete r.turn, /a turn counted no commits/],
  ];
  for (const [what, spoil, expected] of cases) {
    const r = good();
    spoil(r);
    const over = overBudget(r, 8);
    assert.match(over[0] ?? '', /render counters saw no message rows/, what);
    assert.match(over.join('\n'), expected, what);
  }
});

test('with the counters working, the DOM budgets still apply', () => {
  const m = measure('MessageView', 6);
  const r = results(m.open, m.perKey, m.turn, m.mounted, 8) as any;
  r.liveWindow.nearTop.maxDriftPx = 5;
  r.jumpToLatest.atBottomAfter = false;
  r.turn.messageRowsRendered = 9;
  r.loaded1000.typing.desktop = { typedOk: true, messageRowsRenderedPerKey: 3 };
  assert.deepEqual(overBudget(r, 8), [
    '1000 loaded: 3 message rows rendered per keystroke (budget 0)',
    'one turn rendered 9 message rows (budget 4)',
    'Jump to latest did not end at the newest message',
    'live near the top: the row in view moved 5px (budget 2)',
  ]);
});
