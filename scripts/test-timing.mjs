// Node test reporter: keep ordinary output and emit machine-readable timings.
import { Readable } from 'node:stream';
import { spec } from 'node:test/reporters';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
export default async function* (source) {
  const rows = [];
  const files = [];
  let summary;
  async function* capture() {
    for await (const event of source) {
      // The parent runner's file completion includes module loading and teardown,
      // including files that throw before registering a test.
      if (event.type === 'test:complete' && event.data.file && !event.data.entryFile && resolve(event.data.name) === resolve(event.data.file)) {
        const d = event.data;
        files.push({ file: relative(process.cwd(), d.file), duration_ms: d.details.duration_ms, passed: d.details.passed });
      }
      if (event.type === 'test:summary') {
        const d = event.data;
        if (!d.file) summary = d;
      }
      if (event.type === 'test:pass' || event.type === 'test:fail') {
        const d = event.data;
        rows.push({ name: d.name, file: d.file ? relative(process.cwd(), d.file) : undefined, line: d.line, type: d.details?.type, duration_ms: d.details?.duration_ms, status: event.type });
      }
      yield event;
    }
    const target = process.env.TEST_TIMINGS || 'test-timings.json';
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ node: process.version, summary, files, rows }, null, 2));
    const sorted = rows.filter(r => Number.isFinite(r.duration_ms)).sort((a,b) => b.duration_ms-a.duration_ms);
    process.stderr.write('\nSlowest 30 tests/suites (inclusive):\n' + sorted.slice(0,30).map(r => `${r.duration_ms.toFixed(1)}ms ${r.file}:${r.line} ${r.name}`).join('\n') + '\n');
  }
  yield* Readable.from(capture()).pipe(spec());
}
