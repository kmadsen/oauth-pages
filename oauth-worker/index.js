const TEXT_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
};

const STATE_TTL_MS = 5 * 60 * 1000;
const TOKEN_PATH = "/api/schwab/token";
const TOKEN_ENDPOINT = "/oauth/token";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/oauth/schwab/start") {
        return startSchwabAuth(request, env);
      }
      if (request.method === "GET" && url.pathname === "/schwab") {
        return handleSchwabCallback(request, env);
      }
      if (request.method === "GET" && url.pathname === TOKEN_PATH) {
        return handleTokenSync(request, env);
      }
      if (request.method === "POST" && url.pathname === "/internal/schwab/refresh") {
        return handleManualRefresh(request, env);
      }
      return new Response("not found", { status: 404, headers: TEXT_HEADERS });
    } catch (error) {
      if (error instanceof HttpError) {
        return new Response(error.message, { status: error.status, headers: TEXT_HEADERS });
      }
      const message = error instanceof Error ? error.message : "unexpected error";
      return renderPage("Schwab auth failed", message, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshStoredToken(env));
  },
};

export class SchwabTokenStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/state/create") {
      const state = randomToken(32);
      await this.state.storage.put(`state:${state}`, {
        created_at: new Date().toISOString(),
        expires_at_ms: Date.now() + STATE_TTL_MS,
        consumed: false,
      }, { expirationTtl: Math.ceil(STATE_TTL_MS / 1000) });
      return json({ state });
    }

    if (request.method === "POST" && url.pathname === "/state/consume") {
      const body = await request.json();
      const state = String(body.state || "");
      const key = `state:${state}`;
      const record = await this.state.storage.get(key);
      if (!record) return json({ ok: false, reason: "unknown_state" }, 400);
      if (record.consumed) return json({ ok: false, reason: "state_already_used" }, 400);
      if (record.expires_at_ms <= Date.now()) return json({ ok: false, reason: "state_expired" }, 400);
      record.consumed = true;
      record.consumed_at = new Date().toISOString();
      await this.state.storage.put(key, record, { expirationTtl: 60 });
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/tokens") {
      const tokens = await request.json();
      await putEncrypted(this.state.storage, this.env, "tokens", tokens);
      await this.state.storage.put("metadata", {
        authorized_at: tokens.authorized_at || null,
        refreshed_at: tokens.refreshed_at || null,
        expires_at: tokens.expires_at || null,
        refresh_expires_at: tokens.refresh_expires_at || null,
        last_error: null,
        updated_at: new Date().toISOString(),
      });
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/tokens") {
      const tokens = await getEncrypted(this.state.storage, this.env, "tokens");
      if (!tokens) return json({ ok: false, reason: "no_tokens" }, 404);
      return json({ ok: true, tokens });
    }

    if (request.method === "GET" && url.pathname === "/metadata") {
      return json(await this.state.storage.get("metadata") || {});
    }

    if (request.method === "POST" && url.pathname === "/error") {
      const body = await request.json();
      const metadata = await this.state.storage.get("metadata") || {};
      metadata.last_error = {
        at: new Date().toISOString(),
        context: body.context || "unknown",
        message: body.message || "unknown error",
      };
      await this.state.storage.put("metadata", metadata);
      return json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  }
}

async function startSchwabAuth(request, env) {
  requireEnv(env, ["SCHWAB_ACCOUNT_KEY", "SCHWAB_REDIRECT_URI", "SCHWAB_AUTH_BASE_URL"]);
  const store = tokenStore(env);
  const stateResp = await store.fetch("https://store/state/create", { method: "POST" });
  const { state } = await stateResp.json();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.SCHWAB_ACCOUNT_KEY,
    redirect_uri: env.SCHWAB_REDIRECT_URI,
    state,
  });
  return Response.redirect(`${env.SCHWAB_AUTH_BASE_URL}/oauth/authorize?${params.toString()}`, 302);
}

async function handleSchwabCallback(request, env) {
  requireEnv(env, [
    "SCHWAB_ACCOUNT_KEY",
    "SCHWAB_ACCOUNT_SECRET",
    "SCHWAB_REDIRECT_URI",
    "SCHWAB_AUTH_BASE_URL",
    "TOKEN_ENC_KEY",
  ]);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return renderPage("Schwab auth failed", "Missing authorization code.", 400);
  if (!state) return renderPage("Schwab auth failed", "Missing state nonce.", 400);

  const store = tokenStore(env);
  const consume = await store.fetch("https://store/state/consume", {
    method: "POST",
    body: JSON.stringify({ state }),
  });
  if (!consume.ok) {
    const data = await consume.json().catch(() => ({}));
    return renderPage("Schwab auth failed", `Invalid state: ${data.reason || consume.status}.`, 400);
  }

  const tokens = await exchangeCode(env, code);
  tokens.authorized_at = new Date().toISOString();
  await store.fetch("https://store/tokens", {
    method: "POST",
    body: JSON.stringify(tokens),
  });

  return renderPage(
    "Schwab authorized",
    "The code was exchanged server-side and the read-only token bundle is ready for Stockpot sync.",
    200,
  );
}

