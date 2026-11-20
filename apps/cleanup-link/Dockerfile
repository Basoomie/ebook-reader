# WP21e-1: the audiobook cleanup's linking sidecar, the only process that writes audiobook files.
#
# Node only, no npm packages. Mount /mnt/disk1/data once at /data, read-write (a hard link can't
# cross two mounts); the writer module only creates folders, hard links and metadata.json under
# media/audiobooks/japanese-new/ and japanese-generated-new/.
FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN npm install --no-save --no-audit --no-fund typescript@5.9.3 @types/node@22
COPY tsconfig.json ./
COPY src ./src
RUN node node_modules/typescript/bin/tsc -p tsconfig.json --typeRoots ./node_modules/@types

FROM node:22-bookworm-slim
COPY --from=build /build/dist /app/dist
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/node", "/app/dist/main.js"]
