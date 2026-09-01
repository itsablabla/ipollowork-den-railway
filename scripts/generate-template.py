#!/usr/bin/env python3
"""Generate Railway template definitions (serializedConfig format) for the
iPolloWork / Openwork Den control plane.

Outputs:
  template/railway-template.json             control plane + hosted worker (4 services)
  template/railway-template.image-only.json  control plane only, pure GHCR images (3 services)
  template/variables.md                      human-readable variable reference

The JSON shape mirrors what Railway returns from `template { serializedConfig }`
for published templates (services keyed by UUID, each with source / deploy /
variables / networking / volumeMounts).
"""
from __future__ import annotations

import json
import pathlib
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
VERSIONS = json.loads((ROOT / "versions.json").read_text())

DEN_VERSION = VERSIONS["den"]
REPO = VERSIONS["template_repo"]          # e.g. github.com/<owner>/ipollowork-den-railway
REPO_BRANCH = VERSIONS["template_branch"]

ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
HEX = "abcdef0123456789"


def secret(length: int, alphabet: str = ALNUM) -> str:
    return f'${{{{secret({length}, "{alphabet}")}}}}'


def var(default: str, description: str, optional: bool = False) -> dict:
    return {"defaultValue": default, "description": description, "isOptional": optional}


NAMESPACE = uuid.UUID("6f1c2f3e-9b1a-4c5d-8e7f-0a1b2c3d4e5f")


def sid(name: str) -> str:
    """Deterministic service/volume ids so regeneration is reproducible."""
    return str(uuid.uuid5(NAMESPACE, name))


# ---------------------------------------------------------------------------
# Service: mysql
# ---------------------------------------------------------------------------
def mysql_service() -> dict:
    return {
        "name": "mysql",
        "icon": "https://devicons.railway.app/i/mysql.svg",
        "build": {},
        "source": {"image": f"mysql:{VERSIONS['mysql']}"},
        "deploy": {
            # Same tuning Railway's own MySQL template uses, smaller buffer pool.
            "startCommand": (
                "docker-entrypoint.sh mysqld --innodb-use-native-aio=0 "
                "--disable-log-bin --performance_schema=0 --innodb-buffer-pool-size=256M"
            ),
            "healthcheckPath": None,
            "requiredMountPath": "/var/lib/mysql",
        },
        "variables": {
            "MYSQL_ROOT_PASSWORD": var(secret(32), "Root password for the Den control-plane database."),
            "MYSQL_DATABASE": var("openwork_den", "Database created on first start; Den migrations run here."),
            "MYSQLHOST": var("${{RAILWAY_PRIVATE_DOMAIN}}", "Private DNS name other services use."),
            "MYSQLPORT": var("3306", "MySQL port."),
            "MYSQLUSER": var("root", "MySQL user."),
            "MYSQL_URL": var(
                "mysql://${{MYSQLUSER}}:${{MYSQL_ROOT_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:3306/${{MYSQL_DATABASE}}",
                "Private connection string consumed by den-api.",
            ),
        },
        "networking": {"tcpProxies": {}, "serviceDomains": {}},
        "volumeMounts": {sid("mysql-volume"): {"mountPath": "/var/lib/mysql"}},
    }


# ---------------------------------------------------------------------------
# Service: den-api
# ---------------------------------------------------------------------------
DEN_API_START = (
    "/bin/sh -c \"cd /app/ee/packages/den-db && n=0; "
    "until node ./dist/scripts/bootstrap.js || node --import tsx ./dist/scripts/bootstrap.js; do "
    "n=$((n+1)); if [ $n -ge 60 ]; then echo 'den-db bootstrap failed after 60 attempts' >&2; exit 1; fi; "
    "echo 'waiting for mysql / retrying den-db bootstrap'; sleep 3; done; "
    "cd /app && exec docker-entrypoint.sh node /app/ee/apps/den-api/dist/main.js\""
)


