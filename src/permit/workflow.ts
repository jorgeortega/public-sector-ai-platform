import type { Context } from '../sdk/context.ts';
import { OUTSIDE_RETRY, type Faults } from '../sdk/types.ts';
import { letterFor, type Application } from './applications.ts';
import {
  EligibilitySchema,
  ExtractSchema,
  RecommendationSchema,
  RenewalSchema,
  eligibilityMessages,
  extractMessages,
  recommendMessages,
  renewalMessages,
  searchQuery,
  type Findings,
} from './prompts.ts';

// The permit workflow, on the SDK: every event comes from the SDK's
// methods, so this is only the logic (spec E1). Seven steps and a human
// approval between `recommend` and `report`.

export type Outcome = 'completed' | 'rejected' | 'expired';

export async function permit(ctx: Context, app: Application, faults: Faults): Promise<Outcome> {
  await ctx.step('intake', async () => {
    ctx.clock.pass(35);
    return { value: true, summary: `Application ${app.id} received; the form is complete.` };
  });

  const fields = await ctx.step('extract', async () => {
    const extracted = await ctx.llm(extractMessages(letterFor(app)), ExtractSchema, { name: 'read-application-letter' });
    const problems = await ctx.validate(extracted);
    const named = Object.entries(extracted).filter(([, value]) => value !== undefined).length;
    return { value: extracted, summary: `${named} fields read from the letter${problems.length ? `; ${problems.length} need a person` : ''}.` };
  });

  const hits = await ctx.step('retrieve', async () => {
    const found = await ctx.search(searchQuery(fields), 5);
    const clean = found.filter((hit) => !hit.quarantined).length;
    const quarantined = found.length - clean;
    return { value: found, summary: `${found.length} code sections found${quarantined ? `; ${quarantined} carries instructions and was quarantined` : ''}.` };
  });

  const findings = await ctx.step('eligibility', async () => {
    let result: Findings;
    let turn = 0;
    do {
      turn += 1;
      // The `budget` fault: the check keeps re-reading the whole code.
      const sources = faults.loopEligibility && turn > 1 ? await ctx.search(`${searchQuery(fields)} every rule`, 8) : hits;
      result = await ctx.llm(eligibilityMessages(fields, sources, turn > 1), EligibilitySchema, { name: 'judge-eligibility' });
      if (faults.loopEligibility) ctx.emit.log('warn', `Eligibility turn ${turn}: the model asked to read the whole code again.`);
    } while (faults.loopEligibility || (result.needMore && turn < 3));
    const met = result.rules.filter((rule) => rule.met).length;
    return { value: result, summary: `Meets ${met} of ${result.rules.length} rules.` };
  });

  await ctx.step(
    'registry',
    async (attempt) => {
      await ctx.registry(attempt);
      return { value: true, summary: 'Business registered and in good standing.' };
    },
    { retry: OUTSIDE_RETRY, outside: true },
  );

  const recommendation = await ctx.step('recommend', async () => {
    const answer = await ctx.llm(recommendMessages(fields, findings, hits), RecommendationSchema, { name: 'draft-recommendation' });
    // Only sections search returned unquarantined may be cited (spec E5).
    const allowed = new Set(hits.filter((hit) => !hit.quarantined).map((hit) => hit.id));
    const citations = answer.citations.filter((id) => allowed.has(id));
    for (const dropped of answer.citations.filter((id) => !allowed.has(id))) ctx.emit.log('warn', `The model cited ${dropped}, which it may not; the citation was dropped.`);
    return { value: { ...answer, citations }, summary: `Recommend ${answer.decision}, citing ${citations.length} section${citations.length === 1 ? '' : 's'}.` };
  });

  const decision = await ctx.approval(recommendation);
  if (decision !== 'approve') return 'rejected';

  await ctx.step('report', async () => {
    // Written once per run, whatever delivers it (spec E2).
    if (ctx.claim('report')) {
      ctx.clock.pass(260);
      ctx.writeReport({ decision: recommendation.decision, citations: recommendation.citations, text: recommendation.summary });
      ctx.emit.audit('report.written', recommendation.decision, ctx.workerActor);
    }
    return { value: true, summary: `Decision report written: ${recommendation.decision}.` };
  });
  return 'completed';
}

// A renewal (the burst): nothing changed, so a short path with no approval.
export async function renewal(ctx: Context, id: string): Promise<Outcome> {
  const answer = await ctx.step('extract', async () => {
    const result = await ctx.llm(renewalMessages(id), RenewalSchema, { name: 'compare-with-last-year' });
    return { value: result, summary: result.changed ? 'Something changed: full review.' : 'Same as last year.' };
  });
  await ctx.step('eligibility', async () => {
    ctx.clock.pass(90);
    return { value: !answer.changed, summary: answer.changed ? 'Changed: refer.' : 'No change: renew.' };
  });
  await ctx.step('report', async () => {
    if (ctx.claim('report')) ctx.writeReport({ decision: answer.changed ? 'refer' : 'approve', citations: [], text: answer.changed ? 'Referred for a full review.' : 'Renewed.' });
    return { value: true, summary: 'Renewal decided.' };
  });
  return 'completed';
}
