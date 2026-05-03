# oauth-pages

Static OAuth callback landing pages, served from `https://oauth.huangmadsen.com/`.

When an OAuth provider (Schwab, Strava, etc.) redirects back to us with an auth `code`, the matching landing page captures the code and gives Kyle two ways to send it back to Aria:

1. Big **Copy** button (always works)
2. **Open Telegram** button to switch over and paste

Auth code is single-use and expires in minutes — no value to leak it; the page never stores it anywhere.

## Layout

```
oauth-pages/
├── public/
│   ├── index.html        # landing index (lists supported services)
│   ├── schwab/index.html # Schwab callback handler
│   ├── strava/index.html # Strava callback handler
│   └── style.css
├── _headers              # Cloudflare Pages security headers
└── README.md
```

## Adding a new service

1. Create `public/<service>/index.html` (copy from `schwab/` or `strava/`)
2. Update the service param in JS (just for display label — the page is service-agnostic)
3. Push to main; Cloudflare Pages auto-deploys
4. Register the new redirect URI with the provider:
   - `https://oauth.huangmadsen.com/<service>`

That's it.

## Hosted at

- **Production:** https://oauth.huangmadsen.com/
- **Preview deploys:** Cloudflare auto-creates `<branch>.oauth-pages.pages.dev` URLs for branches

## Local preview

```bash
cd public && python3 -m http.server 8080
# open http://localhost:8080/schwab/?code=test123&state=xyz
```

The page works identically locally and in production — pure client-side JS.
