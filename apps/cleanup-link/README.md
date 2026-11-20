# ttsu-cleanup-link

WP21e-1: the audiobook cleanup's linking sidecar. It builds the new library
`media/audiobooks/japanese-new/` (and `japanese-generated-new/` for the AI books) next to the live
one, from the plan the reader's server keeps in cleanup.db (audiobook stage 6 on `/cleanup`).

- It is the only process that writes audiobook files. `src/writer.ts` is the only module that
  writes, and it can only create: folders, hard links to files under
  `torrents/audiobooks/japanese/` (exactly the files the plan names), and each book's
  `metadata.json`, all under the two new folders. No rename, move or delete; nothing in the
  torrents, the live library or anywhere else under `/data` is changed.
- It mounts `/mnt/disk1/data` once, read-write, at `/data` (a hard link can't cross two mounts;
  `/mnt/user` would not do: Unraid's FUSE layer).
- It works only when the server hands out a batch. Build batches are handed out only while the
  server holds the disk lock it shares with the Calibre cleanup (Calibre first).
- Before the build, it checks every planned torrent file (read only): unchanged since stage 1,
  and linkable by this process (`fs.protected_hardlinks`).

Environment:

| Name                     | Default                    |                                                                            |
| ------------------------ | -------------------------- | -------------------------------------------------------------------------- |
| `TTSU_URL`               | `http://ttsu-storage:3001` | the storage server                                                         |
| `LINK_TOKEN`             |                            | from `docker exec ttsu-storage node dist/cli.js token link "link sidecar"` |
| `DATA_DIR`               | `/data`                    | the mount of `/mnt/disk1/data`                                             |
| `DIR_MODE` / `FILE_MODE` | `0777` / `0666`            | new folders / metadata files (Unraid shares)                               |

Run it as `99:100` (Unraid's nobody:users), like the other cleanup containers.
