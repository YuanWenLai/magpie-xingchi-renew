// magpie-xingchi-renew — Xingchi session renewal (async gateway hook).
//
// Xingchi caps each session at 100 model replies and rejects any single
// request carrying more than 10 user turns in its input array (both proven
// station-side, 2026-11-21). The 100-turn counter is per conversation
// content, NOT per API key: on 2026-11-25 a fresh minimal request with the
// same key returned 200 while a long session was capped.
//
// This hook reshapes a request into a "new session" before the caps hit:
// it drops early turns (keeping the most recent ones plus a note), marks
// the instructions, and rotates any conversation/metadata session markers,
// so Xingchi sees a fresh conversation. Fail-open: any error leaves the
// request untouched.
//
// Runs in magpie's Bun plugin host. NOTE (2026-11-25, observed live): the host
// is short-lived in magpie 0.1.4701 — it restarts every few seconds once any
// gateway hook exists (app.log: ~1 host start per day before this hook,
// ~30/min after; no errors logged). Module state therefore does NOT survive
// across requests, so per-session counts and the renew-after-failure flag
// live in small JSON files under ./state/ instead (atomic write+rename).
// The renewal itself does not depend on them: the items / user-turn /
// assistant-message triggers are all derived from the current request alone.
//
// v1.2 lesson (2026-11-25 11:00): a turn-trim alone is NOT enough when one
// giant turn holds nearly all the history — two sessions renewed 320->307
// items and kept 400ing, because the counted rounds stayed in the input.
// So every renewal now also enforces a hard ceiling on the renewed input
// (maxRenewedItems), cutting to the most recent items at a safe boundary.

import { appendFileSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";

const LOG = (process.env.HOME || "~") + "/magpie-xingchi-renew/renewals.log";
const STATE_DIR = (process.env.HOME || "~") + "/magpie-xingchi-renew/state";

const DEFAULTS = {
  renewAt: 90,      // renew after this many requests in one magpie session (disk-persisted, survives host restarts)
  maxItems: 150,    // or when the request input grows past this many items
  maxUserTurns: 9,  // Xingchi rejects >10 user turns in one request; keep <= 9
  maxAssistantMsgs: 80, // or when the input holds this many assistant replies (~1 per request; covers tool-less sessions the items trigger would miss)
  keepTurns: 8,     // user turns to keep on renewal (plus 1 note turn = 9)
  maxRenewedItems: 80, // hard ceiling on the renewed input: a single giant turn can hold nearly all the history, so the turn-trim alone may barely shrink it; cutting to the most recent items keeps the counted rounds well below 100
};

const NOTE = "[星驰会话续命：为绕开本站单会话 100 轮上限，已丢弃早期上下文，只保留最近几轮；如需早期信息请查看文件或重新说明。]";

// Per-session state, persisted on disk (the Bun host restarts every few
// seconds, so module state would be lost). One small JSON file per session:
// { count, renewals, renewNext, lastSeen }. Writes are atomic (tmp + rename)
// so a crash mid-write cannot corrupt the file; a corrupt file just reads
// as a fresh session. All state access is fail-open.
function statePath(sid) {
  return STATE_DIR + "/" + encodeURIComponent(String(sid)) + ".json";
}

function loadState(sid) {
  try {
    const st = JSON.parse(readFileSync(statePath(sid), "utf8"));
    if (st && typeof st.count === "number") {
      return { count: st.count, renewals: st.renewals || 0, renewNext: !!st.renewNext, lastSeen: st.lastSeen || 0 };
    }
  } catch { /* fresh session */ }
  return { count: 0, renewals: 0, renewNext: false, lastSeen: 0 };
}

function saveState(sid, st) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const tmp = statePath(sid) + ".tmp-" + process.pid + "-" + Date.now();
    writeFileSync(tmp, JSON.stringify(st));
    renameSync(tmp, statePath(sid));
  } catch { /* best-effort */ }
}

// Drop state files idle for over 6 hours. Runs at host load (the host
// restarts constantly, so this runs often enough).
try {
  const now = Date.now();
  for (const name of readdirSync(STATE_DIR)) {
    if (!name.endsWith(".json")) continue;
    const p = STATE_DIR + "/" + name;
    try {
      if (now - statSync(p).mtimeMs > 6 * 3600 * 1000) unlinkSync(p);
    } catch { /* ignore */ }
  }
} catch { /* state dir may not exist yet */ }

function log(line) {
  try {
    appendFileSync(LOG, new Date().toISOString() + " " + line + "\n");
  } catch { /* best-effort */ }
}

try { log("loaded"); } catch { /* ignore */ }

