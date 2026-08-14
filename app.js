/* ============================================================
   THE APP
   ============================================================ */

import { CONFIG } from "./config.js";
import * as API from "./api.js";
import { api } from "./api.js";
import { queue, cache, meta } from "./db.js";

/* ---- tiny helpers ------------------------------------------- */
const $  = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(36).slice(2));

/* Deterministic pseudo-random from a string. Card tilt and
   waveform bars are seeded off the entry id so they're stable
   across reloads — the page doesn't reshuffle itself every
   time you open it. */
function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fmtTime = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function when(iso) {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* ---- state --------------------------------------------------- */
const S = {
  user: null,
  profileName: "",
  types: [],
  entries: [],     // from server cache
  pending: [],     // from local queue
  lens: "all",
  draft: { typeId: null, audio: null, audioMs: 0, photo: null },
  openId: null,
};

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  $("masthead-name").textContent = CONFIG.NAME;
  $("auth-name").textContent = CONFIG.NAME;
  document.title = CONFIG.NAME;

  API.consumeRedirect();

  if (!API.isSignedIn()) return showAuth();

  const user = await API.loadUser();
  if (!user) return showAuth();
  S.user = user;

  $("auth").hidden = true;
  $("main").hidden = false;

  S.pending = await queue.all();
  S.entries = await cache.all();
  render();

  wire();
  await Promise.all([loadTypes(), loadProfile()]);
  await refreshFromServer();
  syncQueue();
  registerSW();
}

function showAuth() {
  $("auth").hidden = false;
  $("main").hidden = true;
  $("auth-send").onclick = async () => {
    const email = $("auth-email").value.trim();
    if (!email) return;
    $("auth-send").disabled = true;
    $("auth-msg").textContent = "Sending…";
    try {
      await API.sendMagicLink(email);
      $("auth-msg").textContent = "Check your email. The link brings you back here.";
    } catch (e) {
      $("auth-msg").textContent = "That didn't work. Is the address on the list?";
      $("auth-send").disabled = false;
    }
  };
  $("auth-email").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("auth-send").click();
  });
}

/* ============================================================
   DATA
   ============================================================ */
async function loadTypes() {
  try {
    S.types = await api.types();
    await meta.set("types", S.types);
  } catch {
    S.types = (await meta.get("types", [])) || [];
  }
  renderTypebar();
}

async function loadProfile() {
  try {
    const [p] = await api.profile(S.user.id);
    if (p) { S.profileName = p.display_name; $("set-name").value = p.display_name; }
  } catch {}
}

async function refreshFromServer() {
  if (!navigator.onLine) return;
  try {
    const rows = await api.entries();
    S.entries = rows;
    await cache.replace(rows);
    render();
  } catch (e) {
    // offline or expired — the cache is still good
  }
}

/* ============================================================
   CAPTURE
   ============================================================ */
function wire() {
  const composer = $("composer");

  composer.addEventListener("input", () => {
    composer.style.height = "auto";
    composer.style.height = Math.min(composer.scrollHeight, 260) + "px";
    updateCommit();
  });

  // Enter commits, Shift+Enter is a newline. On a phone the
  // return key is right there — this is the whole three-second path.
  composer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
  });

  $("btn-commit").onclick = commit;

  // press and hold to record. No review step, no confirm —
  // optimising for the 95% where the take is fine beats
  // protecting the 5% where it isn't. Delete is two taps.
  const rec = $("btn-rec");
  rec.addEventListener("pointerdown", (e) => { e.preventDefault(); startRec(); });
  rec.addEventListener("pointerup", stopRec);
  rec.addEventListener("pointercancel", stopRec);
  rec.addEventListener("pointerleave", stopRec);

  $("btn-photo").onclick = () => $("photo-input").click();
  $("photo-input").onchange = (e) => {
    const f = e.target.files[0];
    if (f) { S.draft.photo = f; renderAttached(); updateCommit(); }
  };

  $("lens-all").onclick  = () => setLens("all");
  $("lens-type").onclick = () => setLens("type");

  $("btn-shuffle").onclick  = shuffle;
  $("btn-settings").onclick = () => { $("settings").hidden = false; };
  $("set-close").onclick    = () => { $("settings").hidden = true; };
  $("detail-close").onclick = () => { $("detail").hidden = true; S.openId = null; };
  $("detail-again").onclick = shuffle;
  $("detail-delete").onclick = deleteOpen;

  $("set-signout").onclick = () => { API.signOut(); location.reload(); };
  $("set-name").onchange = async (e) => {
    try { await api.setDisplayName(S.user.id, e.target.value.trim()); status("Saved."); }
    catch { status("Couldn't save that."); }
  };
  $("set-type").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const label = e.target.value.trim();
    if (!label) return;
    try { await api.createType(label); e.target.value = ""; await loadTypes(); status("Added."); }
    catch { status("Couldn't add that."); }
  });
  $("set-push").onclick = enablePush;

  window.addEventListener("online", () => { showOffline(false); syncQueue(); refreshFromServer(); });
  window.addEventListener("offline", () => showOffline(true));
  showOffline(!navigator.onLine);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { syncQueue(); refreshFromServer(); }
  });

  composer.focus();
}

