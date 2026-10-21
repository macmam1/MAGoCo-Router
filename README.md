# MAGoCo Router

**One endpoint. Many upstreams. Zero setup for the free ones.**

MAGoCo Router is a personal AI gateway: a single OpenAI- and Anthropic-compatible
endpoint in front of every provider you can reach — paid accounts, your own
keys, and providers that answer with **no account and no key at all**.

Point Claude Code, Codex, Cursor, Cline, `curl` or your own agent at it and it
routes the request, retries the next healthy upstream when one fails, and
translates the protocol in both directions.

```
client ──▶ /v1/chat/completions ──▶ resolution ──▶ upstream ──▶ translated answer
        ──▶ /v1/messages         ──▶ fallback   ──▶ usage + logs
```

## Why it exists

Most gateways ask you to wire up keys before they do anything. MAGoCo Router
ships with the keyless providers already working, and treats your own keys as
an optional upgrade rather than a prerequisite.

| | |
|---|---|
| **Keyless out of the box** | OpenCode Zen free tier and Pollinations answer with no registration, no key, no card. |
| **One protocol in, any protocol out** | `/v1/chat/completions`, `/v1/messages`, `/v1/responses` — the answer comes back in the protocol the client speaks. |
| **Automatic fallback** | Every request carries a target list. When an upstream 429s, 5xxs or times out, the next one takes over. |
| **Self-syncing registry** | Provider definitions and model catalogues refresh on their own, so the model list is never stale. |
| **Own dashboard** | Console, provider browser, model browser, key management, usage and request logs. |
| **Bring your own anything** | Any OpenAI-compatible endpoint can be added as a connection in two clicks. |

## Quick start

```bash
git clone https://github.com/macmam1/MAGoCo-Router.git
cd MAGoCo-Router
npm install
DATA_DIR=./data PORT=7860 INITIAL_PASSWORD=change-me node server/src/index.js
```

Open <http://localhost:7860/> and sign in with `INITIAL_PASSWORD`.

### Docker

```bash
docker build -t magoco-router .
docker run -p 7860:7860 -v magoco-data:/mnt/workspace/magoco-data \
  -e INITIAL_PASSWORD=change-me magoco-router
```

The image listens on `0.0.0.0:7860` and keeps its database in `DATA_DIR`
(`/mnt/workspace/magoco-data` by default), so it survives redeploys.

## Using it

### Client keys

Create a key in the dashboard (or set `REQUIRE_API_KEY` before the first start
to get a bootstrap key). Send it as `x-magoco-key`, as `Authorization: Bearer
<key>`, or as `?key=<key>`.

```bash
curl http://localhost:7860/v1/chat/completions \
  -H "x-magoco-key: sk-magoco-..." \
  -H "content-type: application/json" \
  -d '{"model":"beam-free","messages":[{"role":"user","content":"hi"}]}'
```

### Model names

Three ways to name a model, all resolved by the same resolver:

```text
beam-free                     a bare model id - the router picks the provider
opencode/beam-free            an explicit provider/model pair
gpt-4o-mini                   a model your own connections provide
```

`GET /v1/models` returns everything that is currently servable.

### Claude Code

```bash
export ANTHROPIC_BASE_URL=https://your-host/v1
export ANTHROPIC_AUTH_TOKEN=sk-magoco-...
```

The gateway speaks the Anthropic Messages API, translates to whichever upstream
is selected, and translates the answer back.

## Routing that survives a broken provider

The important part of a gateway is what happens when an upstream is down.

- **Combos** - a named, ordered list of targets. Use the combo name as the
  model and the router walks the list until one answers.
- **Strategies** - priority, round robin, least used, fill first, random, cost
  optimized and failover.
- **Automatic failover** - a 401, 429, 5xx or a missing model moves the
  request to the next target inside the same request.
- **Circuit breaker** - a provider that fails repeatedly is paused, then
  half-opened and retried.
- **Model lockout** - a model that fails everywhere is paused for a while.
- **Context relay** - the router remembers each conversation. When it has to
  switch to another model, the new model receives a handoff summary of the
  earlier turns, so the thread does not break.

```bash
# a combo is a normal model name
curl http://localhost:7860/v1/chat/completions \
  -H "x-magoco-key: sk-magoco-..." \
  -H "x-magoco-session: my-session" \
  -H "content-type: application/json" \
  -d '{"model":"free-stack","messages":[{"role":"user","content":"hi"}]}'
```

## Usage, cost and health

