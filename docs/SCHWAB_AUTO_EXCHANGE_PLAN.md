# Schwab OAuth Auto-Exchange — Implementation Plan

**Status:** APPROVED direction, not yet built (2026-07-07)
**Owner:** Aria (architect/reviewer) + a coding sub-agent for the build
**Repos touched:** `oauth-pages` (this repo), `stockpot`, possibly a new `oauth-worker` package
**Audience:** any future agent picking this up. Read this whole file before writing code.

---

## 1. Problem statement

The current Schwab re-auth flow is a manual clipboard relay:

1. Kyle taps Authorize on his phone, approves at Schwab.
2. Schwab redirects to `https://oauth.huangmadsen.com/schwab` — a **static** Cloudflare
   Pages page (`public/schwab/index.html`).
3. That page shows the auth code packaged as JSON with a Copy button.
4. Kyle pastes the JSON into Telegram to Aria.
5. Aria runs `python -m stockpot.portfolio auth exchange <payload>` on Kyle's box.

**Why it's broken:** on 2026-07-07 Schwab authorization codes were dying in roughly
15-40 seconds. By the time the JSON travels phone → Telegram → agent → exchange, the code
is already expired/used. We burned two codes back-to-back and never renewed the 7-day
refresh token. A human-in-the-loop clipboard step is not a viable auth flow at this code TTL.

**Goal:** Kyle still approves on his phone, but the code is exchanged **server-side within
a second of the redirect**, with no copy/paste and no code ever shown to a human. The 7-day
refresh token gets renewed automatically before it expires so re-auth becomes rare.

---

## 2. Architecture decision (settled)

**Cloudflare Worker is the OAuth backend.** Not clipboard. Not static Pages JS holding the
code. Not an inbound daemon on the home machine.

Rationale:
- Cloudflare is the authentic public HTTPS endpoint already registered with Schwab
  (`https://oauth.huangmadsen.com/schwab`). It is reachable, fixed, and TLS by default.
- The home machine stays **outbound-only** — no inbound port, no exposed service.
- Server-side exchange happens in the same request as the redirect, beating the tiny code TTL.
- Cloudflare Access gates the human-facing admin/start surface; the callback itself is
  protected by a one-time `state` nonce instead of an interactive Access challenge (an Access
  interstitial on the callback can itself burn the short-lived code).

**Trust boundary change:** Cloudflare becomes part of the Schwab secret/token trust boundary.
That is acceptable for a single-owner private Cloudflare account with Worker secrets and
encrypted-at-rest token storage. This is a deliberate, documented tradeoff.

Standards basis:
- OAuth 2.0 Security Best Current Practice — RFC 9700 (hardened auth-code redirect handling,
  one-time `state`, exact redirect URI). https://datatracker.ietf.org/doc/rfc9700/
- Schwab OAuth `authorization_code` flow + exact-match callback requirement.
  https://developer.schwab.com/user-guides/get-started/authenticate-with-oauth
- Cloudflare Durable Objects for serialized, strongly-consistent token state.
  https://developers.cloudflare.com/durable-objects/

---

## 3. Target flow

```
1. Kyle opens /oauth/schwab/start (behind Cloudflare Access) and taps Authorize.
2. Worker mints a one-time `state` (random, ~5 min TTL) stored in a Durable Object,
   then 302-redirects the browser to Schwab's authorize URL with that state.
3. Kyle logs in + approves at Schwab on his phone.
4. Schwab redirects to https://oauth.huangmadsen.com/schwab?code=<CODE>&state=<STATE>.
   This route is served by the WORKER, not the static page.
5. Worker validates state (exists, unused, unexpired), marks it consumed, and IMMEDIATELY
   POSTs the code to Schwab's token endpoint using the client secret (Worker secret).
6. Worker receives access + refresh tokens, encrypts the bundle, stores it in the
   Durable Object with authorized_at / refreshed_at / expires_at / last_error.
7. Worker renders a minimal success/failure page to Kyle's phone. No code, no token shown.
8. Home machine (Stockpot) pulls the current token bundle OUTBOUND via an authenticated
   sync endpoint and writes ~/.openclaw/credentials/schwab_account_tokens.json.
9. A Worker Cron Trigger refreshes the token well before the 7-day refresh window closes,
   so interactive re-auth becomes the exception, not the routine.
```

---

## 4. Components to build

### 4.1 Cloudflare Worker (`oauth-worker/`, new)
- Routes:
  - `GET /oauth/schwab/start` — Access-protected. Mint state, redirect to Schwab.
  - `GET /schwab` — public callback. Validate state, exchange code, store tokens, render result.
    (Keep the exact currently-registered redirect URI `/schwab` for v1. Do NOT change the
    registered URI — that triggers another Schwab manual review.)
  - `GET /api/schwab/token` — Access-service-token protected. Returns current token bundle
    for the home machine to sync. Consider returning only what Stockpot needs.
  - `POST /internal/schwab/refresh` or a Cron Trigger — proactive refresh.
- Storage: **Durable Object** `SchwabTokenStore` (serializes refresh-token rotation; KV's
  eventual consistency is wrong for rotating tokens). Encrypt the bundle at rest with a
  Worker secret key (WebCrypto AES-GCM).
- Secrets (Worker secrets, never in repo):
  - `SCHWAB_ACCOUNT_KEY` (client id)
  - `SCHWAB_ACCOUNT_SECRET` (client secret)
  - `SCHWAB_REDIRECT_URI = https://oauth.huangmadsen.com/schwab`
  - `TOKEN_ENC_KEY` (encryption key for at-rest bundle)
  - Cloudflare Access service token(s) for the sync endpoint.

