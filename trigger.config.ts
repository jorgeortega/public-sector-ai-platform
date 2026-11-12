import { pythonExtension } from '@trigger.dev/python/extension';
import { defineConfig } from '@trigger.dev/sdk';

// The permit desk's trigger.dev project (engine spec). The project ref and the
// environment variables (GATEWAY_URL, LITELLM_MASTER_KEY, WORKERS_AI_BASE_URL,
// CLOUDFLARE_AI_TOKEN) are the owner's; the Python extension ships
// python/validate_fields.py (standard library only, so no requirements file).
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? 'proj_set_me',
  dirs: ['./src/trigger'],
  maxDuration: 900,
  build: {
    extensions: [pythonExtension({ scripts: ['./python/**/*.py'] })],
  },
});
