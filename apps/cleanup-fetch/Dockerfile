# WP20d: the library cleanup's fetch container.
#
# Runs with network_mode: container:gluetun, so every request goes out through the VPN. Node only
# (no npm packages) plus a small Python with the PC TTS's pinned SudachiPy for generated author
# readings. No volumes: the reader's server keeps the queue and the cache.
FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN npm install --no-save --no-audit --no-fund typescript@5.9.3 @types/node@22
COPY tsconfig.json ./
COPY src ./src
RUN node node_modules/typescript/bin/tsc -p tsconfig.json --typeRoots ./node_modules/@types

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && python3 -m venv /opt/sudachi \
  && /opt/sudachi/bin/pip install --no-cache-dir sudachipy==0.6.10 sudachidict-core==20260428 \
  && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/dist /app/dist
COPY sudachi /app/sudachi
ENV SUDACHI_PYTHON=/opt/sudachi/bin/python \
    SUDACHI_SCRIPT=/app/sudachi/readings.py \
    HOME=/tmp
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/node", "/app/dist/main.js"]
