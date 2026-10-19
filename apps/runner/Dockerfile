# Image `daedalus-runner`. Build from the repository root:
#   docker build -f apps/runner/Dockerfile -t daedalus-runner:dev .
FROM oven/bun:1.4.2-debian AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile --filter @daedalus/runner \
 && bun run --cwd apps/runner build

FROM debian:bookworm-slim
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git locales nodejs npm openssh-client tmux unzip \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/bun /usr/local/bin/bun
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force

COPY --from=build /src/apps/runner/dist/runner.js /opt/daedalus/runner.js
COPY --from=build /src/apps/runner/dist/shim.js /opt/daedalus/shim.js
RUN printf '#!/bin/sh\nexec bun /opt/daedalus/shim.js "$@"\n' > /usr/local/bin/daedal \
 && chmod 0755 /usr/local/bin/daedal

# The workspace volume mounts over /workspace; HOME lives on it so provider
# state survives a sleep. The runner creates /workspace/.home at start.
RUN useradd --uid 1000 --create-home --shell /bin/bash runner \
 && mkdir -p /workspace /cache \
 && chown runner:runner /workspace /cache
ENV LANG=C.UTF-8 HOME=/workspace/.home
USER 1000:1000
WORKDIR /workspace
CMD ["bun", "/opt/daedalus/runner.js"]
