FROM node:24-bookworm-slim
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node backend ./backend
COPY --chown=node:node server/database/connection.js ./server/database/connection.js
# Data providers on the common interface (server/providers/interface.js).
# src/tooling/backendProviders.test.mjs checks this list covers its imports.
COPY --chown=node:node server/providers/interface.js server/providers/registry.js server/providers/nexrad-level2.js ./server/providers/
COPY --chown=node:node server/providers/common ./server/providers/common
COPY --chown=node:node server/providers/notifications ./server/providers/notifications
COPY --chown=node:node server/providers/nexrad ./server/providers/nexrad
COPY --chown=node:node src/layers/nexrad/palette.js ./src/layers/nexrad/palette.js
COPY --chown=node:node scripts/container-entrypoint.mjs ./scripts/container-entrypoint.mjs
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
EXPOSE 3000
CMD ["node", "backend/main.js"]
