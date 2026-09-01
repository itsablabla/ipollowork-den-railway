# iPolloWork / Openwork Den on Railway

A Railway template for the full **cloud control plane** behind the iPolloWork and Openwork desktop apps: identity, organizations, RBAC, shared skills/plugins/MCP connections, shared LLM providers, scheduled automations, and a hosted agent worker your desktop can open as a "Shared Workspace".

> **Why this is Openwork Den.** iPolloWork is a source-available fork of [Openwork](https://github.com/different-ai/openwork). Its cloud docs point at `ipollowork-ee` charts and `app.ipolloworklabs.com`, neither of which exists. The actual control plane (called **Den**) lives in Openwork's `ee/` directory and ships as public images on GHCR. This template deploys those images. Everything outside `ee/` is MIT; `ee/` is under the Openwork EE License, which allows production use for organizations with **up to 5 users** without a subscription (Enterprise features such as SSO/SCIM, desktop policies, and white-labeling excluded). See [Licensing](#licensing).

## What gets deployed

```
                 ┌─────────────────────────────── Railway project ───────────────────────────────┐
 Desktop app ───►│  den-web  (Next.js, :3005, public)  ──/api/den proxy──►  den-api (Hono, :8788, public)  │
 (iPolloWork /   │      │                                                      │        │              │
  Openwork)      │      └── sign-in, dashboard, worker launch                  │        └──► mysql :3306 (volume) │
                 │                                                             │                                  │
 MCP clients ───►│  den-api /mcp/agent  (OAuth + PKCE)                         └── stub provisioner ──► worker    │
 (Claude Code,   │                                                                                    (:8787,     │
  Codex, Cursor) │  worker = openwork-server + managed OpenCode engine, /data volume                   public)    │
                 └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Service | Source | Port | Volume | Public | Purpose |
|---|---|---|---|---|---|
| `mysql` | `mysql:8.4` | 3306 | `/var/lib/mysql` | no | Den control-plane database (MySQL only; Postgres is not supported) |
| `den-api` | `ghcr.io/different-ai/openwork-den-api:0.18.40` | 8788 | – | yes | Control plane: Better Auth, orgs, members, RBAC, workers, automations, MCP OAuth |
| `den-web` | `ghcr.io/different-ai/openwork-den-web:0.18.40` | 3005 | – | yes | Dashboard + sign-in + the `/api/den/*` proxy the desktop uses |
| `worker` | `ghcr.io/itsablabla/ipollowork-worker:0.18.40` (built from `services/worker` by CI) | 8787 | `/data` | yes | Hosted agent runtime: `openwork-server` 0.18.40 + OpenCode 1.18.18 + the OpenWork plugin bundle built from source, connect from the desktop |
| `inference` (optional) | `ghcr.io/different-ai/openwork-inference:0.18.40` | 8791 | – | no | Metered OpenRouter proxy; needs OpenRouter management key + Stripe |

Versions are pinned in [`versions.json`](versions.json). The worker is the only service built from source because no worker image is published upstream, and the npm package does not ship the OpenCode plugin bundle the server expects, so the Dockerfile builds it from the matching git tag. See [`VALIDATION.md`](VALIDATION.md) for what was exercised.

## Deploy

### Option A: one-click template (after you publish it once)

Deploy URL format: `https://railway.com/deploy/<template-code>`. Publish the template with Option B or C first; the code is printed at the end.

### Option B: scripted via the Railway API (recommended)

Creates the project, all services, variables, volumes, domains, deploys in dependency order, then generates a reusable Railway template from the project.

```bash
export RAILWAY_API_TOKEN=...   # account or workspace token: https://railway.com/account/tokens
node scripts/railway-provision.mjs \
  --template template/railway-template.json \
  --name garza-den \
  --owner-email you@example.com \
  --generate-template
```

Use `template/railway-template.image-only.json` to deploy only the control plane (no worker, no GitHub repo needed). Add `--dry-run` to print the API plan without calling Railway.

The worker image is published to GHCR by `.github/workflows/publish-worker.yml`; the template pulls it as a plain image, so no Railway GitHub integration is required. It is built entirely from the official iPolloWork source (`Devin-AXIS/iPolloWork` tag `v<ipollowork>` in `versions.json`): neither `ipollowork-server` nor the web app is published to npm or a registry. The earlier Openwork-based worker is kept in `services/worker-openwork/` for reference.

### Option C: Railway CLI

```bash
railway login
OWNER_EMAIL=you@example.com ./scripts/railway-cli-deploy.sh
```

The CLI cannot set every setting (start command, root directory), so the script prints the remaining dashboard steps. Then use **Project Settings → Generate Template from Project**.

### Option D: Template Composer by hand

Open [railway.com/workspace/templates](https://railway.com/workspace/templates) → New Template → add the four services exactly as listed in [`template/variables.md`](template/variables.md) (source, start command, healthcheck, volume, variables). Use the `${{secret(...)}}` expressions as-is so each deploy gets fresh secrets.

## Live deployment (2026-09-01)

Provisioned from this repo with `scripts/railway-provision.mjs` into Railway workspace "No AI Allowed":

| Service | URL | Health |
|---|---|---|
| den-web | https://den-web-production.up.railway.app | `/api/health` and `/api/ready` → ok (configuration + upstream) |
| den-api | https://den-api-production.up.railway.app | `/health` → ok 0.18.40; `/.well-known/oauth-protected-resource` advertises `/mcp` |
| worker | https://worker-production-3eb3.up.railway.app | `/health` → ok 0.18.40 / OpenCode 1.18.18 |
| mysql | private (`mysql.railway.internal:3306`) | migrations applied by den-api |

Project: https://railway.com/project/ca86ac98-c940-47a8-be16-ca8e06782fcf. Generated template: code `ixuwbi` → https://railway.com/deploy/ixuwbi (unpublished; see below).

### Finishing the template in the composer

`templateGenerate` keeps `${{...}}` references (service wiring, `RAILWAY_PUBLIC_DOMAIN`, `mysql.MYSQL_URL`) but drops literal defaults and secrets, so the generated template currently asks for every literal variable. Open the template at https://railway.com/workspace/templates and paste the defaults from [`template/variables.md`](template/variables.md); for secrets use the `${{secret(...)}}` expressions listed there. The API snapshot of the generated template is saved at [`template/generated-by-railway.ixuwbi.json`](template/generated-by-railway.ixuwbi.json) for comparison. Publishing is `templatePublish` or the Publish button.

### Lesson baked into the script

Railway resolves `${{other-service.VAR}}` against the services that exist when a variable is written; a reference to a service created later renders as an empty string until the variable is saved again. The provisioner therefore re-applies all cross-service references after every service and domain exists, then deploys in order mysql → den-api → den-web → worker.

## First run

1. Wait for `mysql` → `den-api` → `den-web` → `worker` to go healthy. `den-api`'s start command retries the `den-db` migration until MySQL accepts connections, so a cold template deploy self-heals.
2. Create the first account. Public signup is off, so the first owner is created with the one-time code in den-api's `DEN_INITIAL_ADMIN_BOOTSTRAP_CODE`. The `/setup` page in 0.18.40 fires its status request before it has loaded the API origin and falls back to `api.<web-host>`, which does not exist on Railway domains, so it shows "setup is not available" even when it is. Use the API instead (passwords need upper, lower, digit and a special character):

   ```bash
   API=https://<den-api domain>; WEB=https://<den-web domain>
   GRANT=$(curl -s -X POST "$API/v1/auth/bootstrap/verify" -H 'Content-Type: application/json' -H "Origin: $WEB" \
     -d '{"email":"you@example.com","code":"<DEN_INITIAL_ADMIN_BOOTSTRAP_CODE>"}' | jq -r .grant)
   curl -s -X POST "$API/api/auth/sign-up/email" -H 'Content-Type: application/json' -H "Origin: $WEB" \
     -d "{\"email\":\"you@example.com\",\"name\":\"Your Name\",\"password\":\"<strong password>\",\"bootstrapGrant\":\"$GRANT\"}"
   ```

   Then sign in normally at den-web. (`/setup` works as designed when den-api is reachable at `api.<den-web host>`, e.g. with a custom domain pair.)
3. Desktop app → **Settings → Cloud → Cloud URL** = `https://<den-web domain>` → Sign in → pick the org. The desktop derives API and MCP traffic from that one URL (`<base>/api/den/v1/...`, `<base>/api/den/mcp/...`) and reads `denApiUrl` from `<base>/api/runtime-config`, which this template sets to den-api's public domain.
4. **Browser workbench (the main UI).** Open `https://<worker domain>/` and sign in with the worker's `IPOLLOWORK_WEB_PASSWORD`. This is the official iPolloWork UI (`@ipollowork/app`, built from the pinned tag in web mode) served by the worker: Work / Code / Create / Video, Templates, Schedule, Extensions, Plugin Workshop, Projects, Settings → AI Providers. The login gate (`services/worker/web-gate.mjs`) injects the worker client token after login, so the UI is connected immediately.
5. Desktop app instead: **Add workspace → Connect custom remote**, paste `https://<worker domain>` plus `IPOLLOWORK_TOKEN` (client) or `IPOLLOWORK_HOST_TOKEN` (owner) from the worker's variables.
5. External MCP clients (Claude Code, Codex, Cursor, OpenCode) use `https://<den-api domain>/mcp/agent` with OAuth.

## Configuration notes

- **Public URLs.** `DEN_BASE_URL` (den-web origin) drives Better Auth, CORS, trusted origins, and MCP defaults. `DEN_API_PUBLIC_URL` is set explicitly because Den otherwise derives `api.<web-host>`, which does not exist on Railway domains.
- **API origin.** `DEN_API_BASE` on den-web must be the public den-api origin: in 0.18.40 den-web's `/api/den/*` route answers browsers with a 307 redirect to that origin, so a private `railway.internal` value breaks the setup page and every dashboard call (the docs describe it as server-only; the code disagrees). `DEN_AUTH_FALLBACK_BASE` stays on the private network. den-api listens on all interfaces (Node dual-stack); den-web is started with `--hostname ::`. The worker keeps `--host 0.0.0.0` because `openwork-server` derives its internal engine URL from the bind host and does not handle `::`.
- **Volumes.** Railway allows one volume per service, so the worker keeps workspace, OpenCode state, sidecars, and `$HOME` under `/data`. `RAILWAY_RUN_UID=0` avoids permission issues on the volume.
- **Email.** Invitations and password resets need `RESEND_API_KEY` (plus an `EMAIL_FROM` on a domain verified in Resend) or `SMTP_*`. Verified end to end on the live deployment: a password-reset request produced a delivered "Reset your OpenWork password" email via Resend.
- **Model keys for the worker.** Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OPENROUTER_API_KEY` on the worker, or configure shared LLM providers in Den (`Dashboard → LLM providers`) and let the desktop/worker sync them. For GLM (as in the iPolloWork screenshot), add Z.ai as a custom OpenAI-compatible provider in Den.
- **Per-user sandboxes.** Switch `PROVISIONER_MODE` to `daytona`, set `DAYTONA_API_KEY` and `DAYTONA_SNAPSHOT` (build a snapshot from `services/worker`), and Den will create an isolated sandbox per "Add workspace" instead of using the shared worker.
- **Private MCP servers.** Den blocks private/reserved addresses (SSRF guard). Set `DEN_ALLOW_PRIVATE_MCP_URLS=1` only if your MCP servers are on a network Den can reach and you trust everyone who can add MCP connections.
- **Feature flags.** `DEN_AUTOMATIONS_*=true` enables scheduled automations; `DEN_DASHBOARDS_ENABLED=true` enables the org dashboard; `DEN_OPENWORK_WEB_ENABLED` stays `false` (browser client is an Enterprise feature and needs Stripe).
- **Upgrades.** Bump `den` in `versions.json`, run `python3 scripts/generate-template.py`, redeploy. den-api's start command re-runs migrations on every boot; they are idempotent.
- **Backups.** Enable Railway volume backups on `mysql` and `worker`. Den also stores secrets encrypted with `DEN_DB_ENCRYPTION_KEY`; losing that key makes provider secrets and SSO config unreadable, so keep it in 1Password.

## Local parity

```bash
cp .env.example .env   # fill DEN_OWNER_EMAIL and generate the three secrets
docker compose up -d --build --wait
open http://localhost:3005
```

Same images and variables as the template. CI ([`.github/workflows/validate.yml`](.github/workflows/validate.yml)) builds all five images, boots the stack, and probes `/health`, `/api/health`, and the worker on every push.

## Repository layout

```
template/railway-template.json             full template (serializedConfig) – control plane + worker
template/railway-template.image-only.json  control plane only, pure images
template/variables.md                      generated variable reference
scripts/generate-template.py               single source of truth → the JSON above
scripts/railway-provision.mjs              GraphQL provisioning + templateGenerate
scripts/railway-cli-deploy.sh              Railway CLI alternative
services/<name>/Dockerfile + railway.json  repo-based service definitions (monorepo root directories)
docker-compose.yml, .env.example           local parity stack
versions.json                              pinned versions and template repo
```

## Licensing

- Den images (`ee/`) are under the [Openwork EE License](https://github.com/different-ai/openwork/blob/dev/ee/LICENSE): free in production for up to 5 users (Enterprise features excluded), 30-day evaluation at any size, and each release converts to MIT two years after publication. Team is $20/seat/month up to 100 users; Enterprise is $50/user/month ([pricing](https://github.com/different-ai/openwork/blob/dev/packages/docs/start-here/pricing-and-licensing.mdx)).
- `openwork-server`, OpenCode, and the desktop app are MIT.
- The iPolloWork desktop itself is under the iPolloWork Source Available License 1.0 (free for fewer than 3 users; hosting or customer-facing use needs written authorization). Connecting it to a self-hosted Den is untested; the Openwork desktop is the supported client.
- This template's own files are MIT.

## Sources

Upstream references used to build this template: [Openwork self-host guide](https://github.com/different-ai/openwork/blob/dev/packages/docs/start-here/self-host.mdx), [Helm chart](https://github.com/different-ai/openwork/tree/dev/packaging/helm/openwork-ee), [pull-only evaluation compose](https://github.com/different-ai/openwork/blob/dev/packaging/docker/docker-compose.eval.yml), [den-api `.env.example`](https://github.com/different-ai/openwork/blob/dev/ee/apps/den-api/.env.example), [worker Dockerfile](https://github.com/different-ai/openwork/blob/dev/packaging/docker/Dockerfile), [private network deployment](https://github.com/different-ai/openwork/blob/dev/packages/docs/start-here/private-network-deployment.mdx); Railway [config-as-code](https://docs.railway.com/reference/config-as-code), [template variable functions](https://docs.railway.com/templates/create), [public API](https://docs.railway.com/reference/public-api).
