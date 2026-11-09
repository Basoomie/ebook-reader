/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Counts EPUB characters in Node with the reader's own import code.
 *
 *   pnpm count-epub <file.epub>... [--fix-mode Off|Standard|Extended]
 *                   [--no-restrict-to-anchor] [--sections]
 *
 * Prints one JSON object per file. Files are only read.
 */

import { countEpubFile, defaultEpubImportOptions } from '$lib/server/epub/count-epub-node';
import { ImportHTMLFixMode } from '$lib/data/import-html-fix-mode';

const args = process.argv.slice(2);
const files: string[] = [];
const options = { ...defaultEpubImportOptions };
let showSections = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === '--fix-mode') {
    const value = args[(i += 1)] as ImportHTMLFixMode;

    if (!Object.values(ImportHTMLFixMode).includes(value)) {
      console.error(`--fix-mode must be one of ${Object.values(ImportHTMLFixMode).join(', ')}`);
      process.exit(2);
    }

    options.importHTMLFixMode = value;
  } else if (arg === '--no-restrict-to-anchor') {
    options.restrictImportFixToAnchor = false;
  } else if (arg === '--sections') {
    showSections = true;
  } else if (arg !== '--') {
    files.push(arg);
  }
}

if (!files.length) {
  console.error(
    'usage: count-epub <file.epub>... [--fix-mode Off|Standard|Extended] [--no-restrict-to-anchor] [--sections]'
  );
  process.exit(2);
}

let failed = false;

for (const file of files) {
  try {
    const { characters, sections } = await countEpubFile(file, options);

    console.log(
      JSON.stringify({ file, options, characters, ...(showSections ? { sections } : {}) })
    );
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ file, options, error: String(error) }));
  }
}

process.exit(failed ? 1 : 0);
