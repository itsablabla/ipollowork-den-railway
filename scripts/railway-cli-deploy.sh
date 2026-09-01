#!/usr/bin/env bash
# Alternative to railway-provision.mjs using the Railway CLI (v4+).
# Creates a project and adds the four services from published images / this repo.
# Requires: railway CLI logged in (railway login) and a GitHub repo of this template
# (for the worker service, which has no published image).
set -euo pipefail

PROJECT_NAME="${PROJECT_NAME:-ipollowork-den}"
OWNER_EMAIL="${OWNER_EMAIL:?export OWNER_EMAIL=you@example.com}"
ORG_NAME="${ORG_NAME:-Garza}"
DEN_VERSION="$(python3 -c 'import json;print(json.load(open("versions.json"))["den"])')"
TEMPLATE_REPO="$(python3 -c 'import json;print(json.load(open("versions.json"))["template_repo"])')"

rand() { openssl rand -hex "$1"; }

railway init --name "$PROJECT_NAME"

# mysql
railway add --service mysql --image "mysql:8.4" \
  --variables "MYSQL_ROOT_PASSWORD=$(rand 16)" \
  --variables "MYSQL_DATABASE=openwork_den" \
  --variables 'MYSQL_URL=mysql://root:${{MYSQL_ROOT_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:3306/${{MYSQL_DATABASE}}'
railway volume add --service mysql --mount-path /var/lib/mysql

# den-api
railway add --service den-api --image "ghcr.io/different-ai/openwork-den-api:${DEN_VERSION}" \
  --variables "PORT=8788" --variables "NODE_ENV=production" --variables "CI=true" --variables "OPENWORK_DEV_MODE=0" --variables "DB_MODE=mysql" \
  --variables 'DATABASE_URL=${{mysql.MYSQL_URL}}' \
  --variables "BETTER_AUTH_SECRET=$(rand 32)" --variables "DEN_DB_ENCRYPTION_KEY=$(rand 32)" \
  --variables 'DEN_BASE_URL=https://${{den-web.RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'BETTER_AUTH_URL=https://${{den-web.RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'DEN_API_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'DEN_MCP_RESOURCE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}/mcp' \
  --variables 'DEN_MCP_CLAIM_NAMESPACE=https://${{den-web.RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'CORS_ORIGINS=https://${{den-web.RAILWAY_PUBLIC_DOMAIN}},https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'DEN_BETTER_AUTH_TRUSTED_ORIGINS=https://${{den-web.RAILWAY_PUBLIC_DOMAIN}},https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  --variables "DEN_ORG_MODE=single_org" --variables "DEN_SINGLE_ORG_NAME=${ORG_NAME}" --variables "DEN_SINGLE_ORG_SLUG=default" \
  --variables "DEN_SINGLE_ORG_OWNER_EMAILS=${OWNER_EMAIL}" --variables "DEN_BOOTSTRAP_ADMIN_EMAILS=${OWNER_EMAIL}" \
  --variables "DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP=false" --variables "DEN_REQUIRE_EMAIL_VERIFICATION=false" \
  --variables "DEN_PASSWORD_BREACH_SCREENING_ENABLED=true" --variables "DEN_INSTALL_LINKS_GATING_ENABLED=false" \
  --variables "DEN_AUTOMATIONS_ENABLED=true" --variables "DEN_AUTOMATIONS_RUNTIME_ENABLED=true" --variables "DEN_DASHBOARDS_ENABLED=true" \
  --variables "DEN_OPENWORK_WEB_ENABLED=false" --variables "DEN_ALLOW_PRIVATE_MCP_URLS=0" --variables "DEN_DESKTOP_RELEASES_MODE=github" \
  --variables "PROVISIONER_MODE=stub" --variables 'WORKER_URL_TEMPLATE=https://${{worker.RAILWAY_PUBLIC_DOMAIN}}'
railway domain --service den-api

# den-web
railway add --service den-web --image "ghcr.io/different-ai/openwork-den-web:${DEN_VERSION}" \
  --variables "PORT=3005" --variables "NODE_ENV=production" \
  --variables 'DEN_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'DEN_WEB_PUBLIC_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'DEN_AUTH_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'DEN_WEB_OPENWORK_AUTH_CALLBACK_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  --variables 'DEN_API_BASE=http://${{den-api.RAILWAY_PRIVATE_DOMAIN}}:8788' \
  --variables 'DEN_AUTH_FALLBACK_BASE=http://${{den-api.RAILWAY_PRIVATE_DOMAIN}}:8788' \
  --variables 'DEN_API_PUBLIC_URL=https://${{den-api.RAILWAY_PUBLIC_DOMAIN}}' \
  --variables "DEN_ORG_MODE=single_org" --variables "DEN_SINGLE_ORG_NAME=${ORG_NAME}" --variables "DEN_SINGLE_ORG_SLUG=default" \
  --variables "DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP=false"
railway domain --service den-web

# worker (built from this repo; set root directory + volume in the dashboard if the CLI lacks flags)
railway add --service worker --repo "${TEMPLATE_REPO}" \
  --variables "PORT=8787" --variables "OPENWORK_PORT=8787" \
  --variables "OPENWORK_TOKEN=$(rand 24)" --variables "OPENWORK_HOST_TOKEN=$(rand 24)" \
  --variables "OPENWORK_APPROVAL_MODE=manual" --variables "OPENWORK_CORS_ORIGINS=*" --variables "RAILWAY_RUN_UID=0"
railway volume add --service worker --mount-path /data
railway domain --service worker

cat <<MSG

Services created. Remaining manual settings (Railway dashboard):
  - den-api  > Settings > Deploy > Start Command:
      $(python3 -c 'import json;d=json.load(open("template/railway-template.json"));print([s for s in d["services"].values() if s["name"]=="den-api"][0]["deploy"]["startCommand"])')
    Healthcheck path: /health
  - den-web  > Start Command:
      $(python3 -c 'import json;d=json.load(open("template/railway-template.json"));print([s for s in d["services"].values() if s["name"]=="den-web"][0]["deploy"]["startCommand"])')
    Healthcheck path: /api/health
  - worker   > Settings > Source > Root Directory: services/worker ; Healthcheck: /health
Then: Project Settings > "Generate Template from Project" to publish this as a Railway template.
MSG
