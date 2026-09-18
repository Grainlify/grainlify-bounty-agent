# One image, several services. SERVICE picks which process this container runs.
FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV NODE_ENV=production
CMD ["sh", "scripts/start-service.sh"]
