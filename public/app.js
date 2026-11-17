// Dad's Claude — a personal Claude chat.
// The browser never holds a Claude API key: requests go to this site's own /api relay
// (src/worker.js), which checks the device's invite token and adds the key server-side.
import Anthropic from "./vendor/anthropic-sdk-1.8.0.min.mjs";

/* ------------------------------------------------------------------ */
/* Models and prices                                                   */
/* Anthropic API list prices, US$ per million tokens. Checked against  */
/* platform.claude.com/docs/en/about-claude/pricing on 16 Nov 2026.    */
/* ------------------------------------------------------------------ */
const PRICES_CHECKED = "16 November 2026";

const MODELS = [
  {
    id: "claude-fable-5-2", name: "Fable 5.2", family: "fable", badge: "Most capable",
    blurb: "Anthropic's most powerful model. For the hardest questions: deep analysis, tricky problems and big decisions. Slower, and the priciest.",
    in: 8, out: 40, cacheWrite: 10, cacheRead: 0.20, fallbacks: true,
  },
  {
    id: "claude-opus-5-5", name: "Opus 5.5", family: "opus", badge: "Recommended",
    blurb: "A brilliant all-rounder: careful, thorough and smart. A great default for almost anything.",
    in: 4, out: 20, cacheWrite: 5, cacheRead: 0.20, fallbacks: true,
  },
  {
    id: "claude-sonnet-5-5", name: "Sonnet 5.5", family: "sonnet", badge: "Great value",
    blurb: "Fast and very capable, for half the price of Opus. Ideal for everyday questions, writing and advice.",
    in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.10, fallbacks: true,
  },
  {
    id: "claude-haiku-5-5", name: "Haiku 5.5", family: "haiku", badge: "Fastest & cheapest",
    blurb: "Quick answers to simple things: facts, definitions, short rewrites. Costs a tiny fraction of a cent.",
    in: 0.10, out: 0.50, cacheWrite: 0.125, cacheRead: 0.01, fallbacks: false,
    long: { over: 100000, in: 0.50, out: 2.50, cacheWrite: 0.625, cacheRead: 0.05 },
  },
];
const DEFAULT_MODEL = "claude-opus-5-5";