async function handleTokenSync(request, env) {
  requireAccessServiceToken(request, env);
  const resp = await tokenStore(env).fetch("https://store/tokens");
  if (!resp.ok) return json({ ok: false, reason: "no_tokens" }, 404);
  const { tokens } = await resp.json();
  return json({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || null,
    expires_at: tokens.expires_at,
    refresh_expires_at: tokens.refresh_expires_at || null,
    token_type: tokens.token_type || "Bearer",
    scope: tokens.scope || null,
    authorized_at: tokens.authorized_at || null,
    refreshed_at: tokens.refreshed_at || null,
  });
}

async function handleManualRefresh(request, env) {
  requireAccessServiceToken(request, env);
  const tokens = await refreshStoredToken(env);
  return json({ ok: true, expires_at: tokens.expires_at, refresh_expires_at: tokens.refresh_expires_at || null });
}

async function refreshStoredToken(env) {
  requireEnv(env, [
    "SCHWAB_ACCOUNT_KEY",
    "SCHWAB_ACCOUNT_SECRET",
    "SCHWAB_AUTH_BASE_URL",
    "TOKEN_ENC_KEY",
  ]);
  const store = tokenStore(env);
  const loaded = await store.fetch("https://store/tokens");
  if (!loaded.ok) return null;
  const { tokens } = await loaded.json();
  if (!tokens.refresh_token) {
    await recordError(env, "refresh", "No refresh token available.");
    return null;
  }
  try {
    const refreshed = await refreshToken(env, tokens.refresh_token);
    refreshed.authorized_at = tokens.authorized_at || null;
    refreshed.refreshed_at = new Date().toISOString();
    await store.fetch("https://store/tokens", {
      method: "POST",
      body: JSON.stringify(refreshed),
    });
    return refreshed;
  } catch (error) {
    await recordError(env, "refresh", error instanceof Error ? error.message : "refresh failed");
    throw error;
  }
}

async function exchangeCode(env, code) {
  return tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: env.SCHWAB_REDIRECT_URI,
  });
}

async function refreshToken(env, refreshToken) {
  return tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function tokenRequest(env, form) {
  const body = new URLSearchParams(form);
  const resp = await fetch(`${env.SCHWAB_AUTH_BASE_URL}${TOKEN_ENDPOINT}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.SCHWAB_ACCOUNT_KEY}:${env.SCHWAB_ACCOUNT_SECRET}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const text = await resp.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_error) {
    data = {};
  }
  if (!resp.ok) {
    throw new Error(`Schwab token endpoint failed with HTTP ${resp.status}`);
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: now + Number(data.expires_in || 0),
    refresh_expires_at: data.refresh_token_expires_in
      ? now + Number(data.refresh_token_expires_in)
      : null,
    token_type: data.token_type || "Bearer",
    scope: data.scope || null,
  };
}

function tokenStore(env) {
  const id = env.SCHWAB_TOKEN_STORE.idFromName("schwab-account");
  return env.SCHWAB_TOKEN_STORE.get(id);
}

function requireAccessServiceToken(request, env) {
  requireEnv(env, ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"]);
  const id = request.headers.get("cf-access-client-id");
  const secret = request.headers.get("cf-access-client-secret");
  if (id !== env.CF_ACCESS_CLIENT_ID || secret !== env.CF_ACCESS_CLIENT_SECRET) {
    throw new HttpError("unauthorized", 401);
  }
}

function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`missing Worker configuration: ${missing.join(", ")}`);
  }
}

async function recordError(env, context, message) {
  await tokenStore(env).fetch("https://store/error", {
    method: "POST",
    body: JSON.stringify({ context, message }),
  });
}

async function putEncrypted(storage, env, key, value) {
  const { ciphertext, iv } = await encryptJson(env.TOKEN_ENC_KEY, value);
  await storage.put(key, { ciphertext, iv, v: 1 });
}

async function getEncrypted(storage, env, key) {
  const record = await storage.get(key);
  if (!record) return null;
  return decryptJson(env.TOKEN_ENC_KEY, record);
}

async function encryptJson(secret, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    ciphertext: base64Encode(new Uint8Array(encrypted)),
    iv: base64Encode(iv),
  };
}

async function decryptJson(secret, record) {
  const key = await importAesKey(secret);
  const iv = base64Decode(record.iv);
  const ciphertext = base64Decode(record.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

async function importAesKey(secret) {
  const raw = secret.startsWith("base64:")
    ? base64Decode(secret.slice("base64:".length))
    : new TextEncoder().encode(secret);
  const material = await crypto.subtle.digest("SHA-256", raw);
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function randomToken(bytes) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes) {
  return base64Encode(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64Encode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64Decode(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function renderPage(title, detail, status) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#0a0a0a;color:#f5f5f5;display:grid;min-height:100vh;place-items:center;padding:24px}
main{max-width:560px}
h1{font-size:32px;margin:0 0 12px}
p{color:#c9c9c9;line-height:1.5}
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>`, { status, headers: TEXT_HEADERS });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
