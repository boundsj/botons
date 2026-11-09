// Summarize a saved reporter artifact. Durations are inclusive, never summed across suites.
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(process.argv[2] || 'test-timings.json', 'utf8'));
console.log(`Node ${data.node}; suite wall ${(data.summary?.duration_ms / 1000).toFixed(2)}s`);
console.log('\nSlowest 30 files:');
for (const r of [...data.files].sort((a,b) => b.duration_ms-a.duration_ms).slice(0,30)) {
  console.log(`${(r.duration_ms/1000).toFixed(3)}s ${r.file}`);
}
console.log('\nSlowest 30 tests (excluding suite aggregates):');
for (const r of data.rows.filter(r => r.type !== 'suite').sort((a,b) => b.duration_ms-a.duration_ms).slice(0,30)) {
  console.log(`${(r.duration_ms/1000).toFixed(3)}s ${r.file}:${r.line} ${r.name}`);
}
