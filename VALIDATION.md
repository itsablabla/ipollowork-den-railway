# Validation log

What was verified while building this template (2026-09-01), and what CI verifies on every push.

## Verified in the build sandbox (no Docker available there)

| Check | Result |
|---|---|
| `ghcr.io/different-ai/openwork-den-api:0.18.40` manifest | multi-arch (amd64/arm64); `ENTRYPOINT docker-entrypoint.sh`, `CMD node /app/ee/apps/den-api/dist/main.js`, `PORT=8788`, healthcheck `/health` |
| `ghcr.io/different-ai/openwork-den-web:0.18.40` manifest | `CMD next start --hostname 0.0.0.0 --port ${PORT:-3005}` (template overrides to `::`), healthcheck `/api/health` |
| `ghcr.io/different-ai/openwork-inference:0.18.40` manifest | `PORT=8791`, healthcheck `/health` |
| `openwork-server@0.18.40` from npm | Linux x64 compiled binary; `--version` = 0.18.40; flags `--host --port --cors --approval --workspace --token --host-token` confirmed |
| OpenCode `v1.18.18` release assets | x64-baseline and arm64 tarballs return HTTP 200; matches `constants.json` `opencodeVersion` at tag v0.18.40 |
| OpenCode plugin bundle | Built from tag `v0.18.40` with Bun (`bun build … --target node --format esm`): 5 files, all `node --check` clean and importable (exports `OpenWorkExtensionsPreview`, `OpenWorkCapabilitiesKnowledge`, `OpenWorkOfficeAttachments`, `OpenWorkAnthropicAdaptiveThinking`, `OpenWorkAnthropicToolSchema`) |
| Worker runtime (`services/worker/entrypoint.sh` + real binaries) | `GET /health` → `{"ok":true,"version":"0.18.40",...}`; `GET /status` without token → 401; `GET /workspaces` with `OPENWORK_TOKEN` → workspace listed; managed OpenCode engine listening on 127.0.0.1; JSON logs; `/data/{workspace,openwork,sidecars,home}` created |
| `services/*/railway.json` | Valid against `https://railway.com/railway.schema.json` |
| Railway GraphQL calls in `scripts/railway-provision.mjs` | Every mutation and input field checked against live schema introspection: `projectCreate`, `serviceCreate(source.image/repo)`, `serviceInstanceUpdate(startCommand, healthcheckPath, healthcheckTimeout, restartPolicyType, restartPolicyMaxRetries, rootDirectory)`, `volumeCreate(mountPath)`, `serviceDomainCreate(targetPort)`, `serviceInstanceDeployV2`, `templateGenerate(projectId, environmentId)` → `Template{id, code}` |
| Template JSON shape | Mirrors `serializedConfig` returned by Railway for published templates (`mysql`, `n8n-with-workers`): `services{uuid}.{name,icon,build,source,deploy,variables,networking,volumeMounts}` |
| Deploy URL format | `https://railway.com/deploy/<code>` (old `/template/<code>` 301s to it) |
| Shell + Node syntax | `sh -n`, `bash -n`, `node --check`, provisioning dry run |
| `docker-compose.yml` | Parses; 4 services |

## Verified by CI (`.github/workflows/validate.yml`)

- Builds all five images (`mysql`, `den-api`, `den-web`, `worker`, `inference`).
- Boots the full compose stack and probes `den-api /health`, `den-web /api/health`, `worker /health`.
- Re-generates `template/*.json` and fails if the committed files are stale.
- Validates `railway.json` files, shellcheck, provisioning dry run, `docker compose config`.

## Live deployment checks (Railway, 2026-09-01)

- All four services healthy; `den-web /api/ready` reports configuration + upstream ok; `den-api /.well-known/oauth-protected-resource` correct.
- First owner created via `/v1/auth/bootstrap/verify` + `/api/auth/sign-up/email` with `bootstrapGrant`; `/v1/me/orgs` returns org "Garza", role `owner`, limits `{members: 5, workers: 1}`; bootstrap status flipped to `complete`.
- Two upstream behaviours discovered and documented in the README: `/api/den/*` on den-web is a 307 redirect to `DEN_API_BASE` (so it must be the public origin), and the `/setup` page races runtime-config and needs `api.<web-host>` unless the API is called directly.

## Official iPolloWork worker + browser UI (2026-09-01)