- calls, tokens, errors, latency percentiles and uptime per provider
- a cost table per provider and model
- a request log, a cache with hit/miss counters
- a timeline per day, a breakdown per key and per model
- CSV export of every event

## Backups

```bash
curl -X POST http://localhost:7860/api/backups -d '{"label":"before the change"}'
curl http://localhost:7860/api/backups                # list
curl -X POST http://localhost:7860/api/backups/<id>/restore
```

A backup is a consistent copy of the whole database. Restoring swaps the
tables back and the running process keeps working.

## Telegram bot

The whole gateway from a chat window: status, models, chat with any model,
combos, keys, providers, usage, health, logs, backups and settings.

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. In the dashboard, open **Telegram**, paste the token and your numeric user
   id, and press *Save & start*.

Only the allow-listed ids can talk to the bot.

| Command | What it does |
|---|---|
| `/status` | health and traffic |
| `/models` | the catalogues that are available |
| `/use <model>` | pick the model for `/chat` |
| `/chat <text>` | talk to the selected model |
| `/combos` `/keys` `/providers` | the configuration |
| `/usage` `/health` `/logs` | the observability |
| `/backup` `/restore <id>` | snapshots |

## Key pool

Some providers are only useful with more than one credential. The pool keeps a
rotating set of keys per provider and takes care of the boring part:

- **detects the provider** from the key format, then confirms it against the
  provider endpoint and one token of real inference - a catalogue endpoint can
  be public, so it cannot prove a key works
- **rotates**: the least recently used healthy key goes first, so no single key
  burns the whole quota
- **quarantines**: a key that is rejected (401/403) is dropped from the
  rotation, a throttled key (429) gets a cooldown
- **stores keys sealed** (AES-256-GCM) and only ever shows them masked

Keys can be pasted, imported from a file, or pulled from a source that
publishes them. The router never uses a key it was not given.

```bash
# add keys
curl -X POST http://localhost:7860/api/keypool/import \
  -H "content-type: application/json" \
  -d "{\"text\":\"sk-...\\nsk-...\"}"

# check them all
curl -X POST http://localhost:7860/api/keypool/validate -d "{}"
```

## Providers

Built in and working without a key:

| Provider | Endpoint | Notes |
|---|---|---|
| **OpenCode Zen** | `https://opencode.ai` | Free tier, no account. The upstream checks client identity headers and an exact tool declaration - the provider module reproduces both. |
| **Pollinations** | `https://gen.pollinations.ai/v1` | Keyless, OpenAI-compatible, no registration. |

Bring-your-own-key providers (Groq, Cerebras, NVIDIA NIM, Cloudflare Workers
AI, Hugging Face, OpenRouter, Mistral, DeepSeek, Gemini, Ollama Cloud, ModelScope,
Zhipu, Cohere, xAI, SambaNova, SiliconFlow, …) live in the same registry and
are one click away in the dashboard.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7860` | Listen port. |
| `HOST` | `0.0.0.0` | Listen address. |
| `DATA_DIR` | `./data` | Where the SQLite database lives. |
| `INITIAL_PASSWORD` | - | Dashboard password on first start. |
| `REQUIRE_API_KEY` | - | Bootstrap client key, accepted even before any key exists in the database. |
| `JWT_SECRET` | derived | Session signing secret. Set it in production. |
| `REGISTRY_URL` | - | Remote registry to merge on top of the built-in one. |
| `REGISTRY_SYNC_INTERVAL` | `3600000` | How often catalogues refresh, in ms. |

## Architecture

```
server/src/
  index.js         HTTP server, routes, request log
  router.js        model resolution, target list, fallback, dispatch
  registry.js      provider definitions + catalogue sync
  providers.js     connection shape, upstream URL building
  auth.js          client keys + dashboard session
  db.js            SQLite schema (journal_mode=DELETE for network storage)
  log.js           request log
  translate/       OpenAI <-> Anthropic <-> Gemini request/response translation
  translate/sse.js SSE aggregation and passthrough
  providers/       provider specific request shaping
web/index.html     the dashboard (single file, no build step)
docs/contract.md   the behavioural contract this implementation was written against
```

The behavioural contract in `docs/contract.md` was extracted from a reference
implementation with reverse-engineering tooling. **This is an independent
implementation** - no code was copied from the reference.

## Development

```bash
npm install
node server/src/index.js            # or: npm start
```

The database is created and migrated on start, so there is no migration step.

## License

MIT - see [LICENSE](LICENSE).
