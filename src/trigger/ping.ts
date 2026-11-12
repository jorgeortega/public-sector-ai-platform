import { python } from '@trigger.dev/python';
import { task } from '@trigger.dev/sdk';

// Proves the project runs: the task starts, and the Python step answers
// through the Python build extension. Needs no gateway and no secrets.
export const ping = task({
  id: 'ping',
  run: async () => {
    const fields = { business: 'Sunrise Bakery', zone: 'C-2', staff: 4 };
    const result = await python.runScript('./python/validate_fields.py', [JSON.stringify(fields)]);
    return { ok: true, node: process.version, python: result.exitCode === 0 ? (JSON.parse(result.stdout) as { problems: string[] }) : { error: result.stderr.slice(0, 200) } };
  },
});
