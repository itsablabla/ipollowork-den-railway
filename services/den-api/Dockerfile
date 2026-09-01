# Den API (control plane) — wraps the published image so we can run
# migrations-with-retry before the server starts. Pin via versions.json.
ARG DEN_VERSION=0.18.40
FROM ghcr.io/different-ai/openwork-den-api:${DEN_VERSION}

COPY entrypoint.sh /usr/local/bin/railway-entrypoint.sh
RUN chmod +x /usr/local/bin/railway-entrypoint.sh

# Upstream image: ENTRYPOINT docker-entrypoint.sh, CMD node /app/ee/apps/den-api/dist/main.js, PORT=8788
EXPOSE 8788
ENTRYPOINT ["/usr/local/bin/railway-entrypoint.sh"]
CMD ["node", "/app/ee/apps/den-api/dist/main.js"]
