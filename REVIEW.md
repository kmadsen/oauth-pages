# Preservation review — 2026-10-10

The Worker implementation is useful continuation work but is not ready to merge
into the deployed site. Keep it on `kmadsen/schwab-worker-review` until the following
are fixed and covered by isolated tests:

- Bind the authorization state nonce to the browser that starts the flow (for
  example a Secure, HttpOnly, SameSite cookie). A stored one-time nonce alone does
  not establish that the callback belongs to this browser.
- Make nonce consumption atomic; the current read/check/write sequence has no
  explicit transaction protecting concurrent callbacks.
- Serialize token refresh/read/write operations. Scheduled and manual refreshes
  currently read and replace independently, so rotated tokens can be overwritten.
  Preserve refresh-token metadata if a refresh response omits it.
- Await asynchronous route handlers inside the top-level try/catch; returning a
  rejected promise bypasses its error response handling.
- Handle the no-stored-token result in manual refresh without dereferencing null,
  validate successful token response fields, and test malformed provider responses.
- Verify actual Durable Object storage options and route configuration, including
  `/internal/schwab/refresh`, in a local Worker runtime before deployment.

Review only: no deployment, token exchange, scheduled refresh, or account request
was executed. The accompanying public-page change must stay with this branch until
the backend is ready; it points the launch button at the new Worker start route.
