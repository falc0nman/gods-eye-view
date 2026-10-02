FROM node:24-bookworm-slim
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node backend ./backend
COPY --chown=node:node server/database/connection.js ./server/database/connection.js
COPY --chown=node:node scripts/container-entrypoint.mjs ./scripts/container-entrypoint.mjs
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
EXPOSE 3000
CMD ["node", "backend/main.js"]
