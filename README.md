# oauth-pages

OAuth landing site, served from `https://oauth.huangmadsen.com/`.

A bookmarkable phone-friendly home page for **starting** OAuth flows, plus a
Cloudflare Worker backend for Schwab's short-lived auth-code callback.

## What's here

```
oauth-pages/
├── public/
│   ├── index.html          # launch page: "Authorize Strava" / "Authorize Schwab" buttons
│   ├── strava/index.html   # Strava callback handler — same pattern
│   ├── style.css
│   └── _headers            # Cloudflare Pages security headers (CSP, no-referrer, etc.)
├── oauth-worker/
│   └── index.js            # Schwab server-side exchange + token sync backend
├── wrangler.toml           # Worker routes, Durable Object binding, cron trigger
├── .gitignore
└── README.md
```

## How it works

### Starting an OAuth flow (`/`)

The launch page reads a JS service registry (in `public/index.html`) and renders an
"Authorize" button per service. Strava still builds the provider URL client-side.
Schwab now starts at `/oauth/schwab/start`, which is served by the Worker so it can
mint a one-time state nonce before redirecting to Schwab.

Bookmark the launch page on your phone home screen for one-tap re-auth.

### Capturing the callback (`/<service>`)

Strava still uses the static callback page. After Strava redirects back with
`?code=...&scope=...`:

1. The page parses the URL params
2. Builds a JSON payload combining the code, scopes, state, and a capture timestamp
3. Displays it in a `<pre>` block
4. Provides a **Copy payload** button
5. Calls `history.replaceState` to strip the code from the URL bar (reduces browser-history exposure)

The JSON payload format is:

```json
{
  "service": "strava",
  "code": "abc123…",
  "scopes": ["read", "activity:read_all"],
  "state": null,
  "captured_at": "2026-05-03T04:15:53.955Z"
}
```

You paste the JSON to the agent (Aria) on the other end, and she runs the
authorization-code → tokens exchange on a host that has the client secret.

Schwab does not use that static callback anymore. Schwab redirects to `/schwab`;
the Worker validates the one-time state and exchanges the code with Schwab in the
same request, then stores the encrypted token bundle in a Durable Object.
Stockpot pulls the token bundle outbound with:

```bash
python -m stockpot.portfolio auth sync
```

## Security model

- **No secrets in this repo.** Worker secrets live only in Cloudflare.
- **Schwab auth codes are never rendered to the browser or sent over chat.** They are
  exchanged server-side immediately because Schwab has been observed expiring codes in
  under a minute.
- **Schwab tokens are encrypted at rest** in the Worker Durable Object with `TOKEN_ENC_KEY`.
- **Stockpot sync is outbound-only** from Kyle's machine and protected by Cloudflare
  Access service-token headers.
- `_headers` sets:
  - `Content-Security-Policy` (no third-party scripts/connects)
  - `Referrer-Policy: no-referrer` (code can't leak via Referer)
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
- Pages have `<meta name="robots" content="noindex">`.
- Strava auth code is removed from URL bar via `history.replaceState` after capture.

## Adding a new service

1. **Add a callback page**

   Copy `public/strava/index.html` to `public/<service>/index.html`. The JS only needs
   to know the provider's redirect-param shape; if it's `code` + `scope` + `state` you
   can leave the script as-is. For different params (like Schwab's `session`), adjust
   the payload-building section.

2. **Register the service on the launch page**

   In `public/index.html`, add an entry to the `services` array:

   ```js
   {
     name: 'Service',
     slug: 'service',
     authorizeUrl: 'https://example.com/oauth/authorize',
     clientId: '<your-client-id>',
     scope: 'whatever scopes',
     extraParams: { },         // any provider-specific extras
     description: 'Short label',
     disabled: false,          // true to render as inactive (e.g. waiting on approval)
   }
   ```

3. **Configure the redirect URI with the provider**

   Use `https://oauth.huangmadsen.com/<slug>` exactly. Most providers require
   exact-match registration.

4. **Push to `main`** — Cloudflare Pages auto-deploys (~30 sec).

## Currently registered services

| Service | Slug | Status |
|---|---|---|
| Strava | `/strava` | ✅ Live (client_id `234523`, scopes `read,activity:read_all`) |
| Schwab | `/schwab` | Worker-backed callback; Stockpot sync endpoint at `/api/schwab/token` |

## Hosting

- **Production:** https://oauth.huangmadsen.com/ (Cloudflare Pages, custom domain)
- **`.pages.dev` URL:** https://oauth-pages-b8w.pages.dev/ (auto-generated, not advertised)
- **Auto-deploy:** any push to `main` triggers a build (~30 sec) and replaces production
- **Build config:** framework none, build command empty, output dir `public`

## Local preview

```bash
cd public && python3 -m http.server 8080
# open http://localhost:8080/
# open http://localhost:8080/strava/?code=test123&scope=read,activity:read_all
npm install
npm run dev:worker
```

The static Strava page is identical locally and in production. Schwab requires the
Worker routes plus Cloudflare secrets/bindings.

## Related

- Sister doc: `~/Development/kmadsen/fitness/infra/strava-integration.md`
- Sister doc: `~/Development/kmadsen/stockpot/docs/SCHWAB_AUTH.md`
- Domain plan: `~/Development/kmadsen/fitness/infra/domain-huangmadsen-com.md`
