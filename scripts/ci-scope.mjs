// Whether the required Node 24 check has code to test: `code=false` only when every file a pull request
// changes is documentation or an image, which neither the typecheck nor `npm test` reads. The job still
// runs and passes then, so the required check is never left pending. Fail closed: any doubt tests.
import { readFileSync, appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Markdown and docs/ outside the code folders, the license, and images outside server/ (its fixtures).
export const docsOnly = (path) => /^(?:docs\/.*|[^/]+\.md|\.claude\/skills\/[^/]+\/[^/]+\.md|LICENSE)$/.test(path)
  || (!path.startsWith('server/') && /\.(?:png|jpe?g|gif|webp)$/i.test(path));

async function changedPaths(event, token) {
  const { number, base } = event.pull_request;
  const paths = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${base.repo.full_name}/pulls/${number}/files?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`Changed files: HTTP ${response.status}`);
    const batch = await response.json();
    paths.push(...batch.flatMap(file => [file.filename, file.previous_filename].filter(Boolean)));
    if (batch.length < 100) break;
    if (page >= 30) throw new Error('Changed-file listing may be truncated');
  }
  if (!paths.length) throw new Error('No changed files listed');
  return paths;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = true;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    try {
      const paths = await changedPaths(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')), process.env.GITHUB_TOKEN);
      code = !paths.every(docsOnly);
      console.log(code ? 'Code changed: running the fast check' : `Docs and images only (${paths.length} paths): nothing for the fast check to run`);
    } catch (error) {
      console.error(`Running the fast check: ${error.message}`);
    }
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`);
}