// If a model declines a request, the API can hand it to one of these (server-side fallback).
// Listed only so those replies are priced and named correctly.
const OTHER_MODELS = {
  "claude-opus-5": { name: "Opus 5", family: "opus", in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-opus-4-8": { name: "Opus 4.8", family: "opus", in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  "claude-sonnet-5": { name: "Sonnet 5", family: "sonnet", in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.20 },
};

// "Typical reply" used for the friendly estimates: ~1,000 tokens in and ~1,000 out (about 750 words each way).
const TYPICAL = { in: 1000, out: 1000 };

const EFFORT = {
  low: { label: "Quick", help: "Quick: short thinking. Fastest and cheapest, good for simple questions." },
  medium: { label: "Balanced", help: "Balanced: a good mix of speed, quality and cost. Recommended for most things." },
  high: { label: "Thorough", help: "Thorough: thinks longer for better answers to hard questions. Slower, and costs more." },
};

const modelById = (id) => MODELS.find((m) => m.id === id);
const priceFor = (id) => modelById(id) || OTHER_MODELS[id] || null;
const prettyModel = (id) => priceFor(id)?.name || id || "Claude";
const familyOf = (id) => priceFor(id)?.family || "opus";

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */
const store = {
  get(k, d) { try { const v = localStorage.getItem("dc." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("dc." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem("dc." + k); } catch { /* storage unavailable */ } },
};

const S = {
  access: store.get("access", ""),
  model: store.get("model", DEFAULT_MODEL),
  effort: store.get("effort", "medium"),
  name: store.get("name", "Dad"),
  budget: Number(store.get("budget", 200)) || 200,
  spent: Number(store.get("spent", 0)) || 0,
};
if (!modelById(S.model)) S.model = DEFAULT_MODEL;
if (!EFFORT[S.effort]) S.effort = "medium";

// Chats live in IndexedDB (photos make them too big for localStorage). Falls back to memory.
const db = (() => {
  const mem = new Map();
  let opening = null;
  const open = () => opening ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open("dads-claude", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("chats", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  const run = async (mode, fn) => {
    const d = await open();
    if (!d) return null;
    return new Promise((resolve, reject) => {
      const t = d.transaction("chats", mode);
      const req = fn(t.objectStore("chats"));
      t.oncomplete = () => resolve(req?.result ?? null);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    async all() { try { return (await run("readonly", (s) => s.getAll())) ?? [...mem.values()]; } catch { return [...mem.values()]; } },
    async put(chat) { mem.set(chat.id, chat); try { await run("readwrite", (s) => s.put(chat)); } catch (e) { console.warn("save failed", e); } },
    async del(id) { mem.delete(id); try { await run("readwrite", (s) => s.delete(id)); } catch { /* ignore */ } },
    async clear() { mem.clear(); try { await run("readwrite", (s) => s.clear()); } catch { /* ignore */ } },
  };
})();

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const usd2 = (v) => "$" + (Math.max(0, v)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function costStr(v) {
  if (!v) return "$0.00";
  if (v < 0.0001) return "<$0.0001";
  if (v < 0.01) return "$" + v.toFixed(4);
  if (v < 1) return "$" + v.toFixed(3);
  return usd2(v);
}
function rateStr(v) {
  if (Number.isInteger(v)) return "$" + v;
  return "$" + v.toFixed(3).replace(/0$/, "");
}
function centsStr(v) {
  const c = v * 100;
  if (c < 1) return c.toFixed(2) + "¢";
  if (c < 10) return c.toFixed(1) + "¢";
  return Math.round(c) + "¢";
}
const roundSig = (n, d = 2) => { if (n <= 0) return 0; const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - d + 1)); return Math.round(n / p) * p; };
const tokStr = (n) => n >= 10000 ? Math.round(n / 1000) + "K" : n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
const typicalCost = (m) => (TYPICAL.in * m.in + TYPICAL.out * m.out) / 1e6;
function dateStr(ts) {
  const d = new Date(ts), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

const ICON = {
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  alert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  bulb: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
  map: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="14" rx="3"/><circle cx="12" cy="13" r="3.5"/><path d="M8 6l1.5-2h5L16 6"/></svg>',
};

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */
let mdReady = false;
function setupMarkdown() {
  if (!window.marked || !window.DOMPurify) return;
  // Raw HTML in a reply is shown as text, never parsed. DOMPurify below is a second line of defence.
  window.marked.use({ gfm: true, breaks: false, renderer: { html: (t) => esc(typeof t === "string" ? t : t?.text ?? "") } });
  window.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
  });
  mdReady = true;
}
function renderMarkdown(text) {
  if (!mdReady) return "<p>" + esc(text).replace(/\n/g, "<br>") + "</p>";
  const html = window.DOMPurify.sanitize(window.marked.parse(text), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "form", "input", "button", "textarea", "select", "video", "audio", "iframe"],
  });
  return html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
}

/* ------------------------------------------------------------------ */
/* Cost                                                                */
/* ------------------------------------------------------------------ */
// usage.iterations lists every attempt (including a fallback model's) with its own model and tokens.
function costOf(usage, requestedId) {
  if (!usage) return { cost: 0, tokens: 0 };
  const parts = Array.isArray(usage.iterations) && usage.iterations.length ? usage.iterations : [usage];
  let cost = 0, tokens = 0;
  for (const it of parts) {
    const base = priceFor(it.model) || priceFor(requestedId) || modelById(DEFAULT_MODEL);
    const input = it.input_tokens || 0, cw = it.cache_creation_input_tokens || 0, cr = it.cache_read_input_tokens || 0, out = it.output_tokens || 0;
    const r = base.long && input + cw + cr > base.long.over ? base.long : base;
    cost += (input * r.in + cw * r.cacheWrite + cr * r.cacheRead + out * r.out) / 1e6;
    tokens += input + cw + cr + out;
  }
  return { cost, tokens };
}
// For a reply the user stopped: input is known from message_start, output is estimated from length.
function estimatePartial(snap, requestedId) {
  if (!snap) return { cost: 0, tokens: 0 };
  const chars = (snap.content || []).reduce((n, b) => n + (b.text?.length || 0) + (b.thinking?.length || 0), 0);
  const usage = { ...snap.usage, iterations: null, model: snap.model, output_tokens: Math.max(snap.usage?.output_tokens || 0, Math.ceil(chars / 4)) };
  return costOf(usage, requestedId);
}
function addSpend(v) {
  S.spent = Math.round((S.spent + (v || 0)) * 1e6) / 1e6;
  store.set("spent", S.spent);
  renderSpend();
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
// The invite token is sent where the SDK would send an API key; the relay swaps it for the real key.
// dangerouslyAllowBrowser only silences the SDK's browser warning: no real key is in the browser.
function makeClient(token = S.access) {
  return new Anthropic({ apiKey: token, baseURL: location.origin + "/api", dangerouslyAllowBrowser: true, maxRetries: 2 });
}

// Invite links look like https://…/?invite=TOKEN. The token stays in the address so that
// "Add to Home Screen" (which has its own storage on iPhone) keeps working.
const TOKEN_RE = /(?:^|[?#&])invite=([A-Za-z0-9_-]{16,200})/;
function readInvite(text) {
  const m = TOKEN_RE.exec(text || "") || /^\s*([A-Za-z0-9_-]{32,200})\s*$/.exec(text || "");
  return m ? m[1] : "";
}
function takeInviteFromUrl() {
  const token = readInvite(location.search) || readInvite(location.hash);
  if (token && token !== S.access) { S.access = token; store.set("access", token); }
}

function systemPrompt() {
  const name = (S.name || "").trim() || "the user";
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return [
    `You are Claude, chatting with ${name} in a personal chat app that a family member set up for them. They use it on a phone and on a laptop.`,
    "Be warm, clear and practical. Use plain language and briefly explain any technical term you need. Keep replies reasonably short unless asked for more detail: short paragraphs, with headings, lists or tables only when they make the answer easier to read on a small screen. If a question is ambiguous, make a sensible assumption and say what you assumed, or ask one short clarifying question. For medical, legal or money matters, give genuinely useful information and suggest a professional when the stakes are high.",
    `Today's date is ${today}.`,
  ].join("\n\n");
}

const apiHistory = (chat) => chat.messages.filter((m) => !m.excluded).map((m) => ({ role: m.role, content: m.content }));

function buildParams(model, chat) {
  const params = {
    model: model.id,
    max_tokens: 64000,
    system: systemPrompt(),
    messages: apiHistory(chat),
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: S.effort },
    cache_control: { type: "ephemeral" }, // caches the conversation so each follow-up re-reads it at a discount
  };
  if (model.fallbacks) {
    // If this model declines (safety classifiers), the API retries on Anthropic's recommended model.
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }
  return params;
}

// After a model hand-off mid-reply, only text and the hand-off marker may be sent back from before the marker.
function echoSafe(content) {
  const lastFallback = content.map((b) => b.type).lastIndexOf("fallback");
  if (lastFallback < 0) return content;
  return content.filter((b, i) => i >= lastFallback || b.type === "text" || b.type === "fallback");
}

function describeError(err, model) {
  const apiMsg = err?.error?.error?.message || err?.message || String(err);
  if (err instanceof Anthropic.AuthenticationError) return { msg: "This device's invite link has stopped working. Ask for a new link and open it here.", action: null };
  if (err instanceof Anthropic.PermissionDeniedError) return { msg: `This API key isn't allowed to use ${model.name}. Try a different model.`, action: "models" };
  if (err instanceof Anthropic.NotFoundError) return { msg: `${model.name} isn't available on this account. Try a different model.`, action: "models" };
  if (err instanceof Anthropic.RateLimitError) return { msg: "That's a lot of messages in a short time. Wait a minute, then try again.", action: "retry" };
  if (err instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(apiMsg)) return { msg: "The API account has run out of credit. It can be topped up in the Claude Console.", action: null };
    return { msg: "Claude couldn't accept that message: " + apiMsg, action: "retry" };
  }
  if (err instanceof Anthropic.APIError && err.status === 413) return { msg: "That message is too large. Try fewer or smaller photos.", action: null };
  if (err instanceof Anthropic.InternalServerError) return { msg: `${model.name} is very busy right now. Try again in a moment, or pick another model.`, action: "retry" };
  if (err instanceof Anthropic.APIConnectionError) return { msg: "Couldn't reach Claude. Check the internet connection and try again.", action: "retry" };
  return { msg: "Something went wrong: " + apiMsg, action: "retry" };
}

/* ------------------------------------------------------------------ */
/* App state                                                           */
/* ------------------------------------------------------------------ */
let chats = [];
let current = null;          // the open chat (null = fresh, unsaved)
let pending = [];            // photos waiting to be sent: { block }
let busy = false;
let activeStream = null;
let stoppedByUser = false;
let stick = true;            // keep scrolled to the bottom while a reply streams
const coarse = matchMedia("(pointer: coarse)").matches;

const el = {
  app: $("app"), sidebar: $("sidebar"), scrim: $("scrim"), thread: $("thread"), scroller: $("scroller"),
  input: $("input"), composer: $("composer"), sendBtn: $("sendBtn"), attachBtn: $("attachBtn"), fileInput: $("fileInput"),
  attachments: $("attachments"), hint: $("composerHint"), chatList: $("chatList"),
  modelBtn: $("modelBtn"), modelDot: $("modelDot"), modelBtnName: $("modelBtnName"), modelBtnPrice: $("modelBtnPrice"),
  modelsDialog: $("modelsDialog"), settingsDialog: $("settingsDialog"), modelCards: $("modelCards"),
  priceTable: $("priceTable"), priceFootnote: $("priceFootnote"), pricesAsOf: $("pricesAsOf"),
  spendNums: $("spendNums"), spendFill: $("spendFill"), spendLeft: $("spendLeft"), spendMeter: $("spendMeter"),
  brandName: $("brandName"), toast: $("toast"),
};

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */
function brand() {
  const n = (S.name || "").trim();
  return n ? `${n}'s Claude` : "My Claude";
}

function renderHeader() {
  const m = modelById(S.model);
  el.modelDot.className = "dot " + m.family;
  el.modelBtnName.textContent = m.name;
  el.modelBtnPrice.textContent = `${rateStr(m.in)} in · ${rateStr(m.out)} out`;
  el.brandName.textContent = brand();
  document.title = brand();
  renderHint();
}

function renderHint() {
  const m = modelById(S.model);
  const left = Math.max(0, S.budget - S.spent);
  el.hint.textContent = `${m.name} · ${EFFORT[S.effort].label} · ${usd2(left)} credit left`;
}

function renderSpend() {
  const pct = Math.min(100, (S.spent / S.budget) * 100);
  el.spendNums.textContent = `${usd2(S.spent)} of ${usd2(S.budget).replace(/\.00$/, "")}`;
  el.spendFill.style.width = pct.toFixed(2) + "%";
  el.spendFill.classList.toggle("warn", pct >= 75 && pct < 90);
  el.spendFill.classList.toggle("bad", pct >= 90);
  el.spendMeter.setAttribute("aria-valuenow", pct.toFixed(0));
  el.spendLeft.textContent = `${usd2(S.budget - S.spent)} left (estimate)`;
  const sheetSpend = $("sheetSpend");
  if (sheetSpend) sheetSpend.textContent = `Credit used so far: ${usd2(S.spent)} of ${usd2(S.budget)} (estimate from this device).`;
  const detail = $("spendDetail");
  if (detail) detail.textContent = `Used so far on this device: ${costStr(S.spent)} (estimated). The Claude Console shows the exact figure.`;
  renderHint();
}

function renderChatList() {
  el.chatList.replaceChildren();
  const list = chats.filter((c) => c.messages.length).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) { el.chatList.append(h("div", { class: "chat-empty", text: "Your chats will show up here." })); return; }
  for (const c of list) {
    el.chatList.append(h("div", { class: "chat-item" + (current?.id === c.id ? " active" : "") },
      h("button", { class: "chat-open", onclick: () => openChat(c.id) },
        h("span", { class: "chat-title", text: c.title || "New chat" }),
        h("span", { class: "chat-date", text: dateStr(c.updatedAt) })),
      h("button", { class: "chat-del", "aria-label": `Delete chat: ${c.title || "New chat"}`, html: ICON.trash, onclick: () => deleteChat(c.id) }),
    ));
  }
}

function renderThread() {
  el.thread.replaceChildren();
  if (!current || !current.messages.length) { el.thread.append(renderWelcome()); el.scroller.scrollTop = 0; return; }
  for (const m of current.messages) el.thread.append(renderMessage(m));
  stick = true;
  scrollToBottom();
}

function renderWelcome() {
  const m = modelById(S.model);
  const w = h("div", { class: "welcome" });
  w.append(h("h1", { html: `${greeting()}, <span>${esc((S.name || "").trim() || "there")}</span>.` }));
  if (!S.access) { w.append(renderInviteCard()); return w; }
  w.append(h("p", { class: "welcome-sub", text: "What can I help you with today?" }));
  const ideas = [
    { icon: ICON.bulb, title: "Explain something", text: "Like how compound interest works, in plain English", prompt: "Explain how compound interest works, in plain English, with a simple example." },
    { icon: ICON.mail, title: "Write for me", text: "A friendly note, a tricky email, a speech", prompt: "Help me write a short, friendly message to an old friend I haven't spoken to in a while." },
    { icon: ICON.map, title: "Plan something", text: "A trip, a project, or a busy week", prompt: "Help me plan a relaxing 3-day trip. Ask me a couple of quick questions first about what I enjoy." },
    { icon: ICON.camera, title: "Ask about a photo", text: "Snap a plant, a gadget or a menu", photo: true },
  ];
  w.append(h("div", { class: "suggestions" }, ideas.map((i) => h("button", {
    class: "suggestion",
    onclick: () => {
      if (i.photo) { el.fileInput.click(); return; }
      el.input.value = i.prompt; autoGrow(); updateSend(); el.input.focus();
      el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    },
  }, h("span", { html: i.icon, style: "display:contents" }), h("strong", { text: i.title }), h("span", { text: i.text })))));
  w.append(h("div", { class: "welcome-meta" },
    h("span", { class: "dot " + m.family }),
    h("span", { html: `Using <strong>${esc(m.name)}</strong> · about ${centsStr(typicalCost(m))} per typical reply` }),
    h("button", { class: "link-btn", text: "Compare models", onclick: openModels }),
  ));
  return w;
}

function renderInviteCard() {
  const input = h("input", { type: "text", placeholder: "Paste the invite link", spellcheck: "false", autocapitalize: "off", autocomplete: "off", "aria-label": "Invite link" });
  const status = h("span", { class: "status", role: "status" });
  const use = h("button", { class: "btn primary", text: "Use this link", onclick: () => useInvite(input.value, status, use) });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") use.click(); });
  return h("div", { class: "setup-card" },
    h("h2", { text: "Open your invite link" }),
    h("p", { text: "This app works with a private invite link. Open the link you were sent on this phone or computer, and you're all set. There's nothing else to set up." }),
    h("p", { text: "If the link opened in a different browser, paste it here instead:" }),
    input,
    h("div", { class: "key-actions" }, use, status),
  );
}

async function useInvite(value, statusEl, btn) {
  const token = readInvite(value);
  if (!token) { statusEl.textContent = "That doesn't look like an invite link."; statusEl.className = "status bad"; return; }
  btn.disabled = true; statusEl.textContent = "Checking…"; statusEl.className = "status";
  const ok = await checkConnection(statusEl, token);
  btn.disabled = false;
  if (ok) {
    S.access = token; store.set("access", token);
    history.replaceState(null, "", location.pathname + "?invite=" + token);
    setTimeout(renderThread, 600);
  }
}

// Free call through the relay: confirms the invite token and the relay's API key both work.
async function checkConnection(statusEl, token = S.access) {
  try {
    await makeClient(token).models.list({ limit: 1 });
    statusEl.textContent = "✓ Connected and working."; statusEl.className = "status ok";
    return true;
  } catch (err) {
    statusEl.className = "status bad";
    statusEl.textContent = err instanceof Anthropic.AuthenticationError
      ? "That invite link isn't valid. Ask for a new one."
      : "Couldn't reach Claude right now. Check the internet connection.";
    return false;
  }
}

function whoLine(modelId, requestedId) {
  const handedOff = requestedId && modelId && modelId !== requestedId;
  return h("div", { class: "who" },
    h("span", { class: "dot " + familyOf(modelId) }),
    h("span", { text: prettyModel(modelId) + (handedOff ? ` (stepped in for ${prettyModel(requestedId)})` : "") }));
}

function renderUser(m) {
  const wrap = h("div", { class: "msg user" + (m.excluded ? " excluded" : "") });
  const imgs = m.content.filter((b) => b.type === "image");
  const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
  if (imgs.length) wrap.append(h("div", { class: "bubble-images" }, imgs.map((b) => h("img", { src: `data:${b.source.media_type};base64,${b.source.data}`, alt: "Photo you sent" }))));
  if (text) wrap.append(h("div", { class: "bubble", text }));
  return wrap;
}

function makeAssistantView() {
  const think = h("details", { class: "thinking", hidden: true });
  const label = h("span", { class: "think-label" });
  const tbody = h("div", { class: "thinking-body" });
  think.append(h("summary", {}, h("span", { html: ICON.chev, style: "display:contents" }), label), tbody);
  const content = h("div", { class: "assistant-content" });
  return { root: h("div", { class: "assistant-body" }, think, content), think, label, tbody, content };
}

function updateAssistantView(v, blocks, { live = false } = {}) {
  let thinking = "";
  const parts = [];
  for (const b of blocks || []) {
    if (b.type === "thinking" && b.thinking) thinking += (thinking ? "\n\n" : "") + b.thinking;
    else if (b.type === "text") {
      const last = parts.at(-1);
      if (last?.kind === "md") last.text += b.text; else parts.push({ kind: "md", text: b.text });
    } else if (b.type === "fallback") parts.push({ kind: "fallback", from: b.from?.model, to: b.to?.model });
  }
  const hasText = parts.some((p) => p.kind === "md" && p.text.trim());
  const waiting = live && !hasText;
  v.think.hidden = !(thinking || waiting);
  v.label.textContent = waiting ? "Thinking…" : "Show thinking";
  v.label.classList.toggle("shimmer", waiting);
  v.tbody.textContent = thinking || "Getting started…";
  v.content.innerHTML = parts.map((p) => p.kind === "md"
    ? `<div class="md">${renderMarkdown(p.text)}</div>`
    : `<div class="notice">${ICON.info}<div>${esc(prettyModel(p.from))} couldn't help with this part, so ${esc(prettyModel(p.to))} took over.</div></div>`).join("");
  if (live && hasText) {
    let target = [...v.content.querySelectorAll(".md")].at(-1);
    while (target?.lastElementChild && !["PRE", "DIV", "TABLE", "HR", "IMG", "BR"].includes(target.lastElementChild.tagName)) target = target.lastElementChild;
    target?.append(h("span", { class: "caret" }));
  }
}

function renderAssistant(m) {
  const wrap = h("div", { class: "msg assistant" + (m.excluded ? " excluded" : "") });
  wrap.append(whoLine(m.meta?.model, m.meta?.requested));
  if (m.notice === "refusal") {
    wrap.append(h("div", { class: "notice", html: `${ICON.info}<div>${esc(prettyModel(m.meta?.model))} declined to answer this one. Try rewording it, or pick a different model.</div>` }));
  } else if (m.notice === "stopped") {
    wrap.append(h("div", { class: "notice", html: `${ICON.info}<div>Stopped before Claude replied.</div>` }));
  } else {
    const v = makeAssistantView();
    updateAssistantView(v, m.content);
    wrap.append(v.root);
    if (m.meta?.stop === "max_tokens") wrap.append(h("div", { class: "notice", html: `${ICON.info}<div>This reply hit the length limit and was cut short. Ask Claude to continue.</div>` }));
    if (m.meta?.stopped) wrap.append(h("div", { class: "notice", html: `${ICON.info}<div>You stopped this reply.</div>` }));
  }
  wrap.append(footFor(m));
  return wrap;
}

function footFor(m) {
  const f = h("div", { class: "msg-foot" });
  const bits = [];
  if (m.meta?.cost != null) bits.push(costStr(m.meta.cost) + (m.meta.estimated ? " (est.)" : ""));
  if (m.meta?.tokens) bits.push(tokStr(m.meta.tokens) + " tokens");
  bits.forEach((b, i) => { if (i) f.append(h("span", { class: "sep", text: "·" })); f.append(h("span", { text: b })); });
  f.append(h("span", { class: "grow" }));
  const text = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (text.trim()) {
    f.append(h("button", {
      class: "foot-btn", "aria-label": "Copy reply", title: "Copy", html: ICON.copy,
      onclick: async (e) => {
        try { await navigator.clipboard.writeText(text); const b = e.currentTarget; b.innerHTML = ICON.check; setTimeout(() => (b.innerHTML = ICON.copy), 1500); }
        catch { toast("Couldn't copy on this device"); }
      },
    }));
  }
  return f;
}

const renderMessage = (m) => (m.role === "user" ? renderUser(m) : renderAssistant(m));

function renderModels() {
  const current = S.model;
  el.modelCards.replaceChildren(...MODELS.map((m) => {
    const t = typicalCost(m);
    const replies = roundSig(S.budget / t).toLocaleString("en-US");
    return h("button", {
      class: `model-card ${m.family}` + (m.id === current ? " selected" : ""), "aria-pressed": String(m.id === current),
      onclick: () => chooseModel(m.id),
    },
      h("div", { class: "mc-head" },
        h("span", { class: "dot " + m.family }),
        h("span", { class: "mc-name", text: m.name }),
        h("span", { class: "mc-badge", text: m.badge }),
        h("span", { class: "mc-check", html: ICON.check + "In use" })),
      h("p", { class: "mc-blurb", text: m.blurb }),
      h("div", { class: "mc-prices" },
        h("div", { class: "mc-price" }, h("b", { text: rateStr(m.in) }), h("span", { text: "input / M tokens" })),
        h("div", { class: "mc-price" }, h("b", { text: rateStr(m.out) }), h("span", { text: "output / M tokens" })),
        h("div", { class: "mc-price" }, h("b", { text: "≈" + centsStr(t) }), h("span", { text: "typical reply" }))),
      h("div", { class: "mc-foot", html: `Your ${esc(usd2(S.budget).replace(/\.00$/, ""))} ≈ <strong>${replies}</strong> typical replies` }),
    );
  }));

  el.priceTable.innerHTML =
    "<thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached input</th><th>Cache write</th><th>Memory</th></tr></thead><tbody>" +
    MODELS.map((m) => `<tr><td><span class="dot ${m.family}" style="display:inline-block;margin-right:8px"></span>${esc(m.name)}${m.long ? "*" : ""}</td><td>${rateStr(m.in)}</td><td>${rateStr(m.out)}</td><td>${rateStr(m.cacheRead)}</td><td>${rateStr(m.cacheWrite)}</td><td>1M tokens</td></tr>`).join("") +
    "</tbody>";
  const haiku = MODELS.find((m) => m.long);
  el.priceFootnote.textContent =
    `US$ per million tokens. "Cached input" is the discounted rate for parts of the conversation Claude has already read. ` +
    `"Memory" is how much one chat can hold: 1 million tokens is roughly 750,000 words. ` +
    (haiku ? `* ${haiku.name}: messages longer than 100,000 tokens cost ${rateStr(haiku.long.in)} input and ${rateStr(haiku.long.out)} output.` : "");
  el.pricesAsOf.textContent = `Prices checked against Anthropic's published API pricing on ${PRICES_CHECKED}. A "typical reply" is about 1,000 tokens in and 1,000 out (roughly 750 words each way); real costs vary with length, photos and thinking time.`;
  renderSpend();
}

function renderAttachments() {
  el.attachments.hidden = !pending.length;
  el.attachments.replaceChildren(...pending.map((p, i) => h("div", { class: "thumb" },
    h("img", { src: `data:${p.block.source.media_type};base64,${p.block.source.data}`, alt: "Photo to send" }),
    h("button", { type: "button", "aria-label": "Remove photo", html: ICON.x, onclick: () => { pending.splice(i, 1); renderAttachments(); updateSend(); } }))));
}

function scrollToBottom() { el.scroller.scrollTop = el.scroller.scrollHeight; }

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg; el.toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.toast.hidden = true), 2400);
}

