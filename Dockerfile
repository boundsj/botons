# Botons in a container. See docs/DOCKER.md; compose.yaml is the supported way to run it.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev --no-audit --no-fund && rm -rf server/test
# The commit, for /api/health and the startup log (the build context has no .git).
ARG BUILD_SHA=""
RUN if [ -n "$BUILD_SHA" ]; then printf '{ "sha": "%s" }\n' "$BUILD_SHA" > release.json; fi

FROM node:${NODE_VERSION}-bookworm-slim
# tini: signals and zombie reaping. procps (ps), git and tar: the server uses them. bubblewrap and socat: the sandbox
# Claude Code runs Workspace Botons' commands in. chromium and a font: the managed browser (server/src/browser.ts).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini procps git ca-certificates bubblewrap socat chromium fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
# The agent CLIs, from their publishers' npm packages (their own licenses apply). Turn one off with
# INSTALL_CLAUDE=0 or INSTALL_CODEX=0; pin one with CLAUDE_CODE_VERSION or CODEX_VERSION.
ARG INSTALL_CLAUDE=1
ARG INSTALL_CODEX=1
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN set -e; \
  if [ "$INSTALL_CLAUDE" = 1 ]; then npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"; fi; \
  if [ "$INSTALL_CODEX" = 1 ]; then npm install -g --no-audit --no-fund "@openai/codex@$CODEX_VERSION"; fi; \
  npm cache clean --force

# The app is root's and read-only to the server, which runs as `node` (uid 1000).
WORKDIR /app
COPY --from=build /app /app
COPY docker/botons /usr/local/bin/
# The command's deprecated names, as links for one release (shared/legacy-names.mjs).
RUN chmod 755 /usr/local/bin/botons \
  && for n in $(node --input-type=module -e "import { IMAGE_CLI_NAMES } from '/app/shared/legacy-names.mjs'; console.log(IMAGE_CLI_NAMES.join(' '))"); do ln -s botons "/usr/local/bin/$n"; done \
  && mkdir -p /data && chown node:node /data && chmod 700 /data

# The server's own settings (data in /data, every interface, no Tailscale) are docker/botons's defaults, so a setting
# the owner gives in botons.env wins over them.
ENV NODE_ENV=production
USER node
EXPOSE 7777
# Healthy means what /api/health means: database, scheduler and at least one signed-in agent CLI.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.BOTONS_PORT || process.env.PORT || 7777}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["tini", "--", "botons"]
CMD ["serve"]