function opts(ctx) {
  const o = (ctx && ctx.options) || {};
  return {
    renewAt: Number(o.renewAt) || DEFAULTS.renewAt,
    maxItems: Number(o.maxItems) || DEFAULTS.maxItems,
    maxUserTurns: Number(o.maxUserTurns) || DEFAULTS.maxUserTurns,
    maxAssistantMsgs: Number(o.maxAssistantMsgs) || DEFAULTS.maxAssistantMsgs,
    keepTurns: Number(o.keepTurns) || DEFAULTS.keepTurns,
    maxRenewedItems: Number(o.maxRenewedItems) || DEFAULTS.maxRenewedItems,
  };
}

function isXingchi(ctx, body) {
  const m = (ctx && ctx.model) || (body && body.model) || "";
  return typeof m === "string" && m.startsWith("xingchiapi/");
}

// responses protocol: body.input is an array of items;
//   user turn = { type: "message", role: "user" }
// chat protocol: body.messages is an array;
//   user turn = { role: "user" }
function isUserItem(item, protocol) {
  if (!item || typeof item !== "object") return false;
  if (protocol === "chat") return item.role === "user";
  return item.type === "message" && item.role === "user";
}

function countUserTurns(items, protocol) {
  let n = 0;
  for (const it of items) if (isUserItem(it, protocol)) n++;
  return n;
}

// Assistant replies in the input: about one per inference request, so this
// counts requests without any cross-request state.
function countAssistantMsgs(items, protocol) {
  let n = 0;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (protocol === "chat") { if (it.role === "assistant") n++; }
    else if (it.type === "message" && it.role === "assistant") n++;
  }
  return n;
}

// A cut index c (keep items[c:]) is safe when it cannot split a tool call
// from its output: the kept suffix must start with a message/reasoning item
// (responses) or a user/assistant message (chat), never a function_call,
// function_call_output or tool-result message.
function isSafeCut(items, protocol, c) {
  if (c <= 0) return true;
  if (c >= items.length) return false;
  const it = items[c];
  if (!it || typeof it !== "object") return false;
  if (protocol === "chat") return it.role === "user" || it.role === "assistant";
  return it.type === "message" || it.type === "reasoning";
}

function noteItem(protocol) {
  return protocol === "chat"
    ? { role: "user", content: NOTE }
    : { type: "message", role: "user", content: NOTE };
}

// Trim items to the last `keep` user turns, prefixed with a single note turn.
// Cuts at a user-message boundary so no tool call is left without its output.
// For chat, leading system messages are preserved (they carry the system prompt);
// for responses the system prompt lives in top-level `instructions`, which we keep.
// If there are too few user turns to trim by (0-1), fall back to dropping
// the oldest half at the next safe boundary.
// HARD CEILING: a single giant turn (a long tool loop) can hold nearly all
// the history, so the turn-trim alone may drop only a handful of items and
// the renewed input still trips Xingchi's 100-turn cap (observed 2026-11-25:
// two sessions renewed 320->307 items and kept 400ing). After the turn-trim,
// if the result still exceeds `ceiling` items, cut it to the most recent
// `ceiling` items at a safe boundary. The last user turn (the current task)
// is re-inserted after the note with a marker when the cut drops it, so the
// model keeps the task while the input still changes.
// Returns { items, ceilingApplied } or null when nothing can be dropped.
function renewItems(items, protocol, keep, ceiling) {
  const idx = [];
  for (let i = 0; i < items.length; i++) if (isUserItem(items[i], protocol)) idx.push(i);
  let cut = -1;
  if (idx.length > keep) {
    cut = idx[idx.length - keep];
  } else if (items.length > 4) {
    cut = Math.floor(items.length / 2);
    while (cut < items.length && !isSafeCut(items, protocol, cut)) cut++;
    if (cut >= items.length) return null;
  } else {
    return null;
  }
  let ceilingApplied = false;
  if (items.length - cut > ceiling) {
    let cut2 = items.length - ceiling;
    while (cut2 < items.length && !isSafeCut(items, protocol, cut2)) cut2++;
    if (cut2 < items.length && cut2 > cut) { cut = cut2; ceilingApplied = true; }
  }
  const note = noteItem(protocol);
  // The last user turn is the current task: keep it (marked) even if the
  // ceiling cut dropped it.
  const lastUserIdx = idx.length ? idx[idx.length - 1] : -1;
  const keepLastUser = lastUserIdx >= 0 && lastUserIdx < cut;
  if (protocol === "chat") {
    const head = [];
    for (const it of items) {
      if (it && it.role === "system") head.push(it);
      else break;
    }
    const out = [...head, note];
    if (keepLastUser) out.push(withMarker(items[lastUserIdx], protocol));
    out.push(...items.slice(cut));
    return { items: out, ceilingApplied };
  }
  const out = [note];
  if (keepLastUser) out.push(withMarker(items[lastUserIdx], protocol));
  out.push(...items.slice(cut));
  return { items: out, ceilingApplied };
}

