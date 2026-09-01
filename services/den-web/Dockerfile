# Den Web (Next.js dashboard + /api/den proxy). Binds :: so Railway's
# IPv6 private network and public proxy both reach it.
ARG DEN_VERSION=0.18.40
FROM ghcr.io/different-ai/openwork-den-web:${DEN_VERSION}

# Upstream: WORKDIR /app/ee/apps/den-web, ENTRYPOINT docker-entrypoint.sh
EXPOSE 3005
CMD ["sh", "-lc", "exec /app/ee/apps/den-web/node_modules/.bin/next start --hostname :: --port ${PORT:-3005}"]
