// Dad's Claude relay (Cloudflare Worker).
// Serves the site from ./public and forwards chat requests to the Claude API with the
// API key kept here as a secret, so no key ever reaches a browser.
//
// Secrets (set with `wrangler secret put`, never committed):
//   ANTHROPIC_API_KEY  the Claude API key, ideally in its own Console workspace with a spend limit
//   ACCESS_TOKENS      comma-separated invite tokens; remove one to cut off that link

const MODELS = new Set(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
const FIELDS = new Set(["model", "max_tokens", "system", "messages", "thinking", "output_config", "cache_control", "fallbacks", "stream"]);
const BETAS = new Set(["server-side-fallback-2026-07-01"]);
const BLOCK_TYPES = new Set(["text", "image", "thinking", "redacted_thinking", "fallback"]);
const EFFORTS = new Set(["low", "medium", "high"]);
const PASS_HEADERS = ["content-type", "request-id", "retry-after", "x-should-retry"];
const MAX_BODY = 30 * 1024 * 1024;

const apiError = (status, type, message) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", "x-should-retry": "false", "cache-control": "no-store" },
  });

async function digest(s) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function tokenOk(token, list) {
  if (!token || !list) return false;
  const t = await digest(token);
  let ok = false;
  for (const candidate of list.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (crypto.subtle.timingSafeEqual(t, await digest(candidate))) ok = true;
  }
  return ok;
}

// Only the request shape the site sends is let through, so a leaked link can't be used
// for anything but plain chat with the four listed models.
function checkBody(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "Request body must be a JSON object.";
  for (const k of Object.keys(b)) if (!FIELDS.has(k)) return `Field not allowed: ${k}`;
  if (!MODELS.has(b.model)) return "That model isn't available here.";
  if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1 || b.max_tokens > 64000) return "max_tokens out of range.";
  if (b.stream !== true) return "Only streaming requests are allowed.";
  if (b.system !== undefined && typeof b.system !== "string") return "system must be a string.";
  if (b.thinking !== undefined && b.thinking?.type !== "adaptive") return "thinking must be adaptive.";
  if (b.output_config !== undefined && (Object.keys(b.output_config).some((k) => k !== "effort") || !EFFORTS.has(b.output_config.effort))) return "Invalid output_config.";
  if (b.cache_control !== undefined && (b.cache_control?.type !== "ephemeral" || Object.keys(b.cache_control).length !== 1)) return "Invalid cache_control.";
  if (b.fallbacks !== undefined && b.fallbacks !== "default") return "Invalid fallbacks.";
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 2000) return "Invalid messages.";
  for (const m of b.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return "Invalid message role.";
    if (typeof m.content === "string") continue;
    if (!Array.isArray(m.content)) return "Invalid message content.";
    for (const block of m.content) {
      if (!block || !BLOCK_TYPES.has(block.type)) return `Content type not allowed: ${block?.type}`;
      if (block.type === "image" && block.source?.type !== "base64") return "Images must be uploaded, not linked.";
    }
  }
  return null;
}

async function relay(request, env, path) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() || request.headers.get("x-api-key") || "";
  if (!(await tokenOk(token, env.ACCESS_TOKENS))) return apiError(401, "authentication_error", "This invite link isn't valid.");
  if (!env.ANTHROPIC_API_KEY) return apiError(500, "api_error", "The relay has no API key configured.");

  const upstream = (env.UPSTREAM || "https://api.anthropic.com").replace(/\/$/, "");
  const version = request.headers.get("anthropic-version");
  const headers = {
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": /^\d{4}-\d{2}-\d{2}$/.test(version || "") ? version : "2026-10-21",
  };

  let init;
  if (path === "/v1/models" && request.method === "GET") {
    init = { method: "GET", headers };
    path = "/v1/models?limit=1";
  } else if (path === "/v1/messages" && request.method === "POST") {
    if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return apiError(413, "request_too_large", "Message too large.");
    const raw = await request.text();
    if (raw.length > MAX_BODY) return apiError(413, "request_too_large", "Message too large.");
    let body;
    try { body = JSON.parse(raw); } catch { return apiError(400, "invalid_request_error", "Body is not valid JSON."); }
    const problem = checkBody(body);
    if (problem) return apiError(400, "invalid_request_error", problem);
    const betas = (request.headers.get("anthropic-beta") || "").split(",").map((s) => s.trim()).filter((s) => BETAS.has(s));
    if (betas.length) headers["anthropic-beta"] = betas.join(",");
    headers["content-type"] = "application/json";
    init = { method: "POST", headers, body: raw };
  } else {
    return apiError(404, "not_found_error", "Not found.");
  }

  let res;
  try {
    res = await fetch(upstream + path, init);
  } catch {
    return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "Couldn't reach the Claude API." } }), { status: 502, headers: { "content-type": "application/json" } });
  }
  const out = new Headers({ "cache-control": "no-store" });
  for (const h of PASS_HEADERS) { const v = res.headers.get(h); if (v) out.set(h, v); }
  return new Response(res.body, { status: res.status, headers: out });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return relay(request, env, url.pathname.slice(4));
    return env.ASSETS.fetch(request);
  },
};
