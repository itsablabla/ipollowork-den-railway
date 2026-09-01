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

## Known gaps

- Not exercised here: a live Railway deploy (needs `RAILWAY_API_TOKEN`) and a desktop sign-in against this Den. Both are the first two steps in README "First run".
- `templateGenerate` copies literal secret values into the template; swap them back to `${{secret(...)}}` in the composer (the provisioning script prints the exact list).
- Upstream's own `packaging/docker/Dockerfile` pins OpenCode 1.17.11 and expects `dist/opencode-plugins` inside the npm package; neither matches `openwork-server@0.18.40`, which is why this worker image builds the plugin bundle from source and pins OpenCode 1.18.18.
