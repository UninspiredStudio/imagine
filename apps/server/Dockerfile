# Build from the repo root: bun install needs the root package.json and bun.lock.
FROM oven/bun:1.4.4
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
RUN bun install --frozen-lockfile --production
COPY apps/server apps/server
# The spool is a named volume. Docker copies this directory's ownership into a new volume, so it must be bun-owned here.
RUN mkdir -p /spool && chown bun:bun /spool
ENV NODE_ENV=production
EXPOSE 8080
USER bun
# Migrations run at startup, before the server listens.
CMD ["bun", "run", "apps/server/src/index.ts"]
