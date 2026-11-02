FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && node scripts/build-server.mjs

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
	LH_RUNTIME=hosted \
	HOSTNAME=0.0.0.0 \
	PORT=3000 \
	LH_DATA_DIR=/var/lib/learnharness/data \
	LH_AUTH_FILE=/var/lib/learnharness/keys/auth.json \
	LH_OWNER_DIR=/var/lib/learnharness/owner \
	NEXT_TELEMETRY_DISABLED=1 \
	NEXT_MANUAL_SIG_HANDLE=true

COPY --from=build --chown=node:node /app/.next/standalone/ ./
COPY --chown=node:node scripts/owner-passphrase.mjs /app/scripts/owner-passphrase.mjs
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
