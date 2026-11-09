/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writableNumberLocalStorageSubject } from '$lib/data/internal/writable-number-local-storage-subject';
import { writableStringLocalStorageSubject } from '$lib/data/internal/writable-string-local-storage-subject';

/** Per-device Library page settings (WP6). */

/** How long a catalog request may take before the page reports the server as unreachable. 0 = no limit. */
export const libraryRequestTimeoutSeconds$ = writableNumberLocalStorageSubject()(
  'libraryRequestTimeoutSeconds',
  20
);

/** Library picked in the Library page ('' = all libraries). */
export const libraryFilter$ = writableStringLocalStorageSubject()('libraryFilter', '');
