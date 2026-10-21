# Landscape - what the best AI gateways do, and what MAGoCo Router takes

Extracted with REA (`rea-agents`, from `github.com/morluto/rea`) and from the
projects' own published catalogues.

## The programs that matter

| Project | Stars | What it is | How it was read here |
|---|---|---|---|
| **The leading gateway** | 79k | Free AI gateway, 375 providers, 20 routing strategies, MCP server, Electron app | `llm.txt` + repository tree (`docs/`, `src/domain/`, `src/lib/`) |
| **The second gateway** | 38k | Stacked free tiers, 34 providers, desktop + server | REA static analysis of the shipped client, evidence `ev_f8dc0b5860714f35b4077853f61ac08fc98ea205bda555a0742415a2f8070868` (213 parsed files, 3,164 graph nodes, 81,234 semantic nodes, `integrity_contradictions: []`) |
| **the reference implementation** | - | The reference implementation this project was written against | REA bundle analysis, evidence `ev_d0f37dcb75e73b1338b9a35e0a3cd86d8a2356a651d32dd081b5fadf703c070a` (`docs/contract.md`) |
| **awesome-free-llm-apis** | - | Curated catalogue of permanent free tiers | README tables |
| **ClawLabsAI/free-ai-models** | - | Daily-ranked free models with base URLs and key requirements | README table |
| **OmniCopilot** | 134 | 1200+ models in Copilot Chat | README |
| **quantum-free-router** | 55 | Shell-only zero-cost router | README |

## Feature inventory

### The leading gateway

- 375 providers, 4-tier fallback (Subscription -> API Key -> Cheap -> Free)
- **20 routing strategies**: priority, weighted, round-robin, fill-first, p2c,
  random, least-used, cost-optimized, reset-aware, reset-window, headroom,
  quota-weighted, strict-random, auto, lkgp, context-optimized,
  cache-optimized, context-relay, fusion, pipeline
- **3-layer resilience**: provider circuit breaker / connection cooldown /
  model lockout
- Semantic cache with hit/miss headers, idempotency window
- Combos (ordered fallback chains) with 4 templates and an auto-combo engine
  scoring 16 factors
- Cost rules per provider/model, quota cache, model availability checks
- Provider credential expiry, lockout policy, config audit
- Dashboard: 50+ sections (analytics, health, costs, limits, cache, logs,
  audit, combos, auto-combo, CLI tools, agents, playground, media, search
  tools, memory, skills, translator, settings, onboarding, API manager)
- 67 UI languages, 7 colour themes, MCP server with 110 tools, A2A v0.3
- Protocol surface: OpenAI (chat, models, embeddings, images, audio, video,
  music, moderations, rerank, search), Anthropic messages + count_tokens,
  OpenAI Responses, Gemini v1beta, Ollama, MCP, A2A, ACP

### The second gateway (REA-derived)

Pages: Agents, Analytics, Audio, Decision, Embeddings, Fallback, Fusion, Image,
Keys, Logs, Media, Model detail, Playground, Premium, Search, Video.

API surface worth stealing:

- `/api/analytics/{summary,timeline,by-model,by-client,by-key,by-platform,
  errors,error-distribution,search,requests}`
- `/api/fallback/{routing,penalty-inspector,quota-forecast,rate-limit-usage,
  token-usage}` - a routing decision engine with a penalty inspector
- `/api/keys/{id}/cooldowns`, `/api/keys/{id}/reveal`
- `/api/cache/stats`, `/api/compression/{preview,stats}`
- `/api/backups/{id,download,restore,schedule,tables}`
- `/api/client-profiles/{id,rotate}` - one profile per client, with rotation
- `/api/health/check-all`, `/api/health/check/{id}`
- `/api/decisions/models`, `/api/decisions/try` - a "which model should I use"
  decision engine

## What MAGoCo Router takes from that

Implemented here, in this order of value:

1. **Combos** - named ordered fallback chains, usable as a model name.
2. **Routing strategies** - priority, round-robin, least-used, fill-first,
   random, cost-optimized.
3. **Circuit breaker** per connection and **model lockout** per model.
4. **Cost tracking** with a price table, per provider and model.
5. **Response cache** with hit/miss counters and a dashboard.
6. **Rate limits** per client key, with `Retry-After`.
7. **Model aliases**.
8. **Health metrics**: uptime, latency percentiles, breaker state.
9. **Embeddings** on the protocol surface.

Deliberately not taken: the 110-tool MCP server, A2A/ACP, memory and skills
systems, cloud agents, TLS fingerprint spoofing, OAuth provider flows. Those
are large subsystems that need a desktop app, an OAuth client and a secrets
vault - out of scope for a personal gateway that has to stay small enough to
read in one sitting.

## Sources

- REA evidence ids are recorded in `docs/contract.md` and above.
- Peer README catalogues are kept in the working directory, not in the repo.