// Copy of a user message with a renewal marker appended to string content
// (so the input changes even when the message itself is kept).
function withMarker(msg, protocol) {
  const copy = { ...msg };
  const marker = "\n[magpie-xingchi-renew]";
  if (typeof copy.content === "string") copy.content = copy.content + marker;
  else if (Array.isArray(copy.content)) {
    copy.content = [...copy.content, { type: "text", text: marker }];
  }
  return copy;
}

export async function onRequest(body, ctx) {
  try {
    if (!body || typeof body !== "object") return undefined;
    if (!isXingchi(ctx, body)) return undefined;
    const protocol = ctx && ctx.protocol;
    if (protocol !== "responses" && protocol !== "chat") return undefined;

    const key = protocol === "chat" ? "messages" : "input";
    const items = body[key];
    if (!Array.isArray(items) || items.length === 0) return undefined;

    const o = opts(ctx);
    const sid = (ctx && ctx.session) || "default";
    const now = Date.now();
    let st = loadState(sid);
    st.lastSeen = now;
    st.count += 1;

    const userTurns = countUserTurns(items, protocol);
    const assistantMsgs = countAssistantMsgs(items, protocol);
    const reasons = [];
    if (st.renewNext) reasons.push("previous request failed");
    if (st.count >= o.renewAt) reasons.push("count=" + st.count + ">=" + o.renewAt);
    if (items.length > o.maxItems) reasons.push("items=" + items.length + ">" + o.maxItems);
    if (userTurns > o.maxUserTurns) reasons.push("userTurns=" + userTurns + ">" + o.maxUserTurns);
    if (assistantMsgs >= o.maxAssistantMsgs) reasons.push("assistantMsgs=" + assistantMsgs + ">=" + o.maxAssistantMsgs);
    if (reasons.length === 0) { saveState(sid, st); return undefined; }

    // How many user turns to keep: the standard trim for the 10-turn cap;
    // for a count/items/failure renewal with few turns, force a visible
    // change by dropping at least 2 turns (else the input would be identical
    // and Xingchi would still see the same session).
    let keep = o.keepTurns;
    if (userTurns <= o.maxUserTurns) keep = Math.max(1, userTurns - 2);

    const r = renewItems(items, protocol, keep, o.maxRenewedItems);
    if (r) body[key] = r.items;
    st.renewals += 1;
    st.count = 1; // this request is the first of the renewed session
    st.renewNext = false;
    saveState(sid, st);

    // Change the other plausible session fingerprints too.
    if (typeof body.instructions === "string") {
      body.instructions += "\n[magpie-xingchi-renew: session renewed " + new Date().toISOString() + " #" + st.renewals + "]";
    }
    if ("previous_response_id" in body) body.previous_response_id = null;
    if (typeof body.conversation === "string") {
      body.conversation = "renewed-" + Date.now().toString(36);
    } else if (body.conversation && typeof body.conversation === "object" && typeof body.conversation.id === "string") {
      body.conversation.id = "renewed-" + Date.now().toString(36);
    }
    if (body.metadata && typeof body.metadata === "object") {
      body.metadata.xingchi_renewed = new Date().toISOString();
    }

    const afterItems = r ? r.items : items;
    log("renew session=" + sid + " #" + st.renewals + " (" + reasons.join("; ") + (r && r.ceilingApplied ? "; ceiling" : "") + ") items " + items.length + "->" + afterItems.length + " userTurns " + userTurns + "->" + countUserTurns(afterItems, protocol) + " assistantMsgs=" + assistantMsgs);
    return body;
  } catch {
    return undefined; // fail open
  }
}

export async function onResponse(reply, ctx) {
  try {
    if (!ctx || ctx.success) return;
    // Any failed reply for a xingchiapi session: renew on the next request.
    // (On failure the reply may be null, so the error code is not visible
    // here; renewing after an unrelated failure is harmless.)
    if (!isXingchi(ctx, ctx.request)) return;
    const sid = ctx.session || "default";
    const st = loadState(sid);
    st.renewNext = true;
    st.lastSeen = Date.now();
    saveState(sid, st);
    log("failure session=" + sid + " -> will renew next request");
  } catch { /* ignore */ }
}
