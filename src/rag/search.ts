import { createHash } from 'node:crypto';
import { bm25Index, bm25Rank, type Bm25 } from './bm25.ts';
import { chunkCode, searchText, tenantOf, type Chunk, type Tenant } from './chunk.ts';
import { screen } from './quarantine.ts';
import { cosine, decodeVector, encodeVector, type Embedder } from './vectors.ts';

// Hybrid search over the city codes (spec docs/superpowers/specs/
// 2026-11-12-ai-platform-rag.md in the Latitude 10 repo): BM25 and vectors,
// fused by reciprocal rank, after filtering to the asking city. The index is
// one JSON file; search is a scan in memory (R1: no vector database for 20
// sections).

export type Source = { file: string; markdown: string };
export type IndexedChunk = Chunk & { vector: string; quarantined: boolean; reasons: string[] };
export type SavedIndex = { version: 1; embedder: string; dim: number; corpus: string; chunks: IndexedChunk[] };

// A hash of the corpus, so a test can tell when the committed index is stale.
export const corpusHash = (sources: Source[]) =>
  createHash('sha256')
    .update([...sources].sort((a, b) => a.file.localeCompare(b.file)).map((source) => `${source.file}\n${source.markdown}`).join('\n---\n'))
    .digest('hex');

export function chunkSources(sources: Source[]): Chunk[] {
  return sources.flatMap((source) => chunkCode(source.markdown, tenantOf(source.file)));
}

export async function buildIndex(sources: Source[], embedder: Embedder): Promise<SavedIndex> {
  const chunks = chunkSources(sources);
  const vectors = await embedder.embed(chunks.map(searchText));
  return {
    version: 1,
    embedder: embedder.name,
    dim: embedder.dim,
    corpus: corpusHash(sources),
    chunks: chunks.map((chunk, i) => ({ ...chunk, vector: encodeVector(vectors[i]!), ...screen(chunk.text) })),
  };
}

export type LoadedIndex = {
  embedder: string;
  chunks: (IndexedChunk & { vec: Float32Array })[];
  bm25: Record<Tenant, Bm25>;
};

export function loadIndex(saved: SavedIndex): LoadedIndex {
  const chunks = saved.chunks.map((chunk) => ({ ...chunk, vec: decodeVector(chunk.vector) }));
  const per = (tenant: Tenant) => bm25Index(chunks.filter((chunk) => chunk.tenant === tenant).map((chunk) => ({ id: chunk.id, text: searchText(chunk) })));
  return { embedder: saved.embedder, chunks, bm25: { 'port-alder': per('port-alder'), 'kestrel-bay': per('kestrel-bay') } };
}

export const RRF_K = 60;

// Reciprocal rank fusion: each list adds 1 / (RRF_K + rank) to an id's
// score, with rank counted from 1.
export function fuse(rankings: string[][]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) ranking.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  return scores;
}

export type Hit = { id: string; section: string; title: string; text: string; score: number; quarantined: boolean; reasons: string[] };

export type SearchOptions = { tenant: Tenant; queryVector: ArrayLike<number>; k?: number };

export function search(index: LoadedIndex, query: string, { tenant, queryVector, k = 5 }: SearchOptions): Hit[] {
  // The city filter comes first (R3): another city's sections are never
  // ranked, so they can't be returned.
  const own = index.chunks.filter((chunk) => chunk.tenant === tenant);
  const byKeyword = bm25Rank(index.bm25[tenant], query).map((hit) => hit.id);
  const byMeaning = own
    .map((chunk) => ({ id: chunk.id, score: cosine(queryVector, chunk.vec) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((hit) => hit.id);
  const scores = fuse([byKeyword, byMeaning]);
  return own
    .map((chunk) => {
      // Screened again at search time, so a chunk changed after indexing is
      // still caught.
      const again = screen(chunk.text);
      const reasons = [...new Set([...chunk.reasons, ...again.reasons])];
      return { id: chunk.id, section: chunk.section, title: chunk.title, text: chunk.text, score: scores.get(chunk.id) ?? 0, quarantined: chunk.quarantined || again.quarantined, reasons };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, k);
}

export async function searchWith(index: LoadedIndex, embedder: Embedder, query: string, options: Omit<SearchOptions, 'queryVector'>): Promise<Hit[]> {
  if (embedder.name !== index.embedder) throw new Error(`The index was built with ${index.embedder}; the query embedder is ${embedder.name}.`);
  const [queryVector] = await embedder.embed([query]);
  return search(index, query, { ...options, queryVector: queryVector! });
}

// The prompt's sources: unquarantined hits only, each in its own block, so
// the model can cite it by id and never mistakes it for an instruction.
export function contextFor(hits: Hit[]): string {
  return hits
    .filter((hit) => !hit.quarantined)
    .map((hit) => `<source id="${hit.id}" section="${hit.section}" title="${hit.title}">\n${hit.text}\n</source>`)
    .join('\n\n');
}

// What the `rag.results` event carries: ids, titles, fused scores and the
// quarantine flag; never the text (the site's events.ts caps titles at 80).
export const toEventChunks = (hits: Hit[]) =>
  hits.slice(0, 8).map((hit) => ({ id: hit.id, title: hit.title.slice(0, 80), score: Math.round(hit.score * 1e4) / 1e4, quarantined: hit.quarantined }));
