# Hosted iPolloWork worker built from the OFFICIAL iPolloWork source
# (github.com/Devin-AXIS/iPolloWork) at a pinned release tag:
#
#   * ipollowork-server   — the agent host (apps/server), run with Bun
#   * @ipollowork/app     — the official iPolloWork UI (apps/app) built for the
#                           browser (VITE_IPOLLOWORK_DEPLOYMENT=web) and served
#                           from the same origin as the server
#   * OpenCode engine     — version pinned by the repo's constants.json
#   * web-gate.mjs        — password login in front of the UI (see file)
#
# Neither ipollowork-server nor ipollowork-orchestrator is published to npm,
# so everything is compiled here. linux/amd64 (Railway) is the tested target.
ARG IPOLLOWORK_VERSION=0.50.12
ARG OPENCODE_VERSION=1.18.16

# ---------------------------------------------------------------- build
FROM node:22-bookworm AS build
ARG IPOLLOWORK_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl unzip python3 build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && curl -fsSL https://bun.sh/install | bash
ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:$PATH
WORKDIR /app
RUN git clone --depth 1 --branch "v${IPOLLOWORK_VERSION}" --filter=blob:none --sparse https://github.com/Devin-AXIS/iPolloWork.git . \
  && git sparse-checkout set --no-cone \
       '/package.json' '/pnpm-lock.yaml' '/pnpm-workspace.yaml' '/constants.json' '/tsconfig*.json' '/patches/*' \
       '/packages/types/*' '/packages/ui/*' '/packages/install-config/*' '/packages/design-studio/*' '/packages/video-studio/*' '/packages/docs/*' \
       '/apps/app/*' '/apps/server/*' '/examples/plugin-packages/*' \
  && rm -rf .git
# Only part of the workspace is checked out; pnpm would otherwise reject
# patches that target packages that are not present (upstream uses the same trick).
RUN node -e "const fs = require('node:fs'); fs.appendFileSync('/app/pnpm-workspace.yaml', '\nallowUnusedPatches: true\n')"
RUN pnpm install --frozen-lockfile --trust-lockfile
RUN pnpm --filter @ipollowork/types build \
  && pnpm --filter @ipollowork/ui build \
  && pnpm --filter @ipollowork/install-config build
# Official web build of the iPolloWork UI. In production web mode the app talks
# to `${window.location.origin}` (server API + /opencode proxy), so it must be
# served from the worker's own origin — which web-gate.mjs does.
RUN cd /app/apps/app && VITE_IPOLLOWORK_DEPLOYMENT=web pnpm exec vite build \
  && test -f dist/index.html && test -d dist/assets
# Server: tsc + bundled templates + OpenCode plugin bundle (dist/opencode-plugins).
RUN pnpm --filter ipollowork-server build \
  && test -f /app/apps/server/dist/cli.js \
  && ls /app/apps/server/dist/opencode-plugins \
  && test -f /app/examples/plugin-packages/github/ipollowork.plugin.json
# Drop what the runtime does not need.
RUN rm -rf /app/apps/app/src /app/apps/app/tests /app/apps/server/src/*.test.ts

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim
ARG IPOLLOWORK_VERSION
ARG OPENCODE_VERSION
ARG OPENCODE_DOWNLOAD_URL=

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git tar unzip python3 build-essential ripgrep jq \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash \
  && ln -s /root/.bun/bin/bun /usr/local/bin/bun \
  && bun --version

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) asset="opencode-linux-x64-baseline.tar.gz" ;; \
    arm64) asset="opencode-linux-arm64.tar.gz" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  url="$OPENCODE_DOWNLOAD_URL"; \
  if [ -z "$url" ]; then \
    url="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${asset}"; \
  fi; \
  tmpdir="$(mktemp -d)"; \
  curl -fsSL "$url" -o "$tmpdir/$asset"; \
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"; \
  binary="$(find "$tmpdir" -type f -name opencode | head -n 1)"; \
  test -n "$binary"; \
  install -m 0755 "$binary" /usr/local/bin/opencode; \
  rm -rf "$tmpdir"; \
  opencode --version

COPY --from=build /app /opt/ipollowork
COPY entrypoint.sh /usr/local/bin/worker-entrypoint.sh
COPY web-gate.mjs /opt/ipollowork/web-gate.mjs
RUN chmod +x /usr/local/bin/worker-entrypoint.sh \
  && printf '#!/bin/sh\nexec bun /opt/ipollowork/apps/server/dist/cli.js "$@"\n' > /usr/local/bin/ipollowork-server \
  && chmod +x /usr/local/bin/ipollowork-server \
  && ipollowork-server --version

# Everything persistent lives under the single Railway volume at /data.
ENV IPOLLOWORK_VERSION=${IPOLLOWORK_VERSION} \
    IPOLLOWORK_WORKSPACE=/data/workspace \
    IPOLLOWORK_DATA_DIR=/data/ipollowork \
    IPOLLOWORK_SIDECAR_DIR=/data/sidecars \
    IPOLLOWORK_OPENCODE_BIN=/usr/local/bin/opencode \
    IPOLLOWORK_MANAGE_OPENCODE=1 \
    IPOLLOWORK_PORT=8787 \
    IPOLLOWORK_WEB_ROOT=/opt/ipollowork/apps/app/dist \
    IPOLLOWORK_BUNDLED_PLUGIN_PACKAGES_DIR=/opt/ipollowork/examples/plugin-packages \
    HOME=/data/home \
    TMPDIR=/data/tmp \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_DATA_HOME=/data/home/.local/share \
    XDG_CACHE_HOME=/data/home/.cache \
    XDG_STATE_HOME=/data/home/.local/state

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || process.env.IPOLLOWORK_PORT || '8787') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/worker-entrypoint.sh"]
