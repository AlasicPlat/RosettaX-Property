# ============================================================
# RosettaX-Property Dockerfile — 独立账号处理 worker 多阶段构建
#
# Stage 1 (builder): 安装依赖并编译 TypeScript 到 dist/
# Stage 2 (runner):  只安装生产依赖并运行 Nest application context
# ============================================================

# NODE_IMAGE 可在 docker compose build 时覆盖, 方便不同部署环境复用镜像源.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine
FROM ${NODE_IMAGE} AS builder

WORKDIR /app

# 先拷贝依赖清单, 利用 Docker layer cache 加速重复构建.
COPY package.json package-lock.json ./
RUN npm ci

# 拷贝源码与 Nest 配置后执行编译.
COPY tsconfig.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build


ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-alpine
FROM ${NODE_IMAGE} AS runner

WORKDIR /app

# 运行态只安装生产依赖; 该服务不监听 HTTP 端口.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/main.js"]
