import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docsOnly } from '../../scripts/ci-scope.mjs';

test('only documentation and images skip the fast check; code, config and test fixtures never do', () => {
  for (const path of ['README.md', 'CONTRIBUTING.md', 'LICENSE', 'docs/RELEASING.md', 'docs/brand/board/capture.ts',
    'docs/brand/img/cover.png', '.claude/skills/install-botons/SKILL.md', 'web/public/screenshot.webp']) assert.ok(docsOnly(path), path);
  for (const path of ['server/src/api.ts', 'server/test/fixtures/page.png', 'server/test/fixtures/notes.md', 'web/src/App.tsx',
    'shared/types.ts', 'scripts/deploy.ts', 'package.json', 'package-lock.json', '.github/workflows/ci.yml', 'Dockerfile',
    'compose.yaml', 'installer/botons.mjs', 'mise.toml', 'botons.env.example', 'web/index.html']) assert.ok(!docsOnly(path), path);
});
