// Node resolves `./events` only with its extension; the event files are
// copied byte for byte from the site (SCHEMA_HASH), which imports without
// one. This hook retries an extensionless relative import as `.ts`.
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
}

// The engine imports its JSON (the applications, the index) without
// `with { type: 'json' }`, as trigger.dev's bundler and Vitest take it; a
// script under plain Node gets the attribute added here.
export async function load(url, context, next) {
  if (url.endsWith('.json') && context.importAttributes?.type !== 'json') return next(url, { ...context, importAttributes: { ...context.importAttributes, type: 'json' } });
  return next(url, context);
}