const status = (t) => { $("set-status").textContent = t; };
const showOffline = (b) => { $("offline-banner").hidden = !b; };

function updateCommit() {
  const has = $("composer").value.trim() || S.draft.audio || S.draft.photo;
  $("btn-commit").disabled = !has;
}

/* ---- recording ---------------------------------------------- */
let mediaRec = null, chunks = [], recStart = 0, recTimer = null;

function pickMime() {
  const opts = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];
  for (const m of opts) if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
  return "";
}

async function startRec() {
  if (mediaRec) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = pickMime();
    mediaRec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunks = [];
    mediaRec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mediaRec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      if (blob.size > 800) {
        S.draft.audio = blob;
        S.draft.audioMs = Date.now() - recStart;
        renderAttached();
        updateCommit();
      }
      mediaRec = null;
    };
    mediaRec.start();
    recStart = Date.now();
    $("btn-rec").dataset.recording = "true";
    recTimer = setInterval(() => {
      $("rectimer").textContent = fmtTime(Date.now() - recStart);
    }, 200);
  } catch {
    status("No microphone access.");
    $("settings").hidden = false;
  }
}

function stopRec() {
  if (!mediaRec) return;
  clearInterval(recTimer);
  $("rectimer").textContent = "";
  $("btn-rec").dataset.recording = "false";
  try { mediaRec.stop(); } catch { mediaRec = null; }
}

function renderAttached() {
  const box = $("attached");
  box.innerHTML = "";
  const bits = [];
  if (S.draft.audio) bits.push(["Audio " + fmtTime(S.draft.audioMs), () => { S.draft.audio = null; }]);
  if (S.draft.photo) bits.push(["Photo", () => { S.draft.photo = null; }]);
  box.hidden = bits.length === 0;
  for (const [label, clear] of bits) {
    const b = el("button", "chip", label + "  ×");
    b.onclick = () => { clear(); renderAttached(); updateCommit(); };
    box.appendChild(b);
  }
}

/* ---- commit -------------------------------------------------
   Local first, always. The entry is real to you the instant you
   hit return; the network catches up whenever it can. */
async function commit() {
  const body = $("composer").value.trim();
  if (!body && !S.draft.audio && !S.draft.photo) return;

  const item = {
    client_id: uid(),
    kind: "entry",
    body,
    type_id: S.draft.typeId,
    created_at: new Date().toISOString(),   // capture time, not insert time
    audio: S.draft.audio,
    audio_ms: S.draft.audioMs || null,
    photo: S.draft.photo,
    author_name: S.profileName || "you",
  };

  await queue.put(item);
  S.pending.unshift(item);

  $("composer").value = "";
  $("composer").style.height = "auto";
  S.draft = { typeId: S.draft.typeId, audio: null, audioMs: 0, photo: null };
  renderAttached();
  updateCommit();
  render();
  $("composer").focus();

  syncQueue();
  askForSync();
}

/* ---- sync ---------------------------------------------------
   client_id is unique in the database, so every step here is
   safe to retry. A flaky tunnel can fire the same entry five
   times and you still get one row. */
