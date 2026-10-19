# The gateway image, daedalus-gateway. Build from the repository root:
#   docker build -f apps/gateway/Dockerfile -t daedalus-gateway:dev .
# Dockerfile.dockerignore next to this file keeps the context small.

FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts --filter @daedalus/gateway
RUN bun build apps/gateway/src/index.ts --target bun --outfile /out/gateway.js

FROM oven/bun:1.4.2-slim
WORKDIR /app
COPY --from=build /out/gateway.js ./gateway.js
# The chart runs it as uid 1000 with a read-only root and /data for SQLite.
USER 1000:1000
ENV DAEDALUS_GATEWAY_PORT=8080
EXPOSE 8080
CMD ["bun", "gateway.js"]
