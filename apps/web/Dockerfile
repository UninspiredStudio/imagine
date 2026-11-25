# Build from the repo root: bun install needs every workspace package.json to match bun.lock.
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/api-client/package.json packages/api-client/
COPY packages/components/package.json packages/components/
RUN bun install --frozen-lockfile
COPY apps/web apps/web
COPY packages packages
WORKDIR /app/apps/web
RUN bun run build

FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
