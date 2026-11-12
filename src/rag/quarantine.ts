// Retrieved text is data, not instructions (spec R5). screen() flags text
// that addresses the model or tries to decide for it. A flagged chunk is
// still returned and shown, marked quarantined, but never goes into the
// prompt and is never cited.
//
// These patterns catch the obvious. They aren't the defence on their own:
// the engine never puts retrieved text where an instruction goes, and every
// decision rests on cited rules.

export type Screen = { quarantined: boolean; reasons: string[] };

const RULES: { reason: string; pattern: RegExp }[] = [
  { reason: 'tries to override the rules', pattern: /\b(ignore|disregard|forget|bypass)\b[^.]{0,60}\b(rules?|instructions?|limits?|above|previous)\b/i },
  { reason: 'makes a blanket decision', pattern: /\b(approve|deny|reject|grant)\s+(all|every|any|each)\b/i },
  { reason: 'addresses the model', pattern: /\b(note to (the )?(ai|model|assistant|llm)|you are (an? )?(ai|assistant|language model|llm)|as an ai)\b/i },
  { reason: 'orders a decision', pattern: /\byou (must|should|shall) (always |never )?(approve|deny|reject|recommend|grant)\b/i },
  { reason: 'mentions a system prompt', pattern: /\bsystem prompt\b/i },
];

export function screen(text: string): Screen {
  const reasons = RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);
  return { quarantined: reasons.length > 0, reasons };
}
