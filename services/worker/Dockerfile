# Hosted worker: openwork-server (compiled binary from npm) managing an
# internal OpenCode engine, plus the OpenWork OpenCode plugin bundle built from
# source at the matching tag (the npm package does not ship it).
#
# linux/amd64 only: the openwork-server npm package ships a single x86-64 ELF
# binary (Railway builds/runs amd64). arm64 hosts must build from source.
# Verified 2026-09-01: openwork-server 0.18.40 + OpenCode 1.18.18 + plugin
# bundle start, /health returns ok, managed engine listens on 127.0.0.1.
ARG OPENWORK_SERVER_VERSION=0.18.40
ARG OPENCODE_VERSION=1.18.18

# ---------------------------------------------------------------- plugins
FROM oven/bun:1 AS plugins
ARG OPENWORK_SERVER_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "v${OPENWORK_SERVER_VERSION}" --filter=blob:none --sparse https://github.com/different-ai/openwork.git . \
  && git sparse-checkout set --no-cone '/apps/server/src/*' '/packages/types/*' '/constants.json'
# The five plugins import only @openwork/types (workspace) and zod.
RUN mkdir -p node_modules/@openwork \
  && ln -s /src/packages/types node_modules/@openwork/types \
  && cd /tmp && printf '{"name":"plugins-deps","private":true,"type":"module","dependencies":{"zod":"^4.3.6"}}' > package.json \
  && bun install >/dev/null \
  && cp -r /tmp/node_modules/zod /src/node_modules/zod
RUN P=apps/server/src/opencode-plugins \
  && bun build \
    $P/openwork-extensions-preview.ts \
    $P/openwork-capabilities-knowledge.ts \
    $P/openwork-office-attachments.ts \
    $P/openwork-anthropic-adaptive-thinking.ts \
    $P/openwork-anthropic-tool-schema.ts \
    --outdir /opt/openwork/opencode-plugins --target node --format esm \
  && ls -la /opt/openwork/opencode-plugins

# ---------------------------------------------------------------- runtime
FROM node:22-bookworm-slim
ARG OPENWORK_SERVER_VERSION
ARG OPENCODE_VERSION
ARG OPENCODE_DOWNLOAD_URL=

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git tar unzip python3 build-essential ripgrep jq \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "openwork-server@${OPENWORK_SERVER_VERSION}" \
  && chmod +x "$(npm root -g)/openwork-server/dist/bin/openwork-server" \
  && openwork-server --version

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

COPY --from=plugins /opt/openwork/opencode-plugins /opt/openwork/opencode-plugins
COPY entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN chmod +x /usr/local/bin/worker-entrypoint.sh

# Everything persistent lives under the single Railway volume at /data.
ENV OPENWORK_WORKSPACE=/data/workspace \
    OPENWORK_DATA_DIR=/data/openwork \
    OPENWORK_SIDECAR_DIR=/data/sidecars \
    OPENWORK_EXTENSIONS_PLUGIN_DIR=/opt/openwork/opencode-plugins \
    OPENWORK_OPENCODE_BIN=/usr/local/bin/opencode \
    OPENWORK_MANAGE_OPENCODE=1 \
    OPENWORK_PORT=8787 \
    HOME=/data/home \
    XDG_CONFIG_HOME=/data/home/.config \
    XDG_DATA_HOME=/data/home/.local/share \
    XDG_CACHE_HOME=/data/home/.cache \
    XDG_STATE_HOME=/data/home/.local/state

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.OPENWORK_PORT || process.env.PORT || '8787') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/worker-entrypoint.sh"]
