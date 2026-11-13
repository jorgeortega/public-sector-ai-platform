import { describe, expect, it } from 'vitest';
import { letterFor } from '../src/permit/applications.ts';
import { GOLDEN } from '../src/evals/golden.ts';
import { chunkSources } from '../src/rag/search.ts';
import { readSources } from '../src/rag/sources.ts';

// The golden set itself (evals spec, Testing): every section it names is in
// its city's code, every case renders a letter, and the set stays balanced.

const chunks = chunkSources(readSources());
const sectionsOf = (tenant: string) => new Set(chunks.filter((chunk) => chunk.tenant === tenant).map((chunk) => chunk.id));

describe('the golden set', () => {
  it('has unique ids, about twenty cases, and every decision several times', () => {
    const ids = GOLDEN.map((c) => c.application.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(GOLDEN.length).toBeGreaterThanOrEqual(18);
    for (const decision of ['approve', 'deny', 'refer']) expect(GOLDEN.filter((c) => c.decision === decision).length, decision).toBeGreaterThanOrEqual(4);
    for (const tenant of ['port-alder', 'kestrel-bay']) expect(GOLDEN.filter((c) => c.application.tenant === tenant).length, tenant).toBeGreaterThanOrEqual(8);
  });

  it.each(GOLDEN.map((c) => [c.application.id, c] as const))('%s names only sections of its own city', (_id, c) => {
    const own = sectionsOf(c.application.tenant);
    for (const section of [...c.restsOn, ...c.neverCite]) expect(own, section).toContain(section);
    expect(c.application.id.slice(0, 2)).toBe(c.application.tenant === 'port-alder' ? 'pa' : 'kb');
  });

  it('keeps the planted note out of every Kestrel Bay café’s citations', () => {
    for (const c of GOLDEN.filter((c) => c.application.tenant === 'kestrel-bay')) expect(c.neverCite, c.application.id).toContain('kbc-note-0017');
  });

  it('says in the letter what the expectation rests on', () => {
    const letter = (id: string) => letterFor(GOLDEN.find((c) => c.application.id === id)!.application);
    expect(letter('pa-bakery-0555')).toContain('We do not have a food handler certificate yet.');
    expect(letter('pa-salon-0562')).toContain('Not everyone who works on clients holds a state licence yet.');
    expect(letter('pa-salon-0203')).toContain('Everyone who works on clients holds a state licence.');
    expect(letter('pa-catering-0570')).toContain('home kitchen, which has not been inspected');
    expect(letter('kb-cafe-0610')).toContain('We would like 8 seats on the sidewalk.');
    expect(letter('kb-cafe-0632')).toContain('We will be open 7 am to midnight.');
  });
});