def den_api_service(with_worker: bool) -> dict:
    web = "https://${{den-web.RAILWAY_PUBLIC_DOMAIN}}"
    api = "https://${{RAILWAY_PUBLIC_DOMAIN}}"
    variables = {
        # runtime
        "PORT": var("8788", "Den API listen port (Railway routes to it)."),
        "NODE_ENV": var("production", "Node environment."),
        "CI": var("true", "Matches the Helm chart defaults."),
        "OPENWORK_DEV_MODE": var("0", "Never enable in a hosted deployment."),
        "DB_MODE": var("mysql", "Den supports MySQL only."),
        # database + secrets
        "DATABASE_URL": var("${{mysql.MYSQL_URL}}", "Private MySQL URL from the mysql service."),
        "BETTER_AUTH_SECRET": var(secret(64), "Better Auth signing secret (32+ chars)."),
        "DEN_DB_ENCRYPTION_KEY": var(secret(64), "AES-256-GCM key for encrypted columns (32+ chars)."),
        # public URLs
        "DEN_BASE_URL": var(web, "Public Den web origin; Den derives auth/CORS/MCP defaults from it."),
        "BETTER_AUTH_URL": var(web, "Better Auth base URL (browser-facing)."),
        "DEN_API_PUBLIC_URL": var(api, "Public Den API origin (used by external MCP clients and install links)."),
        "DEN_MCP_RESOURCE_URL": var(api + "/mcp", "MCP protected-resource URL advertised to MCP clients."),
        "DEN_MCP_CLAIM_NAMESPACE": var(web, "Stable namespace for MCP token claims."),
        "CORS_ORIGINS": var(web + "," + api, "Allowed browser origins."),
        "DEN_BETTER_AUTH_TRUSTED_ORIGINS": var(web + "," + api, "Trusted origins for Better Auth."),
        # tenancy
        "DEN_ORG_MODE": var("single_org", "single_org for a private deployment; multi_org for hosted-style."),
        "DEN_SINGLE_ORG_NAME": var("Garza", "Organization display name."),
        "DEN_SINGLE_ORG_SLUG": var("default", "Organization slug."),
        "DEN_SINGLE_ORG_OWNER_EMAILS": var("", "Comma-separated emails allowed to claim ownership. REQUIRED: set to your email."),
        "DEN_BOOTSTRAP_ADMIN_EMAILS": var("${{DEN_SINGLE_ORG_OWNER_EMAILS}}", "Platform admins seeded on startup."),
        "DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP": var("false", "Keep false; owners invite members."),
        "DEN_REQUIRE_EMAIL_VERIFICATION": var("false", "Single-org installs skip verification codes by default."),
        "DEN_PASSWORD_BREACH_SCREENING_ENABLED": var("true", "Railway has egress, so keep HIBP screening on."),
        "DEN_INITIAL_ADMIN_BOOTSTRAP_CODE": var(
            secret(16, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"),
            "One-time setup code. With public signup off, the owner creates the first account at <den-web>/setup using this code. Read it from the den-api variables after deploy.",
        ),
        "DEN_INSTALL_LINKS_GATING_ENABLED": var("false", "Every org gets desktop install links."),
        # features
        "DEN_AUTOMATIONS_ENABLED": var("true", "Scheduled automations available to desktops."),
        "DEN_AUTOMATIONS_RUNTIME_ENABLED": var("true", "Scheduler runs inside den-api."),
        "DEN_DASHBOARDS_ENABLED": var("true", "Org dashboard."),
        "DEN_OPENWORK_WEB_ENABLED": var("false", "Browser client is an Enterprise feature; leave false unless licensed."),
        "DEN_ALLOW_PRIVATE_MCP_URLS": var("0", "Set 1 only if your MCP servers live on private addresses you trust."),
        "DEN_DESKTOP_RELEASES_MODE": var("github", "Desktop release discovery."),
        # workers
        "PROVISIONER_MODE": var("stub", "stub | daytona | render. stub = you run workers (this template ships one)."),
        "WORKER_PROVISIONING_RECONCILE_INTERVAL_MS": var("60000", "Reconcile loop interval."),
        "WORKER_PROVISIONING_RECONCILE_STALE_MS": var("1200000", "Stale worker threshold."),
        "WORKER_PROVISIONING_RECONCILE_BATCH_SIZE": var("10", "Reconcile batch size."),
        # email (optional)
        "EMAIL_FROM": var("Garza Den <no-reply@example.com>", "From header for invites.", optional=True),
        "RESEND_API_KEY": var("", "Resend API key for transactional email (or use SMTP_* instead).", optional=True),
        "SMTP_HOST": var("", "SMTP host (alternative to Resend).", optional=True),
        "SMTP_PORT": var("587", "SMTP port.", optional=True),
        "SMTP_USER": var("", "SMTP user.", optional=True),
        "SMTP_PASS": var("", "SMTP password.", optional=True),
        "SMTP_SECURE": var("false", "SMTP TLS on connect.", optional=True),
        # optional integrations
        "DATABASE_REDIS_URL": var("", "Optional rediss:// URL for session/query cache.", optional=True),
        "DAYTONA_API_KEY": var("", "Set with PROVISIONER_MODE=daytona for per-user sandboxes.", optional=True),
        "DAYTONA_API_URL": var("https://app.daytona.io/api", "Daytona API URL.", optional=True),
        "DAYTONA_SNAPSHOT": var("", "Daytona snapshot name built from services/worker.", optional=True),
        "DEN_OBSERVABILITY_BACKEND": var("none", "none | otel | sentry.", optional=True),
        "OTEL_EXPORTER_OTLP_ENDPOINT": var("", "OTLP HTTP endpoint when backend=otel.", optional=True),
    }
    if with_worker:
        variables["WORKER_URL_TEMPLATE"] = var(
            "https://${{worker.RAILWAY_PUBLIC_DOMAIN}}",
            "Stub provisioner hands this URL to the desktop for 'Shared Workspace'.",
        )
    else:
        variables["WORKER_URL_TEMPLATE"] = var(
            "https://workers.local/{workerId}",
            "Placeholder until you add a worker service.",
        )
    return {
        "name": "den-api",
        "icon": "https://devicons.railway.app/i/nodejs.svg",
        "build": {},
        "source": {"image": f"ghcr.io/different-ai/openwork-den-api:{DEN_VERSION}"},
        "deploy": {
            "startCommand": DEN_API_START,
            "healthcheckPath": "/health",
            "healthcheckTimeout": 600,
            "restartPolicyType": "ON_FAILURE",
            "restartPolicyMaxRetries": 10,
        },
        "variables": variables,
        "networking": {"tcpProxies": {}, "serviceDomains": {"<hasDomain>": {}}},
        "volumeMounts": {},
    }


# ---------------------------------------------------------------------------
# Service: den-web
# ---------------------------------------------------------------------------
DEN_WEB_START = (
    "/bin/sh -c \"exec /app/ee/apps/den-web/node_modules/.bin/next start --hostname :: --port ${PORT:-3005}\""
)


def den_web_service() -> dict:
    me = "https://${{RAILWAY_PUBLIC_DOMAIN}}"
    return {
        "name": "den-web",
        "icon": "https://devicons.railway.app/i/nextjs.svg",
        "build": {},
        "source": {"image": f"ghcr.io/different-ai/openwork-den-web:{DEN_VERSION}"},
        "deploy": {
            "startCommand": DEN_WEB_START,
            "healthcheckPath": "/api/health",
            "healthcheckTimeout": 300,
            "restartPolicyType": "ON_FAILURE",
            "restartPolicyMaxRetries": 10,
        },
        "variables": {
            "PORT": var("3005", "Den web listen port."),
            "NODE_ENV": var("production", "Node environment."),
            "DEN_BASE_URL": var(me, "This service's public origin."),
            "DEN_WEB_PUBLIC_ORIGIN": var(me, "Public origin advertised to browsers/desktops."),
            "DEN_AUTH_ORIGIN": var(me, "Origin used for auth redirects."),
            "DEN_WEB_OPENWORK_AUTH_CALLBACK_URL": var(me, "Desktop sign-in callback base."),
            "DEN_API_BASE": var(
                "https://${{den-api.RAILWAY_PUBLIC_DOMAIN}}",
                "Den API origin. Must be browser-reachable: den-web's /api/den/* route 307-redirects browsers to this origin (verified on 0.18.40).",
            ),
            "DEN_AUTH_FALLBACK_BASE": var(
                "http://${{den-api.RAILWAY_PRIVATE_DOMAIN}}:8788",
                "Container-internal fallback for server-side auth calls.",
            ),
            "DEN_API_PUBLIC_URL": var(
                "https://${{den-api.RAILWAY_PUBLIC_DOMAIN}}",
                "Browser-reachable Den API origin returned by /api/runtime-config.",
            ),
            "DEN_ORG_MODE": var("${{den-api.DEN_ORG_MODE}}", "Mirror of den-api."),
            "DEN_SINGLE_ORG_NAME": var("${{den-api.DEN_SINGLE_ORG_NAME}}", "Mirror of den-api."),
            "DEN_SINGLE_ORG_SLUG": var("${{den-api.DEN_SINGLE_ORG_SLUG}}", "Mirror of den-api."),
            "DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP": var(
                "${{den-api.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP}}", "Mirror of den-api."
            ),
            "NEXT_PUBLIC_DEN_OBSERVABILITY_BACKEND": var("none", "Browser telemetry backend.", optional=True),
        },
        "networking": {"tcpProxies": {}, "serviceDomains": {"<hasDomain>": {}}},
        "volumeMounts": {},
    }


# ---------------------------------------------------------------------------
# Service: worker — official iPolloWork server + official web UI (from source)
# ---------------------------------------------------------------------------
def worker_service() -> dict:
    return {
        "name": "worker",
        "icon": "https://devicons.railway.app/i/docker.svg",
        "build": {},
        # Published by .github/workflows/publish-worker.yml. Building from the repo
        # instead: {"repo": f"https://github.com/{REPO}/tree/{REPO_BRANCH}", "rootDirectory": "services/worker"}
        "source": {"image": f"{VERSIONS['worker_image']}:{VERSIONS['ipollowork']}"},
        "deploy": {
            "healthcheckPath": "/health",
            "healthcheckTimeout": 600,
            "restartPolicyType": "ON_FAILURE",
            "restartPolicyMaxRetries": 10,
            "requiredMountPath": "/data",
        },
        "variables": {
            "PORT": var("8787", "Public port (web UI login gate + API)."),
            "IPOLLOWORK_TOKEN": var(secret(48), "Client token (desktop 'Connect custom remote'; auto-injected into the web UI after login)."),
            "IPOLLOWORK_HOST_TOKEN": var(secret(48), "Owner/host approval token."),
            "IPOLLOWORK_WEB_PASSWORD": var(secret(24), "Password for the browser workbench at https://<worker domain>/. Empty = web UI off."),
            "IPOLLOWORK_APPROVAL_MODE": var("manual", "manual = approve writes from the UI; auto = unattended."),
            "IPOLLOWORK_CORS_ORIGINS": var("*", "CORS for browser clients; tighten to your den-web origin if desired."),
            "IPOLLOWORK_WORKSPACE": var("/data/workspace", "Workspace path on the persistent volume."),
            "IPOLLOWORK_DATA_DIR": var("/data/ipollowork", "OpenCode + server state on the persistent volume."),
            "IPOLLOWORK_SIDECAR_DIR": var("/data/sidecars", "Sidecar cache on the persistent volume."),
            "IPOLLOWORK_LOG_FORMAT": var("json", "Structured logs for Railway log search.", optional=True),
            "ANTHROPIC_API_KEY": var("", "Model key for OpenCode (or set providers in Den and sync).", optional=True),
            "OPENAI_API_KEY": var("", "Model key for OpenCode.", optional=True),
            "OPENROUTER_API_KEY": var("", "Model key for OpenCode.", optional=True),
            "RAILWAY_RUN_UID": var("0", "Volume permissions: run as root inside the container."),
        },
        "networking": {"tcpProxies": {}, "serviceDomains": {"<hasDomain>": {}}},
        "volumeMounts": {sid("worker-volume"): {"mountPath": "/data"}},
    }


def build(with_worker: bool) -> dict:
    services = [mysql_service(), den_api_service(with_worker), den_web_service()]
    if with_worker:
        services.append(worker_service())
    return {"services": {sid(s["name"]): s for s in services}}


def variables_markdown(cfg: dict) -> str:
    out = ["# Template variables\n", "Generated by `scripts/generate-template.py`; do not edit by hand.\n"]
    for s in cfg["services"].values():
        out.append(f"\n## {s['name']}\n")
        src = s["source"].get("image") or f"{s['source'].get('repo')} (root: {s['source'].get('rootDirectory')})"
        out.append(f"Source: `{src}`  ")
        if s["deploy"].get("startCommand"):
            out.append(f"\nStart command: `{s['deploy']['startCommand']}`  ")
        if s["deploy"].get("healthcheckPath"):
            out.append(f"\nHealthcheck: `{s['deploy']['healthcheckPath']}`  ")
        if s.get("volumeMounts"):
            out.append(f"\nVolume: `{list(s['volumeMounts'].values())[0]['mountPath']}`  ")
        out.append("\n\n| Variable | Default | Required | Description |\n|---|---|---|---|")
        for k, v in s["variables"].items():
            d = v["defaultValue"].replace("|", "\\|")
            out.append(f"| `{k}` | `{d}` | {'no' if v.get('isOptional') else 'yes'} | {v['description']} |")
    return "\n".join(out) + "\n"


def main() -> None:
    full = build(with_worker=True)
    image_only = build(with_worker=False)
    (ROOT / "template" / "railway-template.json").write_text(json.dumps(full, indent=2) + "\n")
    (ROOT / "template" / "railway-template.image-only.json").write_text(json.dumps(image_only, indent=2) + "\n")
    (ROOT / "template" / "variables.md").write_text(variables_markdown(full))
    print("wrote template/railway-template.json, template/railway-template.image-only.json, template/variables.md")


if __name__ == "__main__":
    main()
