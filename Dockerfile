FROM node:24-bookworm-slim
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node . .
RUN chown node:node /app /app/node_modules
ENTRYPOINT ["node", "scripts/container-entrypoint.mjs"]
EXPOSE 4173
CMD ["node", "node_modules/vite/bin/vite.js"]
