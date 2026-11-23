# WP21e-1: the audiobook cleanup's linking sidecar, the only process that writes audiobook files.
#
# Node only, no npm packages. Mount /mnt/disk1/data once at /data, read-write (a hard link can't
# cross two mounts); the writer module only creates folders, hard links and metadata.json under
# media/audiobooks/japanese-new/ and japanese-generated-new/ (WP21e-1), new books' folders under
# media/audiobooks/japanese/ and japanese-generated/ (WP21f-1), and unpacked archive entries
# under torrents/audiobooks/japanese/_extracted/ (WP21f-1).
#
# WP21f-1: libarchive-tools (bsdtar) reads the archives: it gets an archive as a read-only file
# descriptor and only lists it or writes one entry to its standard output.
#
# WP20g: 7zip (7zz, Debian bookworm's package) reads split archive sets (.001, .002 ...) by their
# first volume's name: it only lists them or writes one entry to its standard output. Unpacked
# entries go under the book source folder's _extracted/ (writer.ts, extractBookEntry).
FROM node:22-bookworm-slim AS build
WORKDIR /build
RUN npm install --no-save --no-audit --no-fund typescript@5.9.3 @types/node@22
COPY tsconfig.json ./
COPY src ./src
RUN node node_modules/typescript/bin/tsc -p tsconfig.json --typeRoots ./node_modules/@types

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends libarchive-tools 7zip \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/dist /app/dist
WORKDIR /app
ENTRYPOINT ["/usr/local/bin/node", "/app/dist/main.js"]