- Image `ghcr.io/itsablabla/ipollowork-worker:0.50.12` built from `Devin-AXIS/iPolloWork@v0.50.12`: `ipollowork-server` (Bun, `dist/cli.js`), OpenCode 1.18.16 (repo `constants.json`), plugin bundle, and `@ipollowork/app` web build. CI `validate` (compose stack boot + worker smoke) green.
- Live on Railway: `/health` → `{"ok":true,"version":"0.50.12","opencodeVersion":"1.18.16"}`; `/` shows the password gate; after login the official UI loads (Work/Code/Create/Video, Templates, Schedule, Extensions, Plugin Workshop, Projects, Settings → AI Providers with 20+ providers incl. Zhipu AI/GLM); sending "hello" produced a model reply via the built-in provider.
- Gate behaviour unit-checked locally: public `/health`, 401 for API without cookie/bearer, bearer passthrough, wrong password → 401, correct password → cookie + redirect, SPA deep links → index.html, assets served, cookie stripped before proxying.
- Fixed after first user session (all re-verified in a browser): `/workspace/*` reload returned the API's `not_found` (gate routing); "Unexpected server error" toast (template install `rename()` from `/tmp` to the volume → EXDEV; `TMPDIR` now on `/data`); "Bundled plugin package is unavailable" (official `examples/plugin-packages` now shipped, `IPOLLOWORK_BUNDLED_PLUGIN_PACKAGES_DIR`); "Invalid host token" in Authorizations/Environment (gate mints a persistent owner-scoped token for the UI and forwards the host token for cookie-authenticated requests). Templates Explore, Extensions (12 plugin packages, 3 installed by default), Authorizations and Environment all load.
- Remaining cosmetic: the "Update check failed — Electron update checks are available only in the Electron desktop app" toast in Settings is inherent to the browser build.

## Deep audit (2026-09-01, evening)

Logs of all four services reviewed after the last restart: no 5xx, no unhandled errors; only expected notices (MySQL self-signed CA, Better Auth OAuth metadata warning — the metadata URL does return 200). Den probes all green (`/api/ready` configuration+upstream ok, MCP OAuth well-known, bootstrap `complete`). Worker: 4/4 MCP servers connected, providers `opencode`/`zai`/`packy`, event streams (SSE) flow through the gate, `/workspace/:id/events` is a 3–4 s poll by design.

Authentication verified end to end: Den sign-in via den-web proxy + session cookie, wrong password 401, public signup 403, bootstrap code dead after first owner (409), CORS rejects foreign origins. Worker: unauthenticated API 401 / page → login, bad bearer 401, client token = `collaborator`, minted web token = `owner`, host-token routes reachable only from password-authenticated browser sessions, cookie `HttpOnly; Secure; SameSite=Lax`. Approval mode set to `auto` (the official desktop's setting; `manual` has no UI and made writes time out after 30 s).

Fixed during the audit (all re-verified in a browser):
- Gate routing now follows the server route table: API URLs opened as a browser navigation (e.g. `files/raw`, artifacts) are proxied instead of receiving the app shell; unit checks in CI.
- Cookie `Secure` flag only over https (local docker-compose logins would otherwise loop).
- Fresh browsers start on the engine's configured default model (upstream hardcodes `opencode/big-pickle` and ignores `model` in config).
- "New project" button is Electron-only upstream; now shown in the browser, with a server-side folder fallback. Create + remove verified.
- Project board default column labels were Chinese on the English Overview tab; English defaults patched into `@ipollowork/types` at build time.

Known, not changed: `/status` exposes the loopback OpenCode engine's basic-auth credentials to any valid client token (upstream; the engine is not reachable from outside); the "Installed" plugin row shows icons only (upstream design); `DEN_INITIAL_ADMIN_BOOTSTRAP_CODE` can be removed from den-api now that setup is complete.

## Known gaps

- `openwork-server@0.18.40` on npm is an x86-64 Linux binary only; the worker image is published for `linux/amd64` (an arm64 build attempt fails with "Missing runtime dependency").

- Not exercised here: a live Railway deploy (needs `RAILWAY_API_TOKEN`) and a desktop sign-in against this Den. Both are the first two steps in README "First run".
- `templateGenerate` copies literal secret values into the template; swap them back to `${{secret(...)}}` in the composer (the provisioning script prints the exact list).
- Upstream's own `packaging/docker/Dockerfile` pins OpenCode 1.17.11 and expects `dist/opencode-plugins` inside the npm package; neither matches `openwork-server@0.18.40`, which is why this worker image builds the plugin bundle from source and pins OpenCode 1.18.18.