let syncing = false;

async function syncQueue() {
  if (syncing || !navigator.onLine || !API.isSignedIn()) return;
  syncing = true;
  try {
    const items = await queue.all();
    items.sort((a, b) => a.created_at.localeCompare(b.created_at));

    for (const item of items) {
      try {
        if (item.kind === "reply") {
          await api.createReply({
            client_id: item.client_id,
            entry_id: item.entry_id,
            author_id: S.user.id,
            body: item.body,
            created_at: item.created_at,
          });
          await queue.del(item.client_id);
          continue;
        }

        let [row] = await api.createEntry({
          client_id: item.client_id,
          author_id: S.user.id,
          type_id: item.type_id,
          body: item.body,
          created_at: item.created_at,
          audio_ms: item.audio_ms,
        }) || [];

        // An upsert that merged returns nothing useful. Go find
        // the row so the media below still has somewhere to land —
        // otherwise a retried capture silently loses its audio.
        if (!row) [row] = await api.entryByClientId(item.client_id) || [];
        if (!row) throw new Error("row missing after upsert");

        // Media backfills after the row exists. Partial failure
        // is fine — the words are already safe.
        const patch = {};
        if (item.audio) {
          const ext = (item.audio.type.includes("mp4") || item.audio.type.includes("aac")) ? "m4a" : "webm";
          const path = `${S.user.id}/${row.id}.${ext}`;
          await API.upload("audio", path, item.audio);
          patch.audio_path = path;
        }
        if (item.photo) {
          const ext = (item.photo.name?.split(".").pop() || "jpg").toLowerCase().slice(0, 4);
          const path = `${S.user.id}/${row.id}.${ext}`;
          await API.upload("photos", path, item.photo);
          patch.photo_path = path;
        }
        if (Object.keys(patch).length) await api.patchEntry(row.id, patch);
        if (patch.audio_path) API.requestTranscript(row.id, patch.audio_path);
        API.notifyOther(row.id, item.body.slice(0, 80));

        await queue.del(item.client_id);
      } catch (e) {
        // 409 means it already landed. Don't drop it blindly —
        // recover the row id and let the media finish next pass.
        if (e.status === 409) {
          const [existing] = (await api.entryByClientId(item.client_id).catch(() => [])) || [];
          if (existing && !item.audio && !item.photo) await queue.del(item.client_id);
        }
        break; // stop on first real failure; try again next time
      }
    }

    S.pending = await queue.all();
    await refreshFromServer();
    render();
  } finally {
    syncing = false;
  }
}

/* ============================================================
   RENDER
   ============================================================ */
function setLens(l) {
  S.lens = l;
  $("lens-all").setAttribute("aria-pressed", String(l === "all"));
  $("lens-type").setAttribute("aria-pressed", String(l === "type"));
  render();
}

function renderTypebar() {
  const bar = $("typebar");
  bar.innerHTML = "";
  for (const t of S.types) {
    const c = el("button", "chip", t.label);
    c.setAttribute("aria-pressed", String(S.draft.typeId === t.id));
    c.onclick = () => {
      S.draft.typeId = S.draft.typeId === t.id ? null : t.id;
      renderTypebar();
      $("composer").focus();
    };
    bar.appendChild(c);
  }
}