### 4.2 Cloudflare Access config
- Protect `/oauth/schwab/start` and any `/api/*` admin/sync route with Access.
- Leave `/schwab` callback reachable without an interactive challenge; protect it via
  one-time `state` + immediate single-use exchange.

### 4.3 Stockpot sync path (`stockpot`)
- New subcommand: `python -m stockpot.portfolio auth sync`
  - Calls `GET /api/schwab/token` with an Access service token (from `secrets.env`).
  - Writes/refreshes `~/.openclaw/credentials/schwab_account_tokens.json` atomically.
- Keep existing `auth exchange` as a manual fallback for break-glass.
- Update the two keepalive crons: prefer `auth sync` (pull fresh tokens from the Worker)
  over local-only `auth refresh`, so the Worker remains the source of truth for rotation.

### 4.4 oauth-pages (this repo)
- Replace the static `public/schwab/index.html` copy/paste page with the Worker-backed
  callback, OR keep a thin static success page the Worker redirects to after exchange.
- Update `README.md` security model section: code is exchanged server-side; no JSON paste.

---

## 5. Security requirements (do not skip)
- No secrets in any repo. Worker secrets only. `.gitignore` stays strict.
- No auth code, access token, refresh token, or client secret ever rendered to the browser
  or logged. Success page shows status only.
- One-time `state`: random >=128-bit, single-use, short TTL, bound to the Durable Object.
- Exact redirect URI match; do not alter the registered `/schwab` URI in v1.
- Token bundle encrypted at rest (AES-GCM via WebCrypto) with `TOKEN_ENC_KEY`.
- Sync endpoint requires Cloudflare Access service token; least-privilege response body.
- Audit trail in the Durable Object: authorized_at, refreshed_at, expires_at, last_error.
- Home machine stays outbound-only; no inbound service.

---

## 6. Build phases

- **Phase 0 — scaffold:** create `oauth-worker/` (Wrangler project), wire route + custom
  domain `oauth.huangmadsen.com`, deploy a no-op `/schwab` that echoes "ok" (no exchange).
  Verify Cloudflare Pages vs Worker routing does not collide on `/schwab`.
- **Phase 1 — server-side exchange:** implement state mint on `/oauth/schwab/start`,
  validate + single-use consume on `/schwab`, POST code to Schwab, store encrypted bundle in
  the Durable Object. Success/fail page. Test end-to-end with a real Schwab approval.
- **Phase 2 — home sync:** `auth sync` subcommand + `/api/schwab/token` with Access service
  token. Confirm Stockpot writes the token file and `auth status` reports access_valid.
- **Phase 3 — proactive refresh:** Worker Cron Trigger refreshes before the 7-day window
  closes; alert (Telegram via existing failure-alert path) only when interactive re-auth is
  truly required.
- **Phase 4 — cutover + cleanup:** repoint keepalive crons to `auth sync`, retire the JSON
  copy/paste page, update `SCHWAB_AUTH.md` and this repo's README.

**Definition of done:** Kyle taps Authorize on his phone, approves at Schwab, sees a success
page, and does nothing else. Within seconds the home machine has fresh tokens and
`python -m stockpot.portfolio auth status` reports `access_valid: true`. No code is ever
copied. Refresh token renews automatically and re-auth is rare.

---

## 7. Open implementation choices (only these are undecided)
- **Durable Object vs D1** for the token store. Leaning Durable Object for serialized refresh
  rotation; D1 acceptable if we add explicit locking. KV rejected (eventual consistency).
- **Pull vs push** to the home machine. Leaning pull (`auth sync`, outbound-only) to keep the
  home machine with zero inbound surface. Push would require an inbound endpoint — rejected
  unless there's a strong reason.
- **Callback host**: keep everything on the Worker vs a thin static success page the Worker
  redirects to. Cosmetic; decide during Phase 1.

---

## 8. Current real-world facts (grounding for the builder)
- Registered Schwab redirect URI: `https://oauth.huangmadsen.com/schwab` (exact match).
- Client id in use (public, not secret): `3xeCWPdocdG5UF1cCrRbhmp37WMt3ZZ7`.
- Existing static site repo: `kmadsen/oauth-pages`, Cloudflare Pages, output dir `public`,
  auto-deploy on push to `main`. `.pages.dev`: `oauth-pages-b8w.pages.dev`.
- Stockpot CLI already implements the exchange:
  `python -m stockpot.portfolio auth {url,status,exchange,refresh}` and accepts a bare code,
  a full redirect URL, or the oauth-pages JSON payload.
- Token file target: `~/.openclaw/credentials/schwab_account_tokens.json`; secrets in
  `~/.openclaw/credentials/secrets.env` (`SCHWAB_ACCOUNT_KEY/SECRET/REDIRECT_URI/TOKEN_STORE_PATH`).
- Schwab market-data app is a separate `client_credentials` app and is NOT part of this flow.
- Two keepalive crons exist (every-20-min refresh + weekday market-hours keepalive) plus a
  daily refresh-token-expiry warning cron. These are the things to repoint in Phase 4.

## 9. Related docs
- `~/Development/kmadsen/stockpot/docs/SCHWAB_AUTH.md` (auth architecture + CLI reference)
- `oauth-pages/README.md` (current static-site security model — to be updated at cutover)
