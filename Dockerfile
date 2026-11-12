FROM node:22.21.1-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY frontend ./frontend
RUN npm run build:all && npm prune --omit=dev

FROM node:22.21.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/db/migrations ./src/db/migrations
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 4222
CMD ["node", "dist/src/server.js"]
