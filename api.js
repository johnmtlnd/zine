/* ============================================================
   SUPABASE over plain fetch. No SDK, no CDN, no build step.

   Auth, database and storage are all just HTTP. For an app with
   two users and four screens, the SDK's job is small enough to
   do by hand — and doing it by hand is what keeps this thing
   deployable as a folder of files.
   ============================================================ */

import { CONFIG } from "./config.js";

const URL_ = CONFIG.SUPABASE_URL.replace(/\/$/, "");
const KEY  = CONFIG.SUPABASE_ANON_KEY;
const SESSION_KEY = "archive.session";

/* ---- session ------------------------------------------------ */
let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch {}

function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

export function currentUser() {
  return session ? session.user : null;
}
export function isSignedIn() { return !!session; }

/* Magic links come back with tokens in the URL fragment.
   Grab them, stash them, and scrub the address bar so the
   tokens don't sit in history. */
export function consumeRedirect() {
  const h = location.hash.slice(1);
  if (!h.includes("access_token")) return false;
  const p = new URLSearchParams(h);
  const access = p.get("access_token");
  if (!access) return false;
  saveSession({
    access_token: access,
    refresh_token: p.get("refresh_token"),
    expires_at: Date.now() + (Number(p.get("expires_in") || 3600) * 1000),
    user: null,
  });
  history.replaceState(null, "", location.pathname + location.search);
  return true;
}

async function refresh() {
  if (!session?.refresh_token) return false;
  const r = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh_token }),
  });
  if (!r.ok) { saveSession(null); return false; }
  const d = await r.json();
  saveSession({
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: Date.now() + (d.expires_in * 1000),
    user: d.user || session.user,
  });
  return true;
}

async function token() {
  if (!session) return null;
  // refresh a minute early so a request never races the expiry
  if (Date.now() > session.expires_at - 60000) {
    const ok = await refresh();
    if (!ok) return null;
  }
  return session.access_token;
}

export async function loadUser() {
  const t = await token();
  if (!t) return null;
  const r = await fetch(`${URL_}/auth/v1/user`, {
    headers: { apikey: KEY, Authorization: `Bearer ${t}` },
  });
  if (!r.ok) { saveSession(null); return null; }
  const user = await r.json();
  saveSession({ ...session, user });
  return user;
}

export async function sendMagicLink(email) {
  // GoTrue takes the return address as a query parameter, not a
  // body field. Putting it in the body silently does nothing and
  // you end up wherever Site URL points instead.
  const back = encodeURIComponent(location.origin + location.pathname);

  // Cap the wait. A misconfigured SMTP port doesn't refuse the
  // connection, it hangs — so without a timeout this request sits
  // there and eventually surfaces as an indistinguishable network
  // error. Timing out on purpose lets us say which one it was.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let r;
  try {
    r = await fetch(`${URL_}/auth/v1/otp?redirect_to=${back}`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: true }),
      signal: ctl.signal,
    });
  } catch (e) {
    const err = new Error(
      e.name === "AbortError"
        ? "Timed out after 20s. Supabase took the request but never replied — " +
          "that's almost always the mail server: check the SMTP port and host."
        : "Couldn't reach Supabase at all — no connection, or something is " +
          "blocking the request."
    );
    err.status = e.name === "AbortError" ? "timeout" : undefined;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    // Keep what Supabase actually said. GoTrue returns at least four
    // different error shapes depending on the failure, so read the raw
    // body and fall back to it verbatim rather than inventing a message
    // — an invented one sends you debugging the wrong thing.
    const raw = await r.text().catch(() => "");
    let d = {};
    try { d = JSON.parse(raw); } catch {}
    const detail = d.msg || d.message || d.error_description ||
                   (typeof d.error === "string" ? d.error : "") ||
                   d.error_code || raw.slice(0, 300) || "no detail returned";
    const err = new Error(detail);
    err.status = r.status;
    err.code = d.error_code || (typeof d.error === "string" ? d.error : "") || "";
    err.raw = raw;
    throw err;
  }
  return true;
}

