# PlayMCP in KC: 컨테이너 이미지 또는 Git 소스(이 Dockerfile 사용) 등록 모두 지원
# 멀티스테이지: build(tsc) → runtime(prod only)

FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# KC가 PORT를 주입하면 그 값을 사용, 없으면 8080
ENV PORT=8080
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
# 헬스체크: GET /healthz
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "dist/server.js"]
