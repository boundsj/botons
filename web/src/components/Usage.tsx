import { useState } from 'react';
import type { Bot, UsageRow } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { costText, cx, tokens, totalTokens, usageText } from '../util.ts';
import { LoadError, useLoad } from './Load.tsx';

interface Line {
  key: string;
  label: string;
  current?: boolean;
  day: UsageRow | null;
  week: UsageRow | null;
}

function lines(day: UsageRow[], week: UsageRow[], key: (r: UsageRow) => string, label: (r: UsageRow) => string, current?: string): Line[] {
  const byKey = new Map<string, Line>();
  for (const r of week) byKey.set(key(r), { key: key(r), label: label(r), current: key(r) === current, day: null, week: r });
  for (const r of day) {
    const line = byKey.get(key(r)) ?? { key: key(r), label: label(r), current: key(r) === current, day: null, week: null };
    line.day = r;
    byKey.set(key(r), line);
  }
  const weight = (l: Line) => (l.week ? totalTokens(l.week) : 0);
  return [...byKey.values()].sort((a, b) => weight(b) - weight(a));
}

function detail(r: UsageRow | null): string {
  if (!r) return 'No turns';
  const turns = r.turns === 1 ? '1 turn' : `${r.turns} turns`;
  return `${usageText(r)} · ${turns}${r.costUsd ? ` · ${costText(r.costUsd)}` : ''}`;
}

function Cell({ row }: { row: UsageRow | null }) {
  return (
    <td title={detail(row)} className={cx(!row && 'none')}>
      {row ? tokens(totalTokens(row)) : '—'}
    </td>
  );
}

function UsageTable({ caption, first, rows }: { caption: string; first: string; rows: Line[] }) {
  return (
    <table className="usage-table">
      <caption>{caption}</caption>
      {/* Not a <thead>: Chrome keeps an object for every one inserted until the page closes (Markdown.tsx). */}
      <tbody className="head">
        <tr>
          <th scope="col">{first}</th>
          <th scope="col">24 hours</th>
          <th scope="col">7 days</th>
        </tr>
      </tbody>
      <tbody>
        {rows.map((l) => (
          <tr key={l.key} className={cx(l.current && 'current')}>
            <th scope="row">{l.label}</th>
            <Cell row={l.day} />
            <Cell row={l.week} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UsageTab({ bot }: { bot: Bot }) {
  const [data, setData] = useState<{ botId: string; botons: Line[]; routines: Line[] } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const fetchAll = async () => {
    const [botsDay, botsWeek, routinesDay, routinesWeek] = await Promise.all([
      api.usage('24h', 'bot'),
      api.usage('7d', 'bot'),
      api.usage('24h', 'routine', bot.id),
      api.usage('7d', 'routine', bot.id),
    ]);
    setData({
      botId: bot.id,
      botons: lines(botsDay.rows, botsWeek.rows, (r) => r.botId, (r) => r.botName, bot.id),
      routines: lines(
        routinesDay.rows,
        routinesWeek.rows,
        (r) => r.routineId ?? '',
        (r) => (r.routineId ? (r.routineName ?? 'Deleted routine') : 'Chat'),
      ),
    });
  };
  const load = useLoad(fetchAll, bot.id);
  const shown = data?.botId === bot.id ? data : null;

  return (
    <div className="tab-body">
      <div className="tab-intro">
        <p className="muted">
          Tokens your Botons used, as Claude and Codex reported them, cached input included (hover a number for the breakdown). Turns are kept for 90 days.
        </p>
        <button
          className="btn small"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await fetchAll().catch(() => load.retry());
            setRefreshing(false);
          }}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {!shown && (load.error ? <LoadError what="usage" error={load.error} onRetry={load.retry} /> : <p className="muted">Loading…</p>)}
      {shown && (
        <>
          {shown.botons.length ? <UsageTable caption="All Botons" first="Boton" rows={shown.botons} /> : <p className="empty-note">No turns in the last 7 days.</p>}
          {shown.routines.length > 0 && <UsageTable caption={`${bot.name}, by routine`} first="Routine" rows={shown.routines} />}
          <p className="hint">Cost, where shown, is the CLI's estimate at API prices; a subscription isn't billed per turn.</p>
        </>
      )}
    </div>
  );
}
