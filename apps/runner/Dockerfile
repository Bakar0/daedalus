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
COPY --from=build /src/apps/runner/dist/sessiond.js /opt/daedalus/sessiond.js
COPY --from=build /src/apps/runner/dist/shim.js /opt/daedalus/shim.js
RUN printf '#!/bin/sh\nexec bun /opt/daedalus/shim.js "$@"\n' > /usr/local/bin/daedal \
 && chmod 0755 /usr/local/bin/daedal

# One image, two containers (artifacts/cloud-sessions/h1-pod-spec.md):
#   runner   uid 1000  bun /opt/daedalus/runner.js    token, identity, queue
#   session  uid 1001  bun /opt/daedalus/sessiond.js  tmux, /workspace, agents
# Both get group 2000 from the pod's fsGroup. Neither mounts the other's
# volumes. HOME for sessions is /workspace/.home, made by sessiond.
RUN groupadd --gid 2000 daedalus \
 && groupadd --gid 1000 runner && useradd --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin runner \
 && groupadd --gid 1001 session && useradd --uid 1001 --gid 1001 --groups 2000 --home-dir /workspace/.home --no-create-home --shell /bin/bash session \
 && mkdir -p /workspace /cache /run/daedalus-runner /var/lib/daedalus-runner
ENV LANG=C.UTF-8 HOME=/workspace/.home
USER 1000:1000
WORKDIR /
# The pod sets `command` per container; this is the runner's.
CMD ["bun", "/opt/daedalus/runner.js"]
