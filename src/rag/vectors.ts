import { tokenize } from './bm25.ts';

// The vector half of hybrid search: an embedder, cosine similarity, and a
// compact encoding for the committed index. Two embedders (spec R4):
// Workers AI's bge-m3, the real one, and hash-256, an offline stand-in for
// tests and development that the index names, so a published run can refuse
// it.

export type Embedder = { name: string; dim: number; embed: (texts: string[]) => Promise<number[][]> };

export const BGE_M3 = '@cf/baai/bge-m3';
export const HASH_DIM = 256;

// FNV-1a, 32-bit.
const fnv = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

export const normalize = (vector: number[]) => {
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
};

// Feature hashing of words and word pairs: similar wording lands in similar
// buckets. It has no sense of meaning (that's bge-m3's job), but it's
// deterministic and needs no account.
export function hashEmbed(text: string): number[] {
  const tokens = tokenize(text);
  const features = [...tokens, ...tokens.slice(1).map((token, i) => `${tokens[i]} ${token}`)];
  const vector = new Array<number>(HASH_DIM).fill(0);
  for (const feature of features) {
    const hash = fnv(feature);
    vector[hash % HASH_DIM]! += hash & 0x80000000 ? -1 : 1;
  }
  return normalize(vector);
}

export const hashEmbedder: Embedder = {
  name: 'hash-256',
  dim: HASH_DIM,
  embed: async (texts) => texts.map(hashEmbed),
};

// bge-m3 through a Workers AI binding (the build script gets one from
// wrangler's proxy). Batches of 8, as in the LangGraph lab.
export function workersAiEmbedder(ai: Ai, batchSize = 8): Embedder {
  return {
    name: BGE_M3,
    dim: 1024,
    embed: async (texts) => {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const result = (await ai.run(BGE_M3 as never, { text: texts.slice(i, i + batchSize) } as never)) as unknown as { data: number[][] };
        out.push(...result.data.map(normalize));
      }
      return out;
    },
  };
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const encodeVector = (vector: ArrayLike<number>) => Buffer.from(Float32Array.from(vector).buffer).toString('base64');

export function decodeVector(text: string): Float32Array {
  const bytes = Buffer.from(text, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
