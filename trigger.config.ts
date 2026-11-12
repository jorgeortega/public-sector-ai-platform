import { pythonExtension } from '@trigger.dev/python/extension';
import { defineConfig } from '@trigger.dev/sdk';

// The permit desk's trigger.dev project (engine spec). Its environment holds
// GATEWAY_URL, LITELLM_MASTER_KEY, WORKERS_AI_BASE_URL and CLOUDFLARE_AI_TOKEN
// for permit-run; `ping` needs none. The Python extension ships
// python/validate_fields.py (standard library only, so no requirements file).
export default defineConfig({
  project: 'proj_vhbtkfzfcgigvkanwvvo',
  dirs: ['./src/trigger'],
  maxDuration: 900,
  build: {
    extensions: [pythonExtension({ scripts: ['./python/**/*.py'] })],
  },
});
