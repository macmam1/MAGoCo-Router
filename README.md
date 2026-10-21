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
to get a bootstrap key). Send it as `x-9router-key`, as `Authorization: Bearer
<key>`, or as `?key=<key>`.

```bash
curl http://localhost:7860/v1/chat/completions \
  -H "x-9router-key: sk-magoco-..." \
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
