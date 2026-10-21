# Behavioural contract

The reference implementation (9Router, Apache-2.0) was inspected as a shipped
artifact - the deployed JavaScript bundle was captured and statically analysed -
to derive the contract this implementation targets. This document records what
was extracted, so the contract stays explicit instead of implicit in a diff.

## Method

* the client bundle of the deployed application was captured and analysed with
  the REA JavaScript application analyser (`analyze-javascript-application`)
* the endpoint surface was resolved from the captured sources: 46 distinct
  `/api/...` paths with their HTTP methods
* the protocol surface was read off the bundle: which header carries the client
  key, which cookie carries the dashboard session, which query parameters are
  accepted as fallbacks

## Client authentication

The gateway in front of the studio strips `Authorization`, so the reference
implementation accepts the client key through several channels. MAGoCo Router
accepts, in this order:

1. `x-9router-key: <key>`
2. `Authorization: Bearer <key>`
3. `?api_key=<key>` / `?key=<key>` (query fallback)

Key shape: `sk-magoco-<48 hex chars>`.

## Dashboard session

* `POST /api/auth/login` with `{"password": "..."}` sets an `auth_token`
  httpOnly cookie holding an HS256 JWT
* the session is validated with the same secret in every bundle: `JWT_SECRET`
  from the environment, mirrored into the persistent `jwt-secret` file so a
  bundle that cannot see the runtime environment still verifies the token
* `GET /api/auth/status` reports `authenticated`

## Public endpoints (no session)

```
GET /api/health          -> { ok: true, ... }
GET /api/version         -> { currentVersion, latestVersion, hasUpdate }
GET /api/providers/registry
```

## Dashboard endpoints (session required)

```
GET    /api/keys
POST   /api/keys
DELETE /api/keys/{id}
GET    /api/providers
POST   /api/providers
DELETE /api/providers/{id}
GET    /api/settings
PATCH  /api/settings
GET    /api/usage/request-logs
```

## LLM endpoints (client key required)

```
POST /v1/chat/completions
POST /v1/messages
GET  /v1/models
```

## Model identifiers

The reference implementation exposes models as `provider/model`. A bare model name
is resolved against the provider catalogues; a combo name resolves to an ordered
member list that is tried until one upstream answers.

## Translation

The reference implementation translates between the OpenAI, Anthropic and Gemini
wire formats in both directions. MAGoCo Router implements:

* OpenAI client -> OpenAI / Anthropic / Gemini upstream
* Anthropic client -> any upstream, answer translated back to `message` shape
* Gemini client -> any upstream, answer translated back to `candidates` shape

Content blocks, tool calls, stop reasons and usage counters are mapped.

## Deployment constraints observed

These are properties of the ModelScope gateway, measured rather than assumed:

| observation | consequence |
|---|---|
| a request with `Sec-Fetch-Dest: document` is answered with a 302 to the studio page | the edge proxy strips `sec-fetch-*` before forwarding |
| a request carrying `Authorization` is rejected with "does not support direct access via SDK Token" | the edge proxy moves the bearer token to `x-9router-key` |
| the value of the `_rsc` query parameter is emptied | Next.js answers a client-side navigation with a 307; the edge proxy resolves that redirect itself |
| the response body of an error status is emptied and the response is held for ~6s | the dashboard therefore keeps its session in a cookie and never relies on the error body |
| `process.env` is inlined at build time in the proxy bundle | the session secret is mirrored into a file so both bundles agree |
| `DATA_DIR` is an object-storage FUSE mount | the database runs with `journal_mode=DELETE`; a large WAL would force every lookup to re-scan it |

## Deliberate omissions

The reference implementation also provides OAuth provider logins, an MITM proxy,
Tailscale tunnels, tool-output compression and quota scraping. They are not part
of this contract yet; the router core (auth, routing, fallback, translation,
usage) is.
