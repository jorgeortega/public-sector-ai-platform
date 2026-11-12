import { readdirSync, readFileSync } from 'node:fs';
import type { Source } from './search.ts';

// The corpus on disk: every Markdown file in data/code.
export const CODE_DIR = new URL('../../data/code/', import.meta.url);

export const readSources = (dir: URL = CODE_DIR): Source[] =>
  readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => ({ file, markdown: readFileSync(new URL(file, dir), 'utf8') }));
