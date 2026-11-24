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
# 新后台前端（Vue3 有源码版，2026-11-18 替换编译版 Vue 后台）：
# 构建产物在 runtime 层挂到 /app/frontend-vue/dist，compose 的
# REA_FRONTEND_DIR 指向它——旧 public/ 编译版保留但不再服务。
COPY frontend-vue/package.json frontend-vue/package-lock.json ./frontend-vue/
RUN npm ci --prefix frontend-vue
COPY frontend-vue ./frontend-vue
RUN npm run build --prefix frontend-vue
COPY scripts/publish-vue-assets.mjs ./scripts/publish-vue-assets.mjs
RUN node scripts/publish-vue-assets.mjs --runtime
RUN npm run build:all && npm prune --omit=dev

FROM node:22.21.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/db/migrations ./src/db/migrations
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/frontend/dist ./frontend/dist
COPY --from=build --chown=node:node /app/frontend-vue/dist ./frontend-vue/dist

USER node
EXPOSE 4222
CMD ["node", "dist/src/server.js"]