function autoGrow() {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 200) + "px";
}
function updateSend() {
  el.sendBtn.classList.toggle("stop", busy);
  el.sendBtn.setAttribute("aria-label", busy ? "Stop" : "Send");
  el.sendBtn.disabled = !busy && !el.input.value.trim() && !pending.length;
}
function setBusy(b) { busy = b; updateSend(); }

/* ------------------------------------------------------------------ */
/* Chats                                                               */
/* ------------------------------------------------------------------ */
function makeTitle(text, photos) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return photos ? "Photo question" : "New chat";
  return t.length > 60 ? t.slice(0, 57).trimEnd() + "…" : t;
}
async function saveChat(chat) {
  if (!chats.includes(chat)) chats.push(chat);
  await db.put(chat);
  renderChatList();
}
function stopIfBusy() { if (busy) stop(); }
function newChat() {
  stopIfBusy();
  current = null;
  renderThread(); renderChatList(); closeSidebar();
  if (!coarse) el.input.focus();
}
function openChat(id) {
  stopIfBusy();
  current = chats.find((c) => c.id === id) || null;
  renderThread(); renderChatList(); closeSidebar();
}
async function deleteChat(id) {
  const c = chats.find((x) => x.id === id);
  if (!c || !confirm(`Delete "${c.title || "this chat"}"?`)) return;
  if (current?.id === id) { stopIfBusy(); current = null; renderThread(); }
  chats = chats.filter((x) => x.id !== id);
  await db.del(id);
  renderChatList();
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */
function stop() {
  stoppedByUser = true;
  activeStream?.abort();
}

async function send(rawText) {
  if (busy) return;
  const text = (rawText || "").trim();
  if (!text && !pending.length) return;
  if (!S.access) { toast("Open your invite link first"); renderThread(); return; }

  const model = modelById(S.model);
  const sentPhotos = pending;
  const content = sentPhotos.map((p) => p.block);
  content.push({ type: "text", text: text || "What can you tell me about this photo?" });

  if (!current) current = { id: uid(), title: "", createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  const chat = current;
  const userMsg = { role: "user", content, at: Date.now() };
  const wasEmpty = !chat.messages.length;
  chat.messages.push(userMsg);
  if (!chat.title) chat.title = makeTitle(text, sentPhotos.length);
  chat.updatedAt = Date.now();

  el.input.value = ""; pending = []; autoGrow(); renderAttachments();
  if (coarse) el.input.blur();
  if (wasEmpty) el.thread.replaceChildren();
  const userEl = renderUser(userMsg);
  el.thread.append(userEl);

  const replyEl = h("div", { class: "msg assistant" });
  let who = whoLine(model.id);
  const view = makeAssistantView();
  replyEl.append(who, view.root);
  el.thread.append(replyEl);
  updateAssistantView(view, [], { live: true });
  stick = true; scrollToBottom();
  saveChat(chat);

  setBusy(true);
  stoppedByUser = false;
  let snapshot = null, frame = 0, timer = 0, shownModel = model.id;
  // Paint on the next animation frame, or on a timer when the page is in the background (frames pause there).
  const cancelPaint = () => { cancelAnimationFrame(frame); clearTimeout(timer); frame = timer = 0; };
  const schedule = () => { if (frame || timer) return; frame = requestAnimationFrame(paint); timer = setTimeout(paint, 150); };
  const paint = () => {
    cancelPaint();
    if (!snapshot) return;
    if (snapshot.model && snapshot.model !== shownModel) {
      shownModel = snapshot.model;
      const next = whoLine(shownModel, model.id); who.replaceWith(next); who = next;
    }
    updateAssistantView(view, snapshot.content, { live: true });
    if (stick) scrollToBottom();
  };

  const finish = (assistantMsg) => {
    chat.messages.push(assistantMsg);
    chat.updatedAt = Date.now();
    const finalEl = renderAssistant(assistantMsg);
    replyEl.replaceWith(finalEl);
    if (userMsg.excluded) userEl.classList.add("excluded");
    if (stick) scrollToBottom();
    saveChat(chat);
  };

  try {
    const stream = makeClient().beta.messages.stream(buildParams(model, chat));
    activeStream = stream;
    stream.on("streamEvent", (_event, snap) => { snapshot = snap; schedule(); });
    const final = await stream.finalMessage();
    cancelPaint();
    const { cost, tokens } = costOf(final.usage, model.id);
    addSpend(cost);
    const meta = { model: final.model || model.id, requested: model.id, cost, tokens, stop: final.stop_reason, at: Date.now() };
    if (final.stop_reason === "refusal") {
      // Whole chain declined: keep it on screen, but leave both turns out of what's sent next time.
      userMsg.excluded = true;
      finish({ role: "assistant", excluded: true, notice: "refusal", content: [], meta });
    } else {
      finish({ role: "assistant", content: echoSafe(final.content), meta });
    }
  } catch (err) {
    cancelPaint();
    if (stoppedByUser || err instanceof Anthropic.APIUserAbortError) {
      const { cost, tokens } = estimatePartial(snapshot, model.id);
      addSpend(cost);
      const meta = { model: snapshot?.model || model.id, requested: model.id, cost, tokens, estimated: true, at: Date.now() };
      const texts = (snapshot?.content || []).filter((b) => b.type === "text" && b.text.trim()).map((b) => ({ type: "text", text: b.text }));
      if (texts.length) finish({ role: "assistant", content: texts, meta: { ...meta, stopped: true } });
      else { userMsg.excluded = true; finish({ role: "assistant", excluded: true, notice: "stopped", content: [], meta }); }
    } else {
      console.error(err);
      // Take the message back out and put it in the box so nothing is lost.
      const i = chat.messages.lastIndexOf(userMsg);
      if (i >= 0) chat.messages.splice(i, 1);
      userEl.remove(); replyEl.remove();
      el.input.value = text; pending = sentPhotos; autoGrow(); renderAttachments();
      if (!chat.messages.length) { chats = chats.filter((c) => c !== chat); db.del(chat.id); renderChatList(); renderThread(); }
      else saveChat(chat);
      showError(describeError(err, model));
    }
  } finally {
    activeStream = null;
    setBusy(false);
    updateSend();
  }
}

function showError({ msg, action }) {
  const actions = h("div", { class: "notice-actions" });
  if (action === "settings") actions.append(h("button", { text: "Open settings", onclick: openSettings }));
  if (action === "models") actions.append(h("button", { text: "Choose a model", onclick: openModels }));
  if (action === "retry") actions.append(h("button", { text: "Try again", onclick: (e) => { e.currentTarget.closest(".notice").remove(); send(el.input.value); } }));
  const n = h("div", { class: "notice error" }, h("span", { html: ICON.alert, style: "display:contents" }),
    h("div", {}, h("div", { text: msg + " Your message is back in the box below." }), action ? actions : null));
  el.thread.append(n);
  stick = true; scrollToBottom();
}

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */
const MAX_PHOTOS = 5;
function loadImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable image")); };
    img.src = url;
  });
}
// Shrink to the size Claude actually uses (long side ≤ 1568px), which also keeps the cost down.
async function imageToBlock(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { src = await loadImg(file); }
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  if (!w0 || !h0) throw new Error("empty image");
  const scale = Math.min(1, 1568 / Math.max(w0, h0), Math.sqrt(1150000 / (w0 * h0)));
  const w = Math.max(1, Math.round(w0 * scale)), hgt = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = hgt;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(src, 0, 0, w, hgt);
  const data = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}
