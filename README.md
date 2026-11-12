# public-sector-ai-platform

**The permit desk:** a small AI platform for permit reviews, built in the
open for [Latitude 10 Labs](https://latitude10.tech/labs). Two fictional
cities, Port Alder and Kestrel Bay, send permit applications through:
- durable workflows;
- an LLM gateway;
- retrieval over their municipal codes;
- a human approval.

Every step is recorded as an event that the Labs page animates.

> The cities, their codes, the businesses and the applications don't exist.
> Nothing here has legal force.

Status: **in progress, private.** The plan and specs are in the Latitude 10
repo, under `docs/superpowers/specs/2026-11-1*-ai-platform-*.md`. This repo
holds the modules that run outside the site; so far, those are `rag` and
`llm-gateway`.

## Retrieval (`src/rag`)

Hybrid search over the city codes in `data/code/`.

- **Chunks.** One per section (`## PAC 5.12.010 Title`); a long section is
  split at its paragraphs. Each chunk keeps its city.
- **The city filter comes first.** `search()` drops every other city's
  chunks before ranking, so a Port Alder query can't return a Kestrel Bay
  section. Isolation is part of the query, not a check on the answer.
- **BM25 and vectors, fused by reciprocal rank** (`1 / (60 + rank)` from
  each list). Keywords win on section numbers and terms of art ("C-2", "food
  handler certificate"); vectors win on paraphrases ("tables outside on the
  pavement").
- **No vector database.** About 20 chunks fit in one JSON file
  (`src/rag/index.json`), and a scan in memory takes well under a
  millisecond. A vector store is something you add when the corpus needs
  one, not because the product uses AI.
- **Retrieved text is data.**
  - `screen()` flags text that addresses the model or tries to decide for
    it.
  - A flagged chunk is still returned and shown, marked quarantined, but
    `contextFor()` leaves it out of the prompt and it's never cited.
  - Chunks are screened when indexed and again when searched.
  - `data/code/kestrel-bay-notes.md` plants one on purpose: a "reviewer
    note" telling the model to approve all cafés.
  - The patterns catch the obvious; the real defence is that retrieved text
    never sits where an instruction goes.

### Embedders

The index names the embedder that built it, and a query must use the same
one:

| Embedder | What it is | Build |
|---|---|---|
| `@cf/baai/bge-m3` | Workers AI, 1,024 dimensions, the real one | `npm run index -- --embedder workers-ai`, through wrangler's proxy of the AI binding (`wrangler.jsonc`), on the logged-in account. The corpus is under 2,000 tokens. |
| `hash-256` | Feature hashing of words and word pairs: deterministic, offline, no sense of meaning | `npm run index` |

The committed index is `bge-m3`, built on 2026-11-13 by the owner's
`workers-ai` run. A published replay must come from a `bge-m3` index.

### Retrieval, measured

Recall@5 of the sections a correct decision cites, over the nine golden
queries in `test/fixtures/retrieval-cases.json` (one per fictional
application). Measured on 2026-11-13:

| Index | BM25 alone | Vectors alone | Hybrid |
|---|---|---|---|
| `hash-256` | 0.935 | 0.898 | 0.898 |
| `bge-m3` | | | waiting for the query vectors (below) |

With the hash stand-in, hybrid is no better than keywords alone. That's
expected: hash vectors only see shared words, which BM25 already sees
better. The point of the vector half is meaning, which only bge-m3 brings.

The misses with `hash-256`:
- `pa-bakery-0141` and `pa-bakery-0412` miss PAC 5.12.010 (who needs a food
  permit);
- `kb-cafe-0077` misses KBC 6.04.020 (cafés).

The test holds a floor of 0.89 for `hash-256` and 0.95 for `bge-m3`.

The `bge-m3` row waits for the nine golden queries' vectors.
- **Why they're needed.** A query must be embedded by the index's own
  model, so the build now writes them to `test/fixtures/queries.json` as
  well.
- **Until then.** The recall test is skipped and says why in its title.
- **What fills it.** One more run of `npm run index -- --embedder
  workers-ai`.

## LLM gateway (`gateway/`, `src/gateway`)

Every model call goes through the LiteLLM proxy, pinned at
`ghcr.io/berriai/litellm-non_root:v1.106.6`.

- **Two teams, one per city,** each with $2.50 every 30 days: this lab's $5
  a month.
- **A key per run,** in its city's team, with `max_budget` $0.01 and a one
  hour life. A looping agent is stopped by the gateway, not by our own code.
  LiteLLM checks a budget before each call, so the last allowed call can go
  a little past it.
- **Claude Haiku 5.5, falling back to gpt-oss-120b** on Workers AI. A
  response that fell back carries `x-litellm-attempted-fallbacks`, and every
  response carries its cost in `x-litellm-response-cost`.
- **Prices set in the config** from the providers' price lists (read
  2026-11-13), so spend never depends on what this LiteLLM version knows.
  `test/gateway.test.ts` checks both configs against `src/gateway/config.ts`.
- **Hosting.** A Cloudflare Container, behind a small Worker
  (`gateway/worker.ts`):
  - one Durable Object owns one container;
  - it starts on the first request and sleeps after two minutes idle;
  - only the OpenAI and admin routes the engine uses are forwarded.
- **LiteLLM's admin UI.** It still serves at `/ui` in this version, even with
  `DISABLE_ADMIN_UI`, so the Worker's route allowlist is what keeps it
  unreachable.
- **The database** is Neon Free Postgres.

### Proved locally

`docker compose -f gateway/docker-compose.yml up -d` runs the pinned LiteLLM,
Postgres and a fake upstream that fails on request. Then `node
scripts/gateway-smoke.ts` checks, with no provider and no spend:
- the two teams exist;
- a run key's call reports its exact cost;
- a failing primary falls back to gpt-oss-120b, at gpt-oss-120b's price;
- the gateway refuses with `budget_exceeded` once the run's $0.01 is spent.

The last run, on 2026-11-13, passed all four. It refused at $0.0102, the
first time.

### Deploying (owner)

1. **Accounts:** a Neon Free project (its connection string is
   `DATABASE_URL`) and a Langfuse Hobby project.
2. **Secrets:** `npx wrangler secret put <NAME> -c gateway/wrangler.jsonc`
   for each of:
   - `LITELLM_MASTER_KEY`;
   - `DATABASE_URL`;
   - `ANTHROPIC_API_KEY` (the `labs` workspace);
   - `CLOUDFLARE_AI_TOKEN`;
   - `WORKERS_AI_BASE_URL`
     (`https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`);
   - `LANGFUSE_PUBLIC_KEY`;
   - `LANGFUSE_SECRET_KEY`;
   - `LANGFUSE_HOST`.
3. **Deploy:** `npx wrangler deploy -c gateway/wrangler.jsonc`. Docker must
   be running; `--dry-run` passes.
4. **Teams:** `GATEWAY_URL=… LITELLM_MASTER_KEY=… node
   scripts/gateway-setup.ts`.

Before deploying, check whether a newer 1.106.x patch (1.106.8 and 1.106.9
carry security backports) is at least two weeks old, and move to it.

## Commands

```
npm install
npm test               # vitest
npm run typecheck      # tsc --noEmit, strict
npm run index          # rebuild src/rag/index.json (hash-256)
npm run index -- --dry # chunk only: counts and sizes
docker compose -f gateway/docker-compose.yml up -d && node scripts/gateway-smoke.ts
```

On npm 11, wrangler's `workerd` install script is held back until approved
(`npm install-scripts approve workerd`). Only the `workers-ai` build needs
it.

## License

MIT
