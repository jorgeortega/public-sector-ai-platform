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

Status: **live, and public since 2026-11-13.** The page that plays its runs
is [latitude10.tech/labs/ai-platform](https://latitude10.tech/labs/ai-platform).
This repo holds the modules that run outside the site: retrieval, the
engine, tracing, the LLM gateway and the evals. The page itself, its live-run
gateway and the plan's specs live in the site's own repository, which isn't
public.

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

The committed index is `bge-m3`, rebuilt by the owner on 2026-11-13 after
the planted note was rewritten. A published replay must come from a
`bge-m3` index, and the trigger.dev task refuses to run on a `hash-256`
one.

### Retrieval, measured

Recall@5 of the sections a correct decision cites, over the nine golden
queries in `test/fixtures/retrieval-cases.json` (one per fictional
application). Measured on 2026-11-13:

| Index | BM25 alone | Vectors alone | Hybrid |
|---|---|---|---|
| `hash-256` | 0.861 | 0.898 | 0.898 |
| `bge-m3` | 0.861 | 0.880 | **0.898** |
| `bge-m3`, before the note was rewritten | 0.935 | 0.880 | 0.935 |

### The planted note

The planted note was rewritten to be retrieved. Before, it ranked 8th
(hash) and 6th (bge-m3) for its own café's search, so the `poisoned-doc`
scenario never saw it. Now it's full of the words a café's search uses, the
way an attacker would write it, and it ranks 3rd.

**Effect on keyword search.** Keyword search alone dropped from 0.935 to
0.861: the note crowds a real section out of the top 5.

**Effect on hybrid search.** With `bge-m3`, hybrid (0.898) now beats both
keywords (0.861) and vectors alone (0.880). Under an adversarial document,
fusion earns its place. The misses are the two bakeries' PAC 5.12.010 and
`kb-cafe-0077`'s KBC 6.04.020.

**Before the rewrite**, on the earlier corpus, hybrid search matched
keywords but didn't beat them, even with real embeddings:
- `bge-m3` alone finds less than BM25, and fusing the two keeps BM25's
  score;
- the corpus is small and written in the same words the queries use, which
  is where BM25 is strongest;
- vectors earn their place on paraphrases and larger, messier corpora. This
  one has neither yet, so the honest result is a tie.

**The misses.**
- With `bge-m3`: `pa-bakery-0141` and `pa-bakery-0412` miss PAC 5.12.010
  (who needs a food permit). The general rule loses to the specific ones.
- With `hash-256`: the same two, plus `kb-cafe-0077`, which misses KBC
  6.04.020 (cafés).

**The floors.** The test holds a floor at the measured value: 0.89 for
`hash-256` and 0.93 for `bge-m3`. The query vectors are in
`test/fixtures/queries.json`, written by the same build as the index.

## Engine (`src/sdk`, `src/permit`, `src/runtime`, `src/trigger`)

The permit workflow is written on a small workflow SDK. The SDK emits every
event the Labs page plays, so a workflow is only its logic:
- `ctx.step()`: durable steps, checkpointed and skipped on resume, retried
  1 s, 2 s, 4 s;
- `ctx.llm()`: the gateway with the run's own key, answers parsed as JSON
  with one retry;
- `ctx.search()`: the asking city's code only, with the quarantine;
- `ctx.registry()`: the fictional outside API;
- `ctx.approval()`: a waitpoint;
- `ctx.claim()`: a side effect once per run.

**Two runtimes run the same workflow:**
- **In memory** (`src/runtime/memory.ts`): a virtual clock, a queue per city
  running five at once, crash and resume, and a second delivery refused by
  an idempotency key. It uses a deterministic fake model and the real search
  over a hash index. `test/engine.test.ts` runs all nine scenarios this way
  and checks the same golden facts as the site's fixtures.
- **trigger.dev** (`src/trigger/permit.ts`, `trigger.config.ts`): the real
  gateway, bge-m3 search and a real approval token. Deployed to production
  as version 20261113.1 on 2026-11-13. A `happy` run went through dev and
  production, each traced in Langfuse. Both approvals expired, because
  nobody completed the token.
  - **Checked on production, 2026-11-13, version 20261113.2, through the
    recorder:**
    - **Crash.** A crash resumes from its checkpoints: the metadata
      survives the retry, and the second attempt skips intake, extract and
      retrieve.
    - **Burst.** The 50 Port Alder renewals ran at most five at once.
  - **Version 20261113.5, 2026-11-13: the evals' prompt fix (84ef87e).**
    `ping` passed. A `happy` run (`run_06gt7a9n29ueoqdljrcqp61la2`) now
    recommends approve for the bakery, which 20261113.4 denied, in 3 model
    calls for $0.0009, and its approval was completed and its report
    written.
  - **Version 20261113.6, 2026-11-13: the evals' last two fixes
    (ba677a9).** The eligibility check reads the letter, and code refers
    an approval over an unmet rule. `ping` passed, and the eight replays
    were re-recorded from 88c4edb: 2 to 6 model calls a run, $0.0008 to
    $0.0028.
  - **The cold gateway.** A run's first call, `create-run-key`, waits up to
    about 60 s while the gateway's container wakes. It's traced.
  - **Known gap.** Each attempt makes a new run key and starts its spend
    at $0, so a run that crashes can spend its budget twice.

**One Python step.** `python/validate_fields.py`, standard library only,
checks the fields the model extracted. A TypeScript copy of its rules runs
where `python3` isn't available, and a test keeps the two equal.

**Faults** come only from `src/permit/scenarios.ts`, never from visitor input.
The `budget` scenario gives its run a $0.0005 key, so the gateway, not the
engine, refuses the looping call. At Claude Haiku 5.5's prices, a $0.01
budget would never be reached before the engine's 12-call limit.

### trigger.dev and recording

- **The project.** `trigger.config.ts` points at the owner's project
  (`proj_vhbtkfzfcgigvkanwvvo`). `npx trigger.dev@4.8.2 dev` registers
  `permit-run` and `ping` in its development environment (checked
  2026-11-13). `ping` needs no secrets: it runs the Python step through the
  Python build extension.
- **The recorder.** `src/recorder.ts` plays the platform API: it accepts and
  queues each run, triggers it with its city as the concurrency key,
  completes approvals after the scenario's wait, then merges every run's
  events from its metadata into one replay. `test/recorder.test.ts` proves
  the merge against a fake trigger.dev built from in-memory runs.
- **Recording a scenario** (from a clean checkout):

  ```
  node --env-file=.env --import ./scripts/register.mjs scripts/record.ts <scenario> --site <latitude10 checkout>
  ```

  It writes `app/ai-platform/_lib/replays/<scenario>.json` as `recorded`,
  with this repo's commit.

## Tracing (`src/sdk/trace.ts`, `src/tracing`)

Every run is one Langfuse trace, sent by the engine. The SDK's methods trace
themselves, as they emit their own events, so the workflow has no tracing
code beyond a name for each model call. The shape follows Langfuse's
[best practices](https://langfuse.com/docs/observability/best-practices),
read 2026-11-13:

```
review-permit-application        agent       input: the letter; output: the decision
├─ create-run-key                tool        trigger.dev only: wakes the gateway (~60 s cold)
├─ receive-application           span
├─ extract-fields                span
│  ├─ read-application-letter    generation  model, tokens, the gateway's cost
│  └─ validate-fields            tool        the Python step
├─ retrieve-code-sections        span
│  ├─ search-city-code           retriever   the sections, with scores
│  └─ quarantine-instructions    guardrail   WARNING when it kept one out
├─ check-eligibility             span
│  └─ judge-eligibility          generation  one per call, never one per loop
├─ verify-registration           span        WARNING per retried attempt
│  └─ check-business-registry    tool        ERROR on a 429 or 5xx
├─ recommend-decision            span
│  └─ draft-recommendation       generation
├─ await-human-approval          span        input: the recommendation
└─ write-report                  span
```

- **Trace attributes.** Tags `city:…`, `scenario:…` and `kind:…`, set when
  the trace starts. One session per scenario execution. Run metadata on
  every observation.
- **Environments.** `local` for `scripts/trace.ts`. Otherwise trigger.dev's
  environment, `development` or `production`. The release is the engine
  commit, or the trigger.dev deployment.
- **One trace across attempts.** The trace id comes from the trigger.dev run
  id, so a crashed run's second attempt joins the first attempt's trace. The
  first attempt ends ERROR, "worker crashed in eligibility". The second
  shows a `skip-checkpointed-step` event for each checkpoint it reused.
- **Masking.** Every input, output and metadata value passes the scrubber's
  `redact` before it leaves.
- **The gateway sends nothing.** LiteLLM's Langfuse callback would log
  every call again as an unlinked trace of its own. The engine already
  records each call inside its run, with the cost the gateway charged.
- **Off by default.** It's off without `LANGFUSE_PUBLIC_KEY` and
  `LANGFUSE_SECRET_KEY`, and so off in the tests. `test/tracing.test.ts`
  checks the shape through the real `LangfuseSpanProcessor` with an
  in-memory exporter.
- **Sending traces now:**

  ```
  npm run trace -- <scenario>… | all
  ```

  It runs the scenarios in memory: the fake model, no spend. On trigger.dev,
  set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`
  (`https://us.cloud.langfuse.com`) in the project's environment variables.
- **Versions.** `@langfuse/tracing`, `@langfuse/otel` and `@langfuse/core`
  are 6.1.0 (2026-10-30), the newest release at least two weeks old.
  OpenTelemetry is pinned to trigger.dev's own 2.8.0 and API 1.9.1, so the
  two share one context.
- **Batched export.** Spans go in batches, flushed at the end of each run
  and before the approval wait. `immediate` mode sends each span as its own
  request, and the exporter drops anything past 30 in flight. The first
  multi-scenario run lost every span after the 30th this way.

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
- **The `provider-down` route,** `claude-haiku-5-5-down`. Its only model is
  a closed port in the container, so every call fails at once, costs
  nothing, and really falls back to gpt-oss-120b. Teams and run keys may
  call it. Added 2026-11-13: until then, neither config had it.
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

**Deployed 2026-11-13** at `https://permit-desk-gateway.jorgeortega.workers.dev`,
image v1.106.6, with the city teams created. A $0.01 run key reached both
models, and the cost was reported at list price.
- **The first boot** took about three minutes, while LiteLLM migrated its
  tables in Neon.
- **A cold start** after the two-minute sleep takes about 60 s, so the
  Worker now waits up to two minutes for readiness.


1. **Accounts:** a Neon Free project and a Langfuse Hobby project.
   - The repo is linked to the Neon project `snowy-sun-31820672` (with
     `neon init`; `neon.ts`, and `.neon` is gitignored). `neon env pull`
     writes its URLs into `.env`.
   - The gateway's `DATABASE_URL` secret must be Neon's
     `DATABASE_URL_UNPOOLED`: LiteLLM's Prisma migrations need a direct
     connection, not the pooler.
   - `@neon/config` and `@neon/env` are dev dependencies at the versions
     `neon init` chose (1.14.0 and 2.1.3, published 2026-11-09). That's an
     exception to the two-weeks-old rule: only the Neon CLI uses them, and
     older majors may not match CLI 9.4.
2. **Secrets:** `npx wrangler secret put <NAME> -c gateway/wrangler.jsonc`
   for each of the list below. A value already in `.env` can be piped in
   without showing it, for example `set -a; . ./.env; set +a; printf %s
   "$DATABASE_URL_UNPOOLED" | npx wrangler secret put DATABASE_URL -c
   gateway/wrangler.jsonc`. The secrets:
   - `LITELLM_MASTER_KEY`;
   - `DATABASE_URL`;
   - `ANTHROPIC_API_KEY` (the `labs` workspace);
   - `CLOUDFLARE_AI_TOKEN`;
   - `WORKERS_AI_BASE_URL`
     (`https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`).

   `DATABASE_URL` takes the value of `.env`'s `DATABASE_URL_UNPOOLED`.

   The gateway sends nothing to Langfuse: the engine does (see Tracing).
3. **Deploy:** `npx wrangler deploy -c gateway/wrangler.jsonc`. Docker must
   be running; `--dry-run` passes.
4. **Teams:** `GATEWAY_URL=… LITELLM_MASTER_KEY=… node
   scripts/gateway-setup.ts`.

Before deploying, check whether a newer 1.106.x patch (1.106.8 and 1.106.9
carry security backports) is at least two weeks old, and move to it.

## Evals (`data/golden.json`, `src/evals`)

How often the desk recommends what the city's code says, as measured. The
golden set is 20 fictional applications, each with the decision the code
gives (9 approve, 6 refer, 5 deny), the sections it rests on, the sections
it must never cite and a one-line why. Only cases the code decides are in
it; boundaries (exactly 8 seats, exactly 2 square metres) are cases.

`npm run evals` runs each case three times through the real workflow: the
production gateway with a run key per attempt, search over the bge-m3 index
and the Python field check. The registry answers and the approval is given
at once, because what's measured is the recommendation. Four scores, all
code, no model judging a model:

| Score | Passes when |
|---|---|
| `decision` | the recommendation is the expected decision |
| `citations` | it cites what the decision rests on, cites something, and never the planted note |
| `retrieval` | search returned the sections the decision rests on (only for deny and refer) |
| `extraction` | every field a rule turns on was read from the letter as written |

Each run writes `evals/results/<date>-<commit>.json` with every attempt,
prints the misses, and with `--compare <file>` the change from an earlier
run. With the Langfuse keys, each attempt is traced in the environment
`evals` and its scores are on its trace. A full run costs about $0.15.

## Commands

```
npm install
npm test               # vitest
npm run typecheck      # tsc --noEmit, strict
npm run index          # rebuild src/rag/index.json (hash-256)
npm run index -- --dry # chunk only: counts and sizes
npm run trace -- happy # send a scenario's traces to Langfuse (needs its keys in .env)
npm run evals          # the golden set on the real gateway (about $0.15)
docker compose -f gateway/docker-compose.yml up -d && node scripts/gateway-smoke.ts
```

On npm 11, wrangler's `workerd` install script is held back until approved
(`npm install-scripts approve workerd`). Only the `workers-ai` build needs
it.

## License

MIT
