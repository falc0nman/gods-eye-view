FROM node:24-bookworm-slim AS tooling
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node . .
RUN chown node:node /app /app/node_modules
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
EXPOSE 4173
CMD ["node", "server/database/migrate.js"]

FROM tooling AS frontend-build
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine AS frontend
COPY config/frontend.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend-build /app/dist /usr/share/nginx/html
EXPOSE 8080
