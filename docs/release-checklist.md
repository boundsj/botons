# First public release

- Review the npm pack file list and final Docker `/app` inventory; keep tests, fixtures, notes, secrets and development tools out of runtime artifacts.
- Run `npm audit --omit=dev`, `npm run test:full` and both required PR checks.
- After the version and license changes merge, fetch origin/main and run `scripts/public-snapshot.sh` with an empty destination. Review its strict privacy check and single neutral commit before publishing. It never pushes.
- After the owner creates the public repository, enable private vulnerability reporting: `gh api -X PUT repos/boundsj/botons/private-vulnerability-reporting`.
- Confirm SECURITY.md links to that repository's private reporting form and test it before announcing the release.
