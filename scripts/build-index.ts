// Chunk, screen and embed the city codes into src/rag/index.json.
//
//   npm run index                            # hash-256: offline, for tests and development
//   npm run index -- --dry                   # chunk only: counts and sizes
//   npm run index -- --embedder workers-ai   # bge-m3 on Workers AI, through wrangler's
//                                            # proxy of the AI binding (wrangler.jsonc),
//                                            # on the account wrangler is logged in to
//
// The corpus is about 6,000 characters (under 2,000 tokens), and the nine
// golden queries are written to test/fixtures/queries.json with the same
// model: a fraction of a cent on Workers AI. Only the owner runs the
// workers-ai build.
import { readFileSync, writeFileSync } from 'node:fs';
import { searchText } from '../src/rag/chunk.ts';
import { buildIndex, chunkSources } from '../src/rag/search.ts';
import { readSources } from '../src/rag/sources.ts';
import { encodeVector, hashEmbedder, workersAiEmbedder, type Embedder } from '../src/rag/vectors.ts';

const sources = readSources();
const chunks = chunkSources(sources);
const chars = chunks.reduce((n, chunk) => n + searchText(chunk).length, 0);
console.log(`${sources.length} files, ${chunks.length} chunks, ${chars} characters (about ${Math.round(chars / 4)} tokens)`);
if (process.argv.includes('--dry')) process.exit(0);

const which = process.argv[process.argv.indexOf('--embedder') + 1];
const out = new URL('../src/rag/index.json', import.meta.url);

// The golden queries, embedded by the same model, so the tests can measure
// retrieval with the index's own embedder (test/fixtures/queries.json).
const cases = (JSON.parse(readFileSync(new URL('../test/fixtures/retrieval-cases.json', import.meta.url), 'utf8')) as { cases: { application: string; query: string }[] }).cases;
const queriesOut = new URL('../test/fixtures/queries.json', import.meta.url);

async function write(embedder: Embedder) {
  const index = await buildIndex(sources, embedder);
  writeFileSync(out, `${JSON.stringify(index, null, 1)}\n`);
  const vectors = await embedder.embed(cases.map((c) => c.query));
  const queries = Object.fromEntries(cases.map((c, i) => [c.application, encodeVector(vectors[i]!)]));
  writeFileSync(queriesOut, `${JSON.stringify({ embedder: embedder.name, queries }, null, 1)}\n`);
  const quarantined = index.chunks.filter((chunk) => chunk.quarantined).map((chunk) => chunk.id);
  console.log(`src/rag/index.json: ${index.chunks.length} chunks × ${index.dim} dimensions (${index.embedder}); quarantined: ${quarantined.join(', ') || 'none'}`);
}

if (process.argv.includes('--embedder') && which === 'workers-ai') {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy<{ AI: Ai }>();
  try {
    await write(workersAiEmbedder(proxy.env.AI));
  } finally {
    await proxy.dispose();
  }
} else {
  await write(hashEmbedder);
}