export function signOut() { saveSession(null); }

/* ---- database ----------------------------------------------- */
async function rest(path, { method = "GET", body, prefer } = {}) {
  const t = await token();
  if (!t) throw new Error("not-signed-in");
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${t}`,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${URL_}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    const err = new Error(`${r.status} ${detail}`);
    err.status = r.status;
    throw err;
  }
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export const api = {
  entries: (limit = 500) =>
    rest(`entries_full?select=*&order=created_at.desc&limit=${limit}`),

  // on_conflict names the constraint to upsert against. Without
  // it PostgREST targets the primary key, so a retried capture
  // 409s instead of merging.
  createEntry: (row) =>
    rest("entries?on_conflict=client_id", {
      method: "POST", body: row,
      prefer: "return=representation,resolution=merge-duplicates",
    }),

  patchEntry: (id, patch) =>
    rest(`entries?id=eq.${id}`, { method: "PATCH", body: patch, prefer: "return=representation" }),

  deleteEntry: (id) => rest(`entries?id=eq.${id}`, { method: "DELETE" }),

  types: () => rest("entry_types?select=*&order=sort_order.asc"),

  createType: (label) =>
    rest("entry_types", {
      method: "POST",
      body: { label, slug: label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), sort_order: 100 },
      prefer: "return=representation",
    }),

  replies: (entryId) =>
    rest(`replies?select=*,profiles(display_name)&entry_id=eq.${entryId}&order=created_at.asc`),

  createReply: (row) =>
    rest("replies?on_conflict=client_id", {
      method: "POST", body: row,
      prefer: "return=representation,resolution=merge-duplicates",
    }),

  entryByClientId: (clientId) =>
    rest(`entries?select=id,audio_path,photo_path&client_id=eq.${encodeURIComponent(clientId)}`),

  profile: (id) => rest(`profiles?select=*&id=eq.${id}`),

  setDisplayName: (id, display_name) =>
    rest(`profiles?id=eq.${id}`, { method: "PATCH", body: { display_name } }),

  savePushSub: (row) =>
    rest("push_subscriptions", { method: "POST", body: row, prefer: "resolution=merge-duplicates" }),
};

/* ---- storage ------------------------------------------------ */
export async function upload(bucket, path, blob) {
  const t = await token();
  if (!t) throw new Error("not-signed-in");
  const r = await fetch(`${URL_}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${t}`,
      "Content-Type": blob.type || "application/octet-stream",
      "x-upsert": "true",
    },
    body: blob,
  });
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${await r.text().catch(() => "")}`);
  return path;
}

const signedCache = new Map();

export async function signedUrl(bucket, path, expiresIn = 3600) {
  const key = `${bucket}/${path}`;
  const hit = signedCache.get(key);
  if (hit && hit.until > Date.now()) return hit.url;

  const t = await token();
  if (!t) throw new Error("not-signed-in");
  const r = await fetch(`${URL_}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  if (!r.ok) return null;
  const d = await r.json();
  const url = `${URL_}/storage/v1${d.signedURL}`;
  signedCache.set(key, { url, until: Date.now() + (expiresIn - 120) * 1000 });
  return url;
}

/* ---- transcription (Supabase Edge Function) ----------------- */
export async function requestTranscript(entryId, audioPath) {
  const t = await token();
  if (!t) return;
  await fetch(`${URL_}/functions/v1/transcribe`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entry_id: entryId, audio_path: audioPath }),
  }).catch(() => {});
}

export async function notifyOther(entryId, preview) {
  const t = await token();
  if (!t || !CONFIG.VAPID_PUBLIC_KEY) return;
  await fetch(`${URL_}/functions/v1/notify`, {
    method: "POST",
    headers: { apikey: KEY, Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entry_id: entryId, preview }),
  }).catch(() => {});
}
