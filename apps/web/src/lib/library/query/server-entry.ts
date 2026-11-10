/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Entry point of the storage server's copy of the search parser
 * (`apps/storage-server/vendor/library-query.cjs`, built by `pnpm build:server-query`).
 * The server parses with exactly this code and turns the result into SQL itself.
 */

export {
  parseQuery,
  usesBookState,
  usesRegex,
  QUERY_FIELDS,
  QUERY_LIMITS,
  QUERY_STATUSES
} from './parse';