function allItems() {
  const pend = S.pending
    .filter((p) => p.kind === "entry")
    .map((p) => ({
      id: "p:" + p.client_id,
      client_id: p.client_id,
      body: p.body,
      type_id: p.type_id,
      type_label: S.types.find((t) => t.id === p.type_id)?.label || null,
      author_name: p.author_name,
      created_at: p.created_at,
      audio_ms: p.audio_ms,
      _localAudio: p.audio,
      _localPhoto: p.photo,
      _pending: true,
      reply_count: 0,
    }));
  return [...pend, ...S.entries].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function render() {
  readTilt();
  const feed = $("feed");
  feed.innerHTML = "";
  const items = allItems();

  $("empty").hidden = items.length > 0;

  // one year ago today — silent when there's no hit. Nothing
  // worse than an app announcing its own emptiness.
  const now = new Date();
  const tb = items.find((i) => {
    const d = new Date(i.created_at);
    return d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
        && d.getFullYear() < now.getFullYear();
  });
  if (tb) {
    const box = el("div", "throwback");
    const yrs = now.getFullYear() - new Date(tb.created_at).getFullYear();
    box.appendChild(el("div", "throwback__label", `${yrs} year${yrs > 1 ? "s" : ""} ago today`));
    box.appendChild(el("div", "card__body", tb.body || "(a recording)"));
    box.onclick = () => openDetail(tb.id);
    feed.appendChild(box);
  }

  if (S.lens === "type") {
    const groups = new Map();
    for (const i of items) {
      const k = i.type_label || "Untyped";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    const order = [...S.types.map((t) => t.label), "Untyped"];
    for (const label of order) {
      const g = groups.get(label);
      if (!g?.length) continue;
      feed.appendChild(el("div", "sectionrule", `${label} · ${g.length}`));
      for (const i of g) feed.appendChild(card(i));
    }
  } else {
    for (const i of items) feed.appendChild(card(i));
  }
}

/* Read once per render, not once per card — getComputedStyle
   inside the loop forces a layout flush on every single one. */
let tiltMax = 0.9;
function readTilt() {
  const v = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--tilt"));
  if (!Number.isNaN(v)) tiltMax = v;
}

function card(i) {
  const rnd = seeded(i.id);
  const c = el("article", "card" + (i._pending ? " card--pending" : ""));
  c.style.setProperty("--card-tilt", `${(rnd() * 2 - 1) * tiltMax}deg`);

  const text = i.body || i.transcript;
  const b = el("p", "card__body" + (i.body ? "" : " card__body--muted"),
    text || (i.audio_path || i._localAudio ? "[transcribing…]" : ""));
  c.appendChild(b);

  if (i.audio_path || i._localAudio) c.appendChild(waveform(i));
  if (i.photo_path || i._localPhoto) c.appendChild(photo(i));

  const m = el("div", "card__meta");
  // Classed individually so the data-meta variants can hide
  // them selectively without touching this code.
  m.appendChild(el("span", "who", i.author_name || "—"));
  m.appendChild(el("span", "when", when(i.created_at)));
  // redundant when the section rule above already says the type
  if (i.type_label && S.lens !== "type") m.appendChild(el("span", "type", i.type_label));
  if (i.reply_count > 0) m.appendChild(el("span", "replies", `${i.reply_count} ${i.reply_count === 1 ? "reply" : "replies"}`));
  if (i._pending) m.appendChild(el("span", "pendingmark", "not synced"));
  c.appendChild(m);

  c.onclick = () => openDetail(i.id);
  return c;
}

/* A row of solid blocks, not a smooth waveform. A waveform is a
   data visualisation; this is a printed object. Heights are
   seeded off the id so they're stable. */
function waveform(i) {
  const w = el("div", "wave");
  const rnd = seeded(i.id + "w");
  const n = 44;
  for (let k = 0; k < n; k++) {
    const bar = el("i");
    bar.style.height = `${6 + Math.round(rnd() * 20)}px`;
    w.appendChild(bar);
  }
  w.appendChild(el("span", "wave__time", i.audio_ms ? fmtTime(i.audio_ms) : ""));

  w.onclick = async (e) => {
    e.stopPropagation();
    let src = null;
    if (i._localAudio) src = URL.createObjectURL(i._localAudio);
    else if (i.audio_path) src = await API.signedUrl("audio", i.audio_path);
    if (!src) return;
    const a = new Audio(src);
    w.dataset.playing = "true";
    a.onended = a.onerror = () => { w.dataset.playing = "false"; };
    a.play().catch(() => { w.dataset.playing = "false"; });
  };
  return w;
}

function photo(i) {
  const img = el("img", "photo");
  img.loading = "lazy";
  img.alt = "";
  if (i._localPhoto) img.src = URL.createObjectURL(i._localPhoto);
  else API.signedUrl("photos", i.photo_path).then((u) => { if (u) img.src = u; });
  return img;
}

/* ============================================================
   DETAIL / SHUFFLE
   ============================================================ */
async function openDetail(id, isShuffle = false) {
  const i = allItems().find((x) => x.id === id);
  if (!i) return;
  S.openId = id;

  $("detail-label").textContent = isShuffle
    ? "From the pile"
    : `${i.author_name || "—"} · ${when(i.created_at)}${i.type_label ? " · " + i.type_label : ""}`;
  $("detail-again").hidden = !isShuffle;
  $("detail-delete").hidden = i._pending;

  const body = $("detail-body");
  body.innerHTML = "";
  const inner = el("div");
  inner.appendChild(el("div", null, i.body || i.transcript || "(a recording)"));

  // Shuffle strips the header down to "from the pile", so put the
  // attribution back underneath — a found object still wants a date on it.
  if (isShuffle) {
    const m = el("div", "card__meta");
    m.style.justifyContent = "center";
    m.style.marginTop = "var(--space-4)";
    m.appendChild(el("span", "who", i.author_name || "—"));
    m.appendChild(el("span", "when", when(i.created_at)));
    if (i.type_label) m.appendChild(el("span", "type", i.type_label));
    inner.appendChild(m);
  }
  if (i.audio_path || i._localAudio) inner.appendChild(waveform(i));
  if (i.photo_path || i._localPhoto) inner.appendChild(photo(i));
  body.appendChild(inner);

  $("detail").hidden = false;

  if (!i._pending) {
    const thread = el("div", "thread");
    inner.appendChild(thread);
    try {
      const rs = await api.replies(i.id);
      for (const r of rs) {
        const p = el("p", "reply");
        p.appendChild(el("span", "reply__who", r.profiles?.display_name || ""));
        p.appendChild(document.createTextNode(r.body));
        thread.appendChild(p);
      }
    } catch {}

    const box = el("div", "replybox");
    const input = el("input");
    input.placeholder = "Riff on it…";
    input.onclick = (e) => e.stopPropagation();
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      const item = {
        client_id: uid(), kind: "reply", entry_id: i.id,
        body: input.value.trim(), created_at: new Date().toISOString(),
      };
      await queue.put(item);
      const p = el("p", "reply");
      p.appendChild(el("span", "reply__who", S.profileName || "you"));
      p.appendChild(document.createTextNode(item.body));
      thread.appendChild(p);
      input.value = "";
      syncQueue();
    });
    box.appendChild(input);
    inner.appendChild(box);
  }
}

