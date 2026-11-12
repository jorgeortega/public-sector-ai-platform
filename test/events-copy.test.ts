import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCHEMA_HASH } from '../src/events/events.ts';

// src/events/ is a byte-for-byte copy of the site's app/ai-platform/_lib/
// events.ts, topology.ts and scrub.ts. The site pins SCHEMA_HASH to them; the
// same recipe here proves the copies are equal to what the site has.
describe('the copied event contract', () => {
  it('hashes to the SCHEMA_HASH the site pinned', () => {
    const shared = (name: string) => readFileSync(new URL(`../src/events/${name}`, import.meta.url), 'utf8');
    const hash = createHash('sha256')
      .update(
        [
          shared('events.ts')
            .split('\n')
            .filter((line) => !line.startsWith('export const SCHEMA_HASH = '))
            .join('\n'),
          shared('topology.ts'),
          shared('scrub.ts'),
        ].join('\n---\n'),
      )
      .digest('hex');
    expect(hash, 'the copies drifted: copy events.ts, topology.ts and scrub.ts from the site again').toBe(SCHEMA_HASH);
  });
});
