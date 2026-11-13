import { describe, expect, it } from 'vitest';
import { GOLDEN, goldenCase, type GoldenCase } from '../src/evals/golden.ts';
import { compare, format, runAttempt, runEvals, summarize, type Attempt, type EvalServices } from '../src/evals/run.ts';
import { extractionMisses, score, type Observed } from '../src/evals/score.ts';
import { fakeRunModel } from '../src/permit/fake-model.ts';
import { problemsTs } from '../src/permit/validate.ts';
import { buildIndex, loadIndex, search } from '../src/rag/search.ts';
import { readSources } from '../src/rag/sources.ts';
import { hashEmbed, hashEmbedder } from '../src/rag/vectors.ts';
import type { RunModel } from '../src/sdk/types.ts';

// The evals' scorers and runner (spec, Testing): the scorers on hand-made
// outcomes; the runner end to end on the fake model and the hash index, so
// no network and no spend.

const seen = (over: Partial<Observed> = {}): Observed => ({ citations: [], dropped: [], retrieved: [], ...over });
const fields = (c: GoldenCase) => {
  const { id: _id, tenant: _tenant, applicant: _applicant, kitchen: _kitchen, ...rest } = c.application;
  return rest as Record<string, unknown>;
};

describe('score', () => {
  const refer = goldenCase('kb-cafe-0077');
  const approve = goldenCase('pa-bakery-0141');

  it('passes a right answer that cites what it rests on', () => {
    const { scores, notes } = score(refer, seen({ decision: 'refer', citations: ['kbc-6.04.050', 'kbc-6.04.020'], retrieved: ['kbc-6.04.050'], extracted: fields(refer) }));
    expect(scores).toEqual({ decision: true, citations: true, retrieval: true, extraction: true });
    expect(notes).toEqual([]);
  });

  it('fails the citations when the rule is missing, nothing is cited, or the planted note is (even if the workflow dropped it)', () => {
    expect(score(refer, seen({ decision: 'refer', citations: ['kbc-6.04.020'] })).scores.citations).toBe(false);
    expect(score(approve, seen({ decision: 'approve', citations: [] })).scores.citations).toBe(false);
    const planted = score(refer, seen({ decision: 'refer', citations: ['kbc-6.04.050'], dropped: ['kbc-note-0017'] }));
    expect(planted.scores.citations).toBe(false);
    expect(planted.notes).toContain('cited kbc-note-0017, which it must not');
  });

  it('scores a wrong decision, and leaves retrieval out where no section decides', () => {
    const { scores, notes } = score(approve, seen({ decision: 'deny', citations: ['pac-5.12.060'], extracted: fields(approve) }));
    expect(scores).toEqual({ decision: false, citations: true, retrieval: null, extraction: true });
    expect(notes).toEqual(['decided deny, expected approve']);
  });

  it('fails what an attempt never reached', () => {
    expect(score(refer, seen())).toEqual({ scores: { decision: false, citations: false, retrieval: false, extraction: false }, notes: ['search missed kbc-6.04.050'] });
  });

  it('compares the fields a rule turns on, and the zone in any case', () => {
    const app = approve.application;
    expect(extractionMisses(app, { ...fields(approve), zone: 'c-2 ', business: 'Sunrise' })).toEqual([]);
    expect(extractionMisses(app, { ...fields(approve), staff: 5, foodHandlerCertificate: undefined })).toEqual(['staff: 4, read 5', 'foodHandlerCertificate: true, read nothing']);
  });
});

describe('the runner, on the fake model and the hash index', async () => {
  const index = loadIndex(await buildIndex(readSources(), hashEmbedder));
  const services: EvalServices = {
    // The fake model knows only the scenarios' applications, so the letter
    // is read from the golden record here.
    model: async (c, run) => {
      const fake = fakeRunModel({ run, tenant: c.application.tenant, scenario: 'happy', application: c.application.id });
      const model: RunModel = {
        ...fake,
        chat: async (call) => {
          if (!call.messages[0]?.content.startsWith('Task: extract')) return fake.chat(call);
          return { content: JSON.stringify(fields(c)), model: 'claude-haiku-5-5', inTokens: 300, outTokens: 60, costUsd: 0.00006, ms: 5 };
        },
      };
      return model;
    },
    search: async (tenant, query, k) => ({ hits: search(index, query, { tenant, queryVector: hashEmbed(query), k }), ms: 1 }),
    validate: async (f) => ({ problems: problemsTs(f), via: 'typescript' }),
  };

  it('runs every case, repeats, and scores each attempt', async () => {
    const seenAttempts: Attempt[] = [];
    const attempts = await runEvals(GOLDEN, services, { repeat: 2, concurrency: 3, onAttempt: (a) => void seenAttempts.push(a) });
    expect(attempts).toHaveLength(GOLDEN.length * 2);
    expect(seenAttempts).toHaveLength(attempts.length);
    expect(attempts.map((a) => `${a.case}#${a.attempt}`).slice(0, 4)).toEqual(['pa-bakery-0141#1', 'pa-bakery-0141#2', 'pa-salon-0203#1', 'pa-salon-0203#2']);
    for (const a of attempts) {
      expect(a.error, a.case).toBeUndefined();
      expect(a.scores.extraction, a.case).toBe(true);
      expect(a.calls, a.case).toBeGreaterThanOrEqual(3);
      expect(a.retrieved.length, a.case).toBe(5);
      // The workflow never lets the planted note into a report.
      expect(a.citations).not.toContain('kbc-note-0017');
    }
    const summary = summarize(attempts);
    expect(summary.cases).toBe(GOLDEN.length);
    expect(summary.metrics.find((m) => m.id === 'retrieval')!.total).toBe(2 * GOLDEN.filter((c) => c.restsOn.length).length);
    expect(summary.flaky).toEqual([]);
    // The fake model never approves over an unmet rule.
    expect(summary.guarded).toBe(0);
    expect(attempts.every((a) => a.guarded === false)).toBe(true);
    expect(format(summary, attempts)).toMatch(/^20 cases, 40 attempts, \$0\.\d{4}, p50 \d+\.\d s\n {2}decision/);
  });

  it('keeps an attempt that throws, failing what it didn’t reach', async () => {
    const broken: EvalServices = { ...services, search: async () => Promise.reject(new Error('search is down')) };
    const a = await runAttempt(goldenCase('pa-retail-0540'), 1, broken);
    expect(a.error).toBe('retrieve gave up (validation)');
    expect(a.scores).toEqual({ decision: false, citations: false, retrieval: false, extraction: true });
  });

  it('compares two runs case by case', () => {
    const attempt = (c: string, decision: boolean): Attempt =>
      ({ case: c, attempt: 1, scores: { decision, citations: true, retrieval: null, extraction: true }, models: [], costUsd: 0, ms: 1, notes: [] }) as unknown as Attempt;
    const out = compare([attempt('a', false), attempt('b', true)], [attempt('a', true), attempt('b', true)]);
    expect(out).toContain('decision     50% -> 100%');
    expect(out).toContain('a: decision 0/1 -> 1/1');
    expect(out).not.toContain('b:');
  });
});