function shuffle() {
  const items = allItems();
  if (!items.length) return;
  openDetail(items[Math.floor(Math.random() * items.length)].id, true);
}

async function deleteOpen() {
  if (!S.openId) return;
  const i = allItems().find((x) => x.id === S.openId);
  if (!i || i._pending) return;
  try {
    await api.deleteEntry(i.id);
    S.entries = S.entries.filter((e) => e.id !== i.id);
    await cache.replace(S.entries);
    $("detail").hidden = true;
    S.openId = null;
    render();
  } catch {}
}

/* ============================================================
   PWA
   ============================================================ */
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch(() => {});
  // The worker fires this when Background Sync wakes it up.
  // Without a listener the sync event does nothing at all.
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "flush") syncQueue();
  });
}

/* Ask the browser to wake us when the network returns. Chrome and
   Android honour this; Safari doesn't implement it, which is why
   the app also flushes on 'online' and on visibilitychange. */
async function askForSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.sync.register("flush-queue");
  } catch { /* not supported — the fallbacks cover it */ }
}

function urlB64ToU8(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  if (!CONFIG.VAPID_PUBLIC_KEY) return status("Push isn't configured yet — see SETUP step 6.");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return status("Notifications are blocked in browser settings.");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToU8(CONFIG.VAPID_PUBLIC_KEY),
    });
    const j = sub.toJSON();
    await api.savePushSub({ user_id: S.user.id, endpoint: j.endpoint, keys: j.keys });
    status("Notifications on.");
  } catch (e) {
    status("Couldn't turn those on. On iPhone, add this to your home screen first.");
  }
}

boot();
