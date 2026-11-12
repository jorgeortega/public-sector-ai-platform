// BM25 over the chunks of one city: the keyword half of hybrid search. It
// wins on section numbers and terms of art ("C-2", "food handler
// certificate"), where embeddings blur.

export const K1 = 1.2;
export const B = 0.75;

const STOP = new Set(
  'a an and are as at be by can do does for from has have if in into is it its may must my not of on or our so than that the their them then there these they this to up was we what when where which who will with without you your'.split(' '),
);

// Lower case, accents folded (café → cafe), simple plural folding, and
// compound tokens kept whole as well as in parts: "C-2" gives "c-2", "c"
// and "2"; "5.12.010" gives itself and its parts.
export function tokenize(text: string): string[] {
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const out: string[] = [];
  for (const match of folded.matchAll(/[a-z0-9]+(?:[.-][a-z0-9]+)*/g)) {
    const word = match[0];
    const parts = /[.-]/.test(word) ? [word, ...word.split(/[.-]/)] : [word];
    for (const part of parts) {
      if (STOP.has(part)) continue;
      if (part.length < 2 && !/\d/.test(part)) continue;
      out.push(singular(part));
    }
  }
  return out;
}

// English plurals, roughly: bakeries → bakery, businesses → business,
// seats → seat; short words and "-ss" words stay as they are.
export function singular(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) return word.slice(0, -1);
  return word;
}

export type Bm25 = {
  docs: { id: string; length: number; tf: Map<string, number> }[];
  df: Map<string, number>;
  avgLength: number;
};

export function bm25Index(docs: { id: string; text: string }[]): Bm25 {
  const df = new Map<string, number>();
  const indexed = docs.map(({ id, text }) => {
    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1);
    return { id, length: tokens.length, tf };
  });
  const avgLength = indexed.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, indexed.length);
  return { docs: indexed, df, avgLength };
}

// Docs that share at least one term with the query, best first.
export function bm25Rank(index: Bm25, query: string): { id: string; score: number }[] {
  const n = index.docs.length;
  const terms = [...new Set(tokenize(query))];
  return index.docs
    .map((doc) => {
      let score = 0;
      for (const term of terms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const df = index.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / index.avgLength));
      }
      return { id: doc.id, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
