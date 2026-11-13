# WP20a: the Calibre library cleanup's apply sidecar.
#
# Built FROM the same linuxserver/calibre image as the user's `calibre` container, for its
# calibredb: the client and the content server must be the same calibre version
# (/cdb/cmd/<command>/<version>). Set CALIBRE_TAG to the calibre container's tag.
#
# Only calibredb and Node are used; the image's desktop (s6, KasmVNC) never starts.
ARG CALIBRE_TAG=9.18.0

FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN npm install --no-save --no-audit --no-fund typescript@5.9.3 @types/node@22
COPY tsconfig.json ./
COPY src ./src
RUN node node_modules/typescript/bin/tsc -p tsconfig.json --typeRoots ./node_modules/@types

FROM node:22-bookworm-slim AS node

FROM lscr.io/linuxserver/calibre:${CALIBRE_TAG}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /build/dist /app/dist
ENV CALIBREDB=/opt/calibre/calibredb \
    QUARANTINE_DIR=/quarantine \
    HOME=/tmp
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/node", "/app/dist/main.js"]
