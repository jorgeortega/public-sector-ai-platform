import { GatewayError, keyTail, type ChatResult, type Message } from '../gateway/client.ts';
import { RUN_KEY, costOf, type ModelName } from '../gateway/config.ts';
import type { ModelCall, RunInput, RunModel } from '../sdk/types.ts';
import { application, type Application } from './applications.ts';

// A deterministic stand-in for the gateway and the model, for tests and
// development (never for a recorded replay, spec E9). It answers each task
// the way a careful reviewer would, from the application record and simple
// rules; reports token counts from the prompt's length; prices them at the
// gateway's list prices; falls back when asked for the "down" group; and
// refuses a call once the run's budget is spent, as the gateway does.

// Sections a reviewer decides on, and how each one is met.
const RULES: Record<string, (app: Application) => boolean> = {
  'pac-17.40.110': (app) => (app.signSquareMetres ?? 0) <= 2,
  'pac-17.20.050': (app) => app.staff < 10 && !/1 am|2 am|3 am|4 am/.test(app.hours ?? ''),
  'pac-5.12.060': (app) => app.foodHandlerCertificate !== false,
  'pac-5.20.010': (app) => app.stateLicences !== false,
  'kbc-6.04.050': (app) => (app.outdoorSeats ?? 0) <= 8,
  'kbc-18.10.015': (app) => !/1[1-2] pm|am$/.test(app.hours ?? ''),
};
// A section that isn't met but leaves the decision to a reviewer.
const REFERRED = new Set(['kbc-6.04.050', 'pac-17.40.110', 'pac-17.20.050']);

const tokens = (messages: Message[]) => Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
const sources = (text: string) => [...text.matchAll(/<source id="([^"]+)"/g)].map((match) => match[1]!);
const appOf = (text: string) => /(?:Application|Renewal) ([a-z0-9-]+)/.exec(text)?.[1] ?? '';

function answer(messages: Message[]): string {
  const system = messages[0]?.content ?? '';
  const user = messages.at(-1)?.content ?? '';
  const task = /^Task: (\w+)/.exec(system)?.[1];
  if (task === 'renewal') return JSON.stringify({ changed: false });
  if (task === 'extract') {
    const { id: _id, tenant: _tenant, applicant: _applicant, kitchen: _kitchen, ...fields } = application(appOf(user));
    return JSON.stringify(fields);
  }
  const fields = JSON.parse(/Application fields: (\{.*\})/.exec(user)?.[1] ?? '{}') as Application;
  const ids = sources(user);
  if (task === 'eligibility') {
    const rules = ids.slice(0, 8).map((section) => {
      const met = RULES[section]?.(fields) ?? true;
      return { section, met, note: met ? `Meets ${section}.` : `Does not meet ${section}.` };
    });
    return JSON.stringify({ rules, needMore: false });
  }
  const findings = JSON.parse(/Findings: (\[.*\])/.exec(user)?.[1] ?? '[]') as { section: string; met: boolean }[];
  const unmet = findings.filter((rule) => !rule.met);
  const decision = unmet.length === 0 ? 'approve' : unmet.every((rule) => REFERRED.has(rule.section)) ? 'refer' : 'deny';
  const summary =
    decision === 'approve'
      ? `Approve. ${fields.business} meets every rule cited.`
      : `${decision === 'refer' ? 'Refer' : 'Deny'}. ${fields.business} does not meet ${unmet.map((rule) => rule.section).join(', ')}.`;
  return JSON.stringify({ decision, citations: findings.map((rule) => rule.section).slice(0, 6), summary });
}

export function fakeRunModel(input: RunInput, maxBudgetUsd: number = RUN_KEY.maxBudget): RunModel {
  let spent = 0;
  return {
    keyTail: keyTail(`sk-fake-${input.run}`),
    limitUsd: maxBudgetUsd,
    async chat({ model, messages }: ModelCall): Promise<ChatResult> {
      if (spent >= maxBudgetUsd) throw new GatewayError(422, 'budget_exceeded', `Budget has been exceeded! Current cost: ${spent}, Max budget: ${maxBudgetUsd}`);
      const down = (model as string) === 'claude-haiku-5-5-down';
      const served: ModelName = down ? 'gpt-oss-120b' : model;
      const content = answer(messages);
      const inTokens = tokens(messages);
      const outTokens = Math.ceil(content.length / 4);
      const costUsd = Math.round(costOf(served, inTokens, outTokens) * 1e9) / 1e9;
      spent += costUsd;
      return { content, model: served, ...(down && { fallbackFrom: 'claude-haiku-5-5' as ModelName }), inTokens, outTokens, costUsd, ms: (down ? 900 : 0) + 400 + outTokens * 4 };
    },
    async close() {},
  };
}
