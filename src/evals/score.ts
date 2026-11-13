import type { Application } from '../permit/applications.ts';
import type { Decision, GoldenCase } from './golden.ts';

// The four scores (evals spec V3): code, no model judge. A score is null
// when it doesn't apply: retrieval for a case that rests on no section.

export const METRICS = ['decision', 'citations', 'retrieval', 'extraction'] as const;
export type Metric = (typeof METRICS)[number];
export type Scores = Record<Metric, boolean | null>;

// What one attempt showed. `citations` is what the report would cite;
// `dropped` is what the model cited and the workflow took out (a
// quarantined or unknown section), which still counts against the model.
export type Observed = {
  decision?: Decision;
  citations: string[];
  dropped: string[];
  retrieved: string[];
  extracted?: Record<string, unknown>;
};

// The fields compared: the ones a rule turns on. Text fields like the
// business name and the type are free to be worded differently.
export const COMPARED = ['zone', 'staff', 'foodHandlerCertificate', 'signSquareMetres', 'outdoorSeats', 'stateLicences', 'largestEventGuests', 'sellsFood', 'flammableGoods'] as const satisfies readonly (keyof Application)[];

const same = (field: string, expected: unknown, read: unknown) =>
  field === 'zone' && typeof read === 'string' ? read.trim().toUpperCase() === String(expected).toUpperCase() : read === expected;

export function extractionMisses(app: Application, extracted: Record<string, unknown> | undefined): string[] {
  const misses: string[] = [];
  for (const field of COMPARED) {
    const expected = app[field];
    if (expected === undefined) continue;
    const read = extracted?.[field];
    if (!same(field, expected, read)) misses.push(`${field}: ${JSON.stringify(expected)}, read ${read === undefined ? 'nothing' : JSON.stringify(read)}`);
  }
  return misses;
}

export function score(c: GoldenCase, seen: Observed): { scores: Scores; notes: string[] } {
  const notes: string[] = [];
  const cited = [...seen.citations, ...seen.dropped];

  const decision = seen.decision === undefined ? false : seen.decision === c.decision;
  if (seen.decision !== undefined && !decision) notes.push(`decided ${seen.decision}, expected ${c.decision}`);

  const missing = c.restsOn.filter((section) => !seen.citations.includes(section));
  const forbidden = c.neverCite.filter((section) => cited.includes(section));
  const citations = seen.decision !== undefined && seen.citations.length > 0 && missing.length === 0 && forbidden.length === 0;
  if (seen.decision !== undefined) {
    if (seen.citations.length === 0) notes.push('cited nothing');
    if (missing.length) notes.push(`didn't cite ${missing.join(', ')}`);
    if (forbidden.length) notes.push(`cited ${forbidden.join(', ')}, which it must not`);
  }

  const retrieval = c.restsOn.length === 0 ? null : c.restsOn.every((section) => seen.retrieved.includes(section));
  if (retrieval === false) notes.push(`search missed ${c.restsOn.filter((section) => !seen.retrieved.includes(section)).join(', ')}`);

  const misread = extractionMisses(c.application, seen.extracted);
  const extraction = seen.extracted !== undefined && misread.length === 0;
  if (seen.extracted !== undefined && misread.length) notes.push(`misread ${misread.join('; ')}`);

  return { scores: { decision, citations, retrieval, extraction }, notes };
}