async function addPhotos(files) {
  const imgs = [...files].filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!imgs.length) return;
  if (pending.length + imgs.length > MAX_PHOTOS) toast(`Up to ${MAX_PHOTOS} photos per message`);
  for (const f of imgs.slice(0, MAX_PHOTOS - pending.length)) {
    try { pending.push({ block: await imageToBlock(f) }); }
    catch { toast("Couldn't read that photo. Try a different one."); }
  }
  renderAttachments(); updateSend();
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */
function openDialog(d) { closeSidebar(); if (!d.open) d.showModal(); }
function openModels() { renderModels(); openDialog(el.modelsDialog); }
function chooseModel(id) {
  S.model = id; store.set("model", id);
  renderHeader(); renderModels();
  if (!current?.messages.length) renderThread();
  el.modelsDialog.close();
  toast(`Now using ${modelById(id).name}`);
}

function openSettings() {
  $("keyStatus").textContent = S.access ? "This device is set up with an invite link." : "Not set up yet: open your invite link.";
  $("keyStatus").className = "status";
  $("nameInput").value = S.name;
  $("budgetInput").value = S.budget;
  renderEffort(); renderSpend();
  openDialog(el.settingsDialog);
}
function renderEffort() {
  for (const b of $("effortGroup").querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.effort === S.effort));
  $("effortHelp").textContent = EFFORT[S.effort].help;
}


