# oauth-pages

Static OAuth landing site, served from `https://oauth.huangmadsen.com/`.

A bookmarkable phone-friendly home page for **starting** OAuth flows, plus
per-service callback pages that capture the auth code as a JSON payload.

## What's here

```
oauth-pages/
├── public/
│   ├── index.html          # launch page: "Authorize Strava" / "Authorize Schwab" buttons
│   ├── schwab/index.html   # Schwab callback handler — captures code as JSON payload
│   ├── strava/index.html   # Strava callback handler — same pattern
│   ├── style.css
│   └── _headers            # Cloudflare Pages security headers (CSP, no-referrer, etc.)
├── .gitignore
└── README.md
```

## How it works

### Starting an OAuth flow (`/`)

The launch page reads a JS service registry (in `public/index.html`) and renders an
"Authorize" button per service. Each button builds the provider's authorize URL
client-side using `client_id`, `scope`, and `redirect_uri = https://oauth.huangmadsen.com/<slug>`.

Bookmark the launch page on your phone home screen for one-tap re-auth.

### Capturing the callback (`/<service>`)

After the provider redirects back with `?code=...&scope=...`:

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

(Schwab callback payload uses `session` instead of `scopes` since Schwab's redirect carries
a session token rather than scope strings.)

You paste the JSON to the agent (Aria) on the other end, and she runs the
authorization-code → tokens exchange on a host that has the client secret.

## Security model

- **No secrets in this repo.** Pure static HTML/CSS/JS. Public is fine.
- **Auth code is single-use, ~5 min lifetime.** It only matters when paired with the
  client secret, which never lives on this site.
- `_headers` sets:
  - `Content-Security-Policy` (no third-party scripts/connects)
  - `Referrer-Policy: no-referrer` (code can't leak via Referer)
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
- Pages have `<meta name="robots" content="noindex">`.
- Auth code is removed from URL bar via `history.replaceState` after capture.
- The "exchange code for tokens" step happens off-site (currently on Kyle's laptop with
  secrets in `~/.openclaw/credentials/`). Future option: a Cloudflare Worker holding
  the client secret in env vars and storing tokens in Cloudflare KV.

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
| Schwab | `/schwab` | ⏳ Disabled on launch page until callback URI approval lands (Schwab's manual review) |

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
```

The page is identical locally and in production — pure client-side JS.

## Related

- Sister doc: `~/Development/kmadsen/fitness/infra/strava-integration.md`
- Sister doc: `~/Development/kmadsen/stockpot/docs/SCHWAB_AUTH.md`
- Domain plan: `~/Development/kmadsen/fitness/infra/domain-huangmadsen-com.md`
