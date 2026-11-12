import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The extracted fields' check (spec E6): python/validate_fields.py when
// python3 is here, and the same rules in TypeScript when it isn't.

export const SCRIPT = fileURLToPath(new URL('../../python/validate_fields.py', import.meta.url));

const ZONE = /^[A-Z]{1,3}-\d{1,2}$/;
const RANGES: Record<string, [number, number]> = {
  staff: [0, 500],
  signSquareMetres: [0, 20],
  outdoorSeats: [0, 200],
  largestEventGuests: [0, 5000],
};

export function problemsTs(fields: Record<string, unknown>): string[] {
  const found: string[] = [];
  if (typeof fields.business !== 'string' || !fields.business.trim()) found.push('business: missing');
  const zone = fields.zone;
  if (typeof zone !== 'string' || !ZONE.test(zone)) found.push(`zone: ${typeof zone === 'string' ? `'${zone}'` : String(zone)} is not a zone code`);
  for (const [name, [low, high]] of Object.entries(RANGES)) {
    if (!(name in fields) || fields[name] === null || fields[name] === undefined) continue;
    const value = fields[name];
    if (typeof value !== 'number') found.push(`${name}: not a number`);
    else if (value < low || value > high) found.push(`${name}: ${value} is outside ${low} to ${high}`);
  }
  return found;
}

export function validateFields(fields: Record<string, unknown>, python = 'python3'): { problems: string[]; via: 'python' | 'typescript' } {
  const result = spawnSync(python, [SCRIPT], { input: JSON.stringify(fields), encoding: 'utf8', timeout: 10_000 });
  if (result.status === 0 && result.stdout) {
    const { problems } = JSON.parse(result.stdout) as { problems: string[] };
    return { problems, via: 'python' };
  }
  return { problems: problemsTs(fields), via: 'typescript' };
}