/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */
function openSidebar() { el.sidebar.classList.add("open"); el.scrim.hidden = false; }
function closeSidebar() { el.sidebar.classList.remove("open"); el.scrim.hidden = true; }

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function bind() {
  el.composer.addEventListener("submit", (e) => { e.preventDefault(); if (busy) stop(); else send(el.input.value); });
  el.input.addEventListener("input", () => { autoGrow(); updateSend(); });
  el.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !coarse) { e.preventDefault(); if (!busy) send(el.input.value); }
  });
  el.input.addEventListener("paste", (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); addPhotos(files); } });
  el.attachBtn.addEventListener("click", () => el.fileInput.click());
  el.fileInput.addEventListener("change", () => { const files = [...el.fileInput.files]; el.fileInput.value = ""; addPhotos(files); });

  el.scroller.addEventListener("scroll", () => {
    stick = el.scroller.scrollHeight - el.scroller.scrollTop - el.scroller.clientHeight < 120;
    document.querySelector(".topbar").classList.toggle("scrolled", el.scroller.scrollTop > 4);
  }, { passive: true });

  $("openSidebar").addEventListener("click", openSidebar);
  $("closeSidebar").addEventListener("click", closeSidebar);
  el.scrim.addEventListener("click", closeSidebar);
  $("newChatSide").addEventListener("click", newChat);
  $("newChatTop").addEventListener("click", newChat);
  el.modelBtn.addEventListener("click", openModels);
  $("spendCard").addEventListener("click", openModels);
  $("openModelsSide").addEventListener("click", openModels);
  $("openSettingsSide").addEventListener("click", openSettings);
  $("openSettingsTop").addEventListener("click", openSettings);

  for (const d of [el.modelsDialog, el.settingsDialog]) {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  }
  // Spend line at the top of the models sheet.
  el.modelCards.before(h("div", { class: "welcome-meta", id: "sheetSpend" }));

  $("checkConn").addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true;
    $("keyStatus").textContent = "Checking…"; $("keyStatus").className = "status";
    await checkConnection($("keyStatus")); b.disabled = false;
  });
  $("nameInput").addEventListener("change", (e) => {
    S.name = e.target.value.trim(); store.set("name", S.name); renderHeader();
    if (!current?.messages.length) renderThread();
  });
  $("effortGroup").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-effort]"); if (!b) return;
    S.effort = b.dataset.effort; store.set("effort", S.effort); renderEffort(); renderHint();
  });
  $("budgetInput").addEventListener("change", (e) => {
    const v = Number(e.target.value);
    if (v > 0) { S.budget = v; store.set("budget", v); renderSpend(); } else e.target.value = S.budget;
  });
  $("resetSpend").addEventListener("click", () => {
    if (!confirm("Reset the spend counter to $0? (This doesn't change the real balance.)")) return;
    S.spent = 0; store.set("spent", 0); renderSpend(); toast("Spend counter reset");
  });
  $("deleteAll").addEventListener("click", async () => {
    if (!confirm("Delete every chat on this device? This can't be undone.")) return;
    stopIfBusy(); chats = []; current = null; await db.clear(); renderChatList(); renderThread(); toast("All chats deleted");
  });

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSidebar(); });
}

async function init() {
  takeInviteFromUrl();
  store.del("apiKey"); // from the first version, which stored a real key in the browser
  setupMarkdown();
  bind();
  chats = (await db.all()).filter((c) => c && Array.isArray(c.messages));
  renderHeader(); renderSpend(); renderChatList(); renderThread(); updateSend();
  if (!coarse && S.access) el.input.focus();
}

init();
