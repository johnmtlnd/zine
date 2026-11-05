/* ============================================================
   THE APP
   ============================================================ */

import { CONFIG } from "./config.js";
import * as API from "./api.js";
import { api } from "./api.js";
import { queue, cache, meta } from "./db.js";
import { md, plain } from "./md.js";

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


/* The prototype's small print: "1 DAY AGO". Past a month it turns
   into a date — at that distance "37 days ago" is just arithmetic. */
function ago(iso) {
  const d = new Date(iso);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  const n = (v, unit) => `${v} ${unit}${v === 1 ? "" : "s"} ago`;
  if (mins < 1) return "just now";
  if (mins < 60) return n(mins, "min");
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return n(hrs, "hr");
  const days = Math.floor(hrs / 24);
  if (days < 7) return n(days, "day");
  if (days < 30) return n(Math.floor(days / 7), "week");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* First line is the heading, the rest is the body. No schema
   change: it's how you'd write it in a notebook anyway. */
function split(text) {
  const t = (text || "").trim();
  const i = t.indexOf("\n");
  const head = (i < 0 ? t : t.slice(0, i)).replace(/^#{1,6}\s+/, "").trim();
  return [head, i < 0 ? "" : t.slice(i + 1).trim()];
}

/* A post's tags, whichever shape they arrived in: the view's
   list (after migration 002), a queued post's ids, or the old
   single type_id. */
function tagsOf(i) {
  if (Array.isArray(i.tags)) return i.tags;
  const ids = i.tag_ids || (i.type_id ? [i.type_id] : []);
  return ids.map((id) => ({ id, label: S.types.find((t) => t.id === id)?.label || "" })).filter((t) => t.label);
}
const tagIdsOf = (i) => tagsOf(i).map((t) => t.id);

/* ---- state --------------------------------------------------- */
const S = {
  user: null,
  profileName: "",
  types: [],
  entries: [],     // from server cache
  pending: [],     // from local queue
  cat: null,       // a type id, "none" for untyped, or null for everything
  media: "all",    // all | photo | audio
  sort: "new",     // new | old | shuffle
  shuffleSeed: 0,
  draft: { tagIds: [], audio: null, audioMs: 0, photo: null },
  v2: null,        // has migration 002 run? (tags, likes) — null until we know
  view: "feed",    // feed | grid (wide screens)
  editing: false,  // the open post is in edit mode
  edit: null,      // its draft while editing
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

  try { if (localStorage.getItem("offcuts.view") === "grid") S.view = "grid"; } catch {}
  S.pending = await queue.all();
  S.entries = await cache.all();
  S.v2 = await meta.get("v2", null);
  render();

  wire();
  updateCommit();
  await Promise.all([loadTypes(), loadProfile(), probeV2()]);
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
      // Say which thing broke. Supabase's built-in mailer is capped
      // at 2 messages an hour and only delivers to members of your
      // Supabase org, so "it didn't work" is usually one of two very
      // specific things — and they need different fixes.
      const msg = String(e.message || "").toLowerCase();
      if (e.status === 429 || msg.includes("rate limit")) {
        $("auth-msg").textContent =
          "Supabase's built-in mailer allows 2 emails an hour and that's used up. " +
          "Wait an hour, or set up custom SMTP (see SETUP step 7b).";
      } else if (msg.includes("not authorized") || msg.includes("not allowed")) {
        $("auth-msg").textContent =
          "Supabase won't email that address. Its built-in mailer only sends to " +
          "members of your Supabase organisation — custom SMTP fixes it for good.";
      } else if (e.status === "timeout") {
        $("auth-msg").textContent = e.message;
      } else if (e.status === undefined) {
        // fetch() itself rejected — no HTTP response came back at all,
        // so this isn't Supabase saying no, it's the request never
        // leaving. Different problem, different fixes.
        $("auth-msg").textContent =
          "Couldn't reach Supabase at all — the request never completed. " +
          "Usually that's no connection, a content or ad blocker, or the " +
          "page being opened as a local file instead of over https.";
      } else if (e.status >= 500) {
        // GoTrue accepted the request and the mail server refused it.
        // The useful detail is in Supabase's own auth log, not here.
        $("auth-msg").textContent =
          `Mail server rejected it (${e.status}). Supabase → Logs → Auth ` +
          `has the actual SMTP error. ${e.message}`;
      } else {
        $("auth-msg").textContent = `Couldn't send it — ${e.status}: ${e.message}`;
      }
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
  render();
}

/* Has migration 002 been run? Likes and multi-tag writes wait on it;
   everything else works either way. */
async function probeV2() {
  if (!navigator.onLine) return;
  const v = await api.hasV2().catch(() => null);
  if (v === null) return;
  S.v2 = v;
  await meta.set("v2", v);
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
    denied = false;
    paintBanner();
    render();
  } catch (e) {
    // 401/403 means auth worked but row-level security said no —
    // almost always the email isn't in allowed_emails. That's a
    // permanent condition, so surface it. Anything else is just
    // a flaky network and the cache still stands.
    if (e.status === 401 || e.status === 403) { denied = true; paintBanner(); }
  }
}

/* ============================================================
   CAPTURE
   ============================================================ */
function wire() {
  const composer = $("composer");

  composer.addEventListener("input", () => { growComposer(); updateCommit(); });

  // Enter commits, Shift+Enter is a newline. On a phone the
  // return key is right there — this is the whole three-second path.
  composer.addEventListener("keydown", (e) => {
    // Return is always a new line — posts can be long now, and the
    // second line is where the body starts. Cmd/Ctrl+Return keeps it.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
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

  // + in the masthead
  $("btn-compose").onclick = () => openComposer();
  wireComposer();
  wirePosts();

  $("btn-settings").onclick = () => {
    $("settings").hidden = false;
    renderTagManager();
    if (S.v2 === false) status("Likes, multiple tags and merging switch on once db/002_tags_likes.sql has been run in Supabase.");
  };
  $("set-close").onclick    = () => { $("settings").hidden = true; render(); };
  $("detail-close").onclick = closeDetail;
  $("detail-again").onclick = shuffle;
  $("detail-delete").onclick = deleteOpen;
  $("detail-edit").onclick  = startEdit;
  $("detail-save").onclick  = saveEdit;
  $("detail-cancel").onclick = cancelEdit;

  // on a wide screen the post is a modal: a click outside it closes it
  $("detail").addEventListener("click", (e) => {
    if (e.target === $("detail") && !S.editing) closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("detail").hidden || picker || $("compose").open) return;
    if (S.editing) cancelEdit(); else closeDetail();
  });

  // feed or grid (wide screens). Remembered per browser.
  for (const v of ["feed", "grid"]) {
    $("v-" + v).onclick = () => {
      S.view = v;
      try { localStorage.setItem("offcuts.view", v); } catch {}
      render();
    };
  }

  $("set-signout").onclick = () => { API.signOut(); location.reload(); };
  $("set-name").onchange = async (e) => {
    try { await api.setDisplayName(S.user.id, e.target.value.trim()); status("Saved."); }
    catch { status("Couldn't save that."); }
  };
  $("set-type").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const label = e.target.value.trim();
    if (!label) return;
    const t = await makeTag(label);
    if (t) { e.target.value = ""; renderTagManager(); renderTypebar(); status(`Added ${t.label}.`); }
  });
  $("set-push").onclick = enablePush;

  window.addEventListener("online", () => { showOffline(); syncQueue(); refreshFromServer(); });
  window.addEventListener("offline", () => showOffline());
  showOffline();

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { syncQueue(); refreshFromServer(); }
  });

}

const status = (t) => { $("set-status").textContent = t; };

/* One banner, two jobs. Being offline is expected and temporary;
   being rejected by the database is a misconfiguration that will
   never fix itself, so it has to say so rather than showing an
   empty feed and letting you guess. */
let denied = false;
function paintBanner() {
  const b = $("offline-banner");
  if (!navigator.onLine) {
    b.textContent = "Offline — saved here, will sync";
    b.hidden = false;
  } else if (denied) {
    b.textContent = "Signed in, but the database is refusing you — check allowed_emails";
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}
const showOffline = () => paintBanner();

function updateCommit() {
  const text = $("composer").value.trim();
  const has = !!(text || S.draft.audio || S.draft.photo);
  if (!$("compose-preview").hidden) paintPreview();
  $("btn-commit").disabled = !has;
  // With something in the box, Cancel doesn't throw it away — it
  // puts it down. Say so. Clear is the actual bin.
  $("btn-cancel").textContent = has ? "Later" : "Cancel";
  $("btn-clear").hidden = !has;
  paintOpener(text, has);
}

/* A parked draft shows as a red dot on the + — a reminder, not a nag. */
function paintOpener(text, has) {
  $("btn-compose").classList.toggle("has-draft", has);
  $("btn-compose").setAttribute("aria-label", has ? "New idea (draft waiting)" : "New idea");
}

function initial() {
  const n = (S.profileName || S.user?.email || "").trim();
  return n ? n[0].toUpperCase() : "·";
}

/* ---- composer: modal on desktop, sheet on a phone ------------- */
const isPhone = () => matchMedia("(max-width: 599px)").matches;
let closing = null;

function openComposer({ focus = true } = {}) {
  const d = $("compose");
  if (d.open && d.dataset.state === "open") { if (focus) $("composer").focus(); return; }
  clearTimeout(closing);
  $("compose-avatar").textContent = initial();
  const empty = !$("composer").value.trim() && !S.draft.audio && !S.draft.photo;
  if (empty && S.cat && S.cat !== "none" && !S.draft.tagIds.length) {
    S.draft.tagIds = [S.cat];
    renderTypebar();
  }
  $("compose-name").textContent = S.profileName || "you";
  trackViewport(true);
  d.style.removeProperty("--drag");
  if (!d.open) d.showModal();
  // Focus inside the tap, or iOS won't raise the keyboard.
  if (focus) $("composer").focus({ preventScroll: true });
  requestAnimationFrame(() => requestAnimationFrame(() => { d.dataset.state = "open"; }));
  growComposer();
}

function closeComposer() {
  const d = $("compose");
  if (!d.open) return;
  stopRec();
  d.dataset.state = "closing";
  d.style.removeProperty("--drag");
  const done = () => {
    clearTimeout(closing);
    d.removeEventListener("transitionend", onEnd);
    if (d.dataset.state === "closing") {
      d.close(); delete d.dataset.state; trackViewport(false);
      $("compose-preview").hidden = true; $("composer").hidden = false;
      $("btn-preview").setAttribute("aria-pressed", "false");
    }
  };
  const onEnd = (e) => { if (e.target === d && e.propertyName === "transform") done(); };
  d.addEventListener("transitionend", onEnd);
  closing = setTimeout(done, 380);           // reduced motion, or no transition fired
}

function growComposer() {
  const c = $("composer");
  // on a phone, or full screen, it just fills the space it's given
  if (isPhone() || $("compose").classList.contains("sheet--full")) { c.style.height = ""; return; }
  c.style.height = "auto";
  c.style.height = c.scrollHeight + "px";
}

/* iOS lays the keyboard over the page instead of resizing it, so a
   bottom-anchored sheet would hide its own buttons. Pin the sheet to
   the visual viewport instead. */
function trackViewport(on) {
  const vv = window.visualViewport;
  if (!vv) return;
  const set = () => {
    document.documentElement.style.setProperty("--vv-top", vv.offsetTop + "px");
    document.documentElement.style.setProperty("--vv-h", vv.height + "px");
  };
  if (on) { set(); vv.addEventListener("resize", set); vv.addEventListener("scroll", set); trackViewport.set = set; }
  else if (trackViewport.set) {
    vv.removeEventListener("resize", trackViewport.set);
    vv.removeEventListener("scroll", trackViewport.set);
  }
}

function clearDraft() {
  $("composer").value = "";
  S.draft = { tagIds: [], audio: null, audioMs: 0, photo: null };
  renderAttached(); renderTypebar(); updateCommit(); growComposer();
  $("composer").focus();
}

/* Preview renders what you've typed, Markdown and all. */
function paintPreview() {
  const [head, rest] = split($("composer").value);
  const p = $("compose-preview");
  p.innerHTML = "";
  p.appendChild(el("h2", "post__head", head || "Untitled"));
  const b = el("div", "post__md");
  b.innerHTML = md(rest);
  p.appendChild(b);
}
function setPreview(on) {
  $("btn-preview").setAttribute("aria-pressed", String(on));
  $("compose-preview").hidden = !on;
  $("composer").hidden = on;
  if (on) paintPreview(); else $("composer").focus();
}

function wireComposer() {
  const d = $("compose");
  $("btn-preview").onclick = () => setPreview($("compose-preview").hidden);
  $("btn-expand").onclick = () => {
    const on = !d.classList.contains("sheet--full");
    d.classList.toggle("sheet--full", on);
    $("btn-expand").setAttribute("aria-pressed", String(on));
    growComposer();
    $("composer").focus();
  };
  $("btn-cancel").onclick = closeComposer;
  $("btn-clear").onclick = clearDraft;

  // Escape: animate out rather than vanish
  d.addEventListener("cancel", (e) => { e.preventDefault(); closeComposer(); });

  // A click on the backdrop lands on the dialog itself, outside its box.
  d.addEventListener("click", (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) closeComposer();
  });

  // Chips and the attachment row shouldn't take focus from the text,
  // or the keyboard drops and the sheet jumps under your thumb.
  for (const id of ["typebar", "attached", "btn-photo"]) {
    $(id).addEventListener("pointerdown", (e) => e.preventDefault());
  }

  // Pull the sheet down by its handle to put it away.
  const grab = $("compose-grab");
  let y0 = null, t0 = 0, dy = 0;
  grab.addEventListener("pointerdown", (e) => {
    if (!isPhone()) return;
    y0 = e.clientY; t0 = performance.now(); dy = 0;
    grab.setPointerCapture(e.pointerId);
    d.classList.add("is-dragging");
  });
  grab.addEventListener("pointermove", (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.clientY - y0);
    d.style.setProperty("--drag", dy + "px");
  });
  const end = () => {
    if (y0 === null) return;
    const v = dy / Math.max(1, performance.now() - t0);   // px per ms
    y0 = null;
    d.classList.remove("is-dragging");
    if (dy > 120 || v > 0.6) closeComposer();
    else d.style.removeProperty("--drag");
  };
  grab.addEventListener("pointerup", end);
  grab.addEventListener("pointercancel", end);
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
      }
      mediaRec = null;
      updateCommit();
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
    tag_ids: [...S.draft.tagIds],
    type_id: S.draft.tagIds[0] || null,      // for the old single-tag column
    created_at: new Date().toISOString(),   // capture time, not insert time
    audio: S.draft.audio,
    audio_ms: S.draft.audioMs || null,
    photo: S.draft.photo,
    author_name: S.profileName || "you",
  };

  await queue.put(item);
  S.pending.unshift(item);

  $("composer").value = "";
  S.draft = { tagIds: [], audio: null, audioMs: 0, photo: null };
  renderAttached();
  renderTypebar();
  setPreview(false);
  updateCommit();
  render();
  closeComposer();
  $("posts-panel").scrollTo({ top: 0, behavior: "smooth" });

  syncQueue();
  askForSync();
}

/* ---- sync ---------------------------------------------------
   client_id is unique in the database, so every step here is
   safe to retry. A flaky tunnel can fire the same entry five
   times and you still get one row. */
let syncing = false;

/* One queued edit: text, tags and/or the photo. */
async function syncEdit(item) {
  const patch = { ...(item.patch || {}) };
  if (item.photo) {
    const ext = (item.photo.name?.split(".").pop() || "jpg").toLowerCase().slice(0, 4);
    const path = `${S.user.id}/${item.entry_id}-${Date.now().toString(36)}.${ext}`;
    await API.upload("photos", path, item.photo);
    patch.photo_path = path;
  } else if (item.remove_photo) {
    patch.photo_path = null;
  }
  if (item.tag_ids && !S.v2) patch.type_id = item.tag_ids[0] || null;
  if (Object.keys(patch).length) await api.patchEntry(item.entry_id, patch);
  if (item.tag_ids && S.v2) await api.setEntryTags(item.entry_id, item.tag_ids);
}

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
        if (item.kind === "edit") { await syncEdit(item); await queue.del(item.client_id); continue; }
        if (item.kind === "like") {
          if (S.v2 !== false) {
            if (item.on) await api.like(item.entry_id);
            else await api.unlike(item.entry_id, S.user.id);
          }
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
        if (S.v2 && item.tag_ids?.length) await api.setEntryTags(row.id, item.tag_ids);
        if (patch.audio_path) API.requestTranscript(row.id, patch.audio_path);
        API.notifyOther(row.id, item.body.slice(0, 80));

        await queue.del(item.client_id);
      } catch (e) {
        // An edit or like aimed at a post that's since been deleted
        // will never succeed. Drop it rather than jam the queue.
        if ((item.kind === "edit" || item.kind === "like") && [400, 404, 409].includes(e.status)) {
          await queue.del(item.client_id);
          continue;
        }
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
function renderTypebar() {
  const bar = $("typebar");
  bar.innerHTML = "";
  for (const t of S.types) {
    const c = el("button", "chip", t.label);
    c.type = "button";
    c.setAttribute("aria-pressed", String(S.draft.tagIds.includes(t.id)));
    c.onclick = () => {
      const on = S.draft.tagIds.includes(t.id);
      S.draft.tagIds = on ? S.draft.tagIds.filter((x) => x !== t.id) : [...S.draft.tagIds, t.id];
      renderTypebar();
      updateCommit();
    };
    bar.appendChild(c);
  }
  bar.appendChild(newTagChip((t) => {
    S.draft.tagIds = [...S.draft.tagIds, t.id];
    renderTypebar();
    updateCommit();
  }));
}

/* "+ New tag" — becomes a field in place, Return makes the tag. */
function newTagChip(onMade) {
  const c = el("button", "chip chip--new", "+ New tag");
  c.type = "button";
  c.onclick = () => {
    const f = el("input", "chip chip--input");
    f.placeholder = "Tag name";
    f.setAttribute("aria-label", "New tag name");
    c.replaceWith(f);
    f.focus();
    const done = async (save) => {
      const label = f.value.trim();
      f.disabled = true;
      if (save && label) {
        const t = await makeTag(label);
        if (t) { onMade(t); return; }
      }
      f.replaceWith(newTagChip(onMade));
    };
    f.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
    });
    f.addEventListener("blur", () => { if (!f.disabled) done(!!f.value.trim()); });
  };
  return c;
}

async function makeTag(label) {
  const existing = S.types.find((t) => t.label.toLowerCase() === label.toLowerCase());
  if (existing) return existing;
  if (!navigator.onLine) { status("New tags need a connection."); return null; }
  try {
    const [t] = await api.createType(label);
    S.types.push(t);
    await meta.set("types", S.types);
    render();
    return t;
  } catch { status("Couldn't add that tag."); return null; }
}

function allItems() {
  const label = (id) => S.types.find((t) => t.id === id)?.label || "";
  const pend = S.pending
    .filter((p) => p.kind === "entry")
    .map((p) => ({
      id: "p:" + p.client_id,
      client_id: p.client_id,
      body: p.body,
      type_id: p.type_id,
      tag_ids: p.tag_ids || (p.type_id ? [p.type_id] : []),
      author_name: p.author_name,
      created_at: p.created_at,
      audio_ms: p.audio_ms,
      _localAudio: p.audio,
      _localPhoto: p.photo,
      _pending: true,
      reply_count: 0,
      liked_by: [],
    }));

  // Queued edits and likes are laid over the server's copy, so a
  // change shows the moment you make it and survives a refresh that
  // lands before the queue has caught up.
  const rows = S.entries.map((e) => ({ ...e }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const me = S.profileName || "you";
  for (const q of [...S.pending].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const r = byId.get(q.entry_id);
    if (!r) continue;
    if (q.kind === "edit") {
      if (q.patch) Object.assign(r, q.patch);
      if (q.tag_ids) r.tags = q.tag_ids.map((id) => ({ id, label: label(id) })).filter((t) => t.label);
      if (q.photo) { r._localPhoto = q.photo; r.photo_path = null; }
      if (q.remove_photo) { r._localPhoto = null; r.photo_path = null; }
    }
    if (q.kind === "like") {
      const names = (r.liked_by || []).filter((n) => n !== me);
      r.liked_by = q.on ? [...names, me] : names;
      r.liked_by_me = q.on;
    }
  }
  return [...pend, ...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/* ---- the home list: tags with counts ------------------------------ */
function catsWithCounts(items) {
  const count = new Map();
  for (const i of items) {
    const ids = tagIdsOf(i);
    if (!ids.length) count.set("none", (count.get("none") || 0) + 1);
    for (const id of ids) count.set(id, (count.get(id) || 0) + 1);
  }
  const rows = S.types.map((t) => ({ id: t.id, label: t.label, n: count.get(t.id) || 0 }));
  if (count.get("none")) rows.push({ id: "none", label: "Untagged", n: count.get("none") });
  return rows;
}

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>';
const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3s-7.8-4.7-7.8-10.6A4.4 4.4 0 0 1 12 7.1a4.4 4.4 0 0 1 7.8 2.6c0 5.9-7.8 10.6-7.8 10.6Z"/></svg>';

function catRow(label, n, id) {
  const b = el("button", "cat" + (id === null ? " cat--all" : ""));
  b.type = "button";
  b.dataset.cat = id ?? "";
  if (S.cat === id) b.setAttribute("aria-current", "true");
  b.appendChild(el("span", "cat__name", label));
  b.appendChild(el("span", "cat__n", String(n)));
  const c = el("span", "cat__chev"); c.innerHTML = CHEVRON;
  b.appendChild(c);
  b.onclick = () => { setCat(id); openSheet(); };
  return b;
}

function render() {
  const all = allItems();

  const cats = $("cats");
  cats.innerHTML = "";
  // "All posts" lives in the peek bar on a phone; on a wide screen
  // there's no peek bar, so it becomes the first row (CSS decides).
  cats.appendChild(catRow("All posts", all.length, null));
  for (const c of catsWithCounts(all)) cats.appendChild(catRow(c.label, c.n, c.id));
  $("empty").hidden = all.length > 0;

  // the sheet's title only appears when it's narrowed to one tag
  const t = S.cat === null ? null
    : S.cat === "none" ? "Untagged"
    : S.types.find((x) => x.id === S.cat)?.label || "";
  $("posts-title").hidden = t === null;
  $("posts-title-text").textContent = t || "";

  for (const m of ["all", "photo", "audio"]) {
    $("m-" + m).setAttribute("aria-pressed", String(S.media === m));
  }
  $("sort-label").textContent =
    S.sort === "new" ? "Sort by" : S.sort === "old" ? "Oldest" : "Shuffled";
  $("v-feed").setAttribute("aria-pressed", String(S.view === "feed"));
  $("v-grid").setAttribute("aria-pressed", String(S.view === "grid"));

  let items = all;
  if (S.cat === "none") items = items.filter((i) => !tagIdsOf(i).length);
  else if (S.cat !== null) items = items.filter((i) => tagIdsOf(i).includes(S.cat));
  if (S.media === "photo") items = items.filter((i) => i.photo_path || i._localPhoto);
  if (S.media === "audio") items = items.filter((i) => i.audio_path || i._localAudio);
  if (S.sort === "old") items = [...items].reverse();
  if (S.sort === "shuffle") {
    const r = seeded(String(S.shuffleSeed));
    items = items.map((i) => [r(), i]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  }

  const feed = $("feed");
  feed.innerHTML = "";
  feed.classList.toggle("feed--grid", S.view === "grid");
  $("posts").classList.toggle("is-grid", S.view === "grid");
  for (const i of items) feed.appendChild(card(i));
  if (!items.length) {
    feed.appendChild(el("p", "nomatch", all.length ? "Nothing here with that filter." : "Nothing yet."));
  }
  if (!$("detail").hidden && S.openId && !S.editing) paintDetail();
}

function setCat(id) {
  S.cat = id;
  render();
  $("posts-panel").scrollTop = 0;
}

/* ---- one post ------------------------------------------------------
   Photo on top, who/when in mono, the heading, a few lines of the
   body, then the tags, a heart and the reply count. The same element
   is a row in the feed and a card in the grid; CSS decides which. */
const EXCERPT = 320;

function card(i) {
  const c = el("article", "card post" + (i._pending ? " card--pending" : ""));
  c.tabIndex = 0;

  if (i.photo_path || i._localPhoto) c.appendChild(photo(i));

  c.appendChild(metaRow(i));

  const fromVoice = !i.body && i.transcript;
  const [head, body] = split(i.body || i.transcript);
  c.appendChild(el("h2", "post__head card__body" + (fromVoice ? " card__body--muted" : ""),
    head || (i.audio_path || i._localAudio ? "Voice note" : "")));
  if (body) {
    const text = plain(body).replace(/\s*\n\s*/g, " ");   // one paragraph in the list
    c.appendChild(el("p", "post__body", text.length > EXCERPT ? text.slice(0, EXCERPT).replace(/\s+\S*$/, "").replace(/[\s.,;:!?…-]+$/, "") + "…" : text));
    if (text.length > EXCERPT || body.includes("\n")) c.appendChild(el("span", "post__more", "Read more"));
  }

  if (i.audio_path || i._localAudio) c.appendChild(waveform(i, true));
  c.appendChild(footRow(i));

  c.onclick = () => openDetail(i.id);
  c.onkeydown = (e) => { if (e.key === "Enter" && e.target === c) openDetail(i.id); };
  return c;
}

function metaRow(i) {
  const m = el("div", "post__meta");
  m.appendChild(el("span", "who", i.author_name || "—"));
  const w = el("span", "when", ago(i.created_at));
  if (i.edited_at) w.appendChild(el("span", "edited", " · edited"));
  m.appendChild(w);
  return m;
}

/* tags (tap one to see everything with it), +, heart, replies */
function footRow(i, { full = false } = {}) {
  const f = el("div", "post__foot");
  const tags = el("div", "post__tags");
  for (const t of tagsOf(i)) {
    const b = el("button", "tag", t.label);
    b.type = "button";
    b.title = `Everything tagged ${t.label}`;
    b.onclick = (e) => {
      e.stopPropagation();
      if (!$("detail").hidden) closeDetail();
      setCat(t.id); openSheet();
    };
    tags.appendChild(b);
  }
  const add = el("button", "tag tag--add", tagsOf(i).length ? "+" : "+ Tag");
  add.type = "button";
  add.setAttribute("aria-label", "Change tags");
  add.title = "Add or remove tags";
  add.onclick = (e) => { e.stopPropagation(); openTagPicker(add, i); };
  tags.appendChild(add);
  f.appendChild(tags);

  const right = el("div", "post__acts");
  if (S.v2 !== false && !i._pending) {
    const n = (i.liked_by || []).length;
    const like = el("button", "like");
    like.type = "button";
    like.innerHTML = HEART;
    like.setAttribute("aria-pressed", String(!!i.liked_by_me));
    like.setAttribute("aria-label", i.liked_by_me ? "Unlike" : "Like");
    if (n) like.appendChild(el("span", "like__n", String(n)));
    like.onclick = (e) => { e.stopPropagation(); toggleLike(i); };
    right.appendChild(like);
  }
  if (!full && i.reply_count > 0) right.appendChild(el("span", "post__note", `${i.reply_count} ${i.reply_count === 1 ? "reply" : "replies"}`));
  if (i._pending) right.appendChild(el("span", "post__note pendingmark", "not synced"));
  f.appendChild(right);
  return f;
}

/* ---- tag picker: tick tags on and off without opening the post ---- */
let picker = null;

function closePicker() {
  if (!picker) return;
  picker.el.remove();
  document.removeEventListener("pointerdown", picker.outside, true);
  document.removeEventListener("keydown", picker.key, true);
  picker = null;
}

function openTagPicker(anchor, item) {
  closePicker();
  const pop = el("div", "picker");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Tags");
  const list = el("div", "picker__list");
  pop.appendChild(list);

  const paint = () => {
    const now = allItems().find((x) => x.id === item.id) || item;
    const ids = tagIdsOf(now);
    list.innerHTML = "";
    for (const t of S.types) {
      const b = el("button", "picker__opt");
      b.type = "button";
      b.setAttribute("aria-pressed", String(ids.includes(t.id)));
      b.appendChild(el("span", "picker__tick"));
      b.appendChild(el("span", null, t.label));
      b.onclick = () => {
        const next = ids.includes(t.id) ? ids.filter((x) => x !== t.id) : [...ids, t.id];
        setTags(now, next).then(paint);
      };
      list.appendChild(b);
    }
    const old = pop.querySelector(".chip--new, .chip--input");
    if (old) old.remove();
    pop.appendChild(newTagChip((t) => {
      const cur = tagIdsOf(allItems().find((x) => x.id === item.id) || item);
      setTags(now, [...cur, t.id]).then(paint);
    }));
  };
  paint();
  document.body.appendChild(pop);

  // under the button if it fits, otherwise above; never off-screen
  const r = anchor.getBoundingClientRect();
  const h = pop.offsetHeight, w = pop.offsetWidth;
  const below = r.bottom + 8 + h < innerHeight - 8;
  pop.style.top = Math.max(8, below ? r.bottom + 8 : r.top - 8 - h) + "px";
  pop.style.left = Math.min(Math.max(8, r.left), innerWidth - w - 8) + "px";

  const outside = (e) => { if (!pop.contains(e.target)) closePicker(); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); closePicker(); } };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", key, true);
  picker = { el: pop, outside, key };
}

/* ---- changing a post ------------------------------------------------
   Everything goes through the queue, same as a new post: instant here,
   synced when the network allows. */
const now = () => new Date().toISOString();

async function editPending(item, change) {
  const q = (await queue.all()).find((x) => x.client_id === item.client_id);
  if (!q) return;
  Object.assign(q, change);
  await queue.put(q);
}

async function setTags(item, ids) {
  if (item._pending) await editPending(item, { tag_ids: ids, type_id: ids[0] || null });
  else await queue.put({ client_id: uid(), kind: "edit", entry_id: item.id, tag_ids: ids, created_at: now() });
  S.pending = await queue.all();
  render();
  syncQueue();
}

async function toggleLike(item) {
  if (item._pending || S.v2 === false) return;
  await queue.put({ client_id: uid(), kind: "like", entry_id: item.id, on: !item.liked_by_me, created_at: now() });
  S.pending = await queue.all();
  render();
  syncQueue();
}

/* ---- the posts sheet --------------------------------------------
   One element, three states: peeking ("All posts"), open, and — on a
   wide screen — not a sheet at all. */
const isWide = () => matchMedia("(min-width: 900px)").matches;

function sheetTop() {
  // the sheet stops just under the masthead, leaving room for the grabber
  const r = $("top").getBoundingClientRect();
  document.documentElement.style.setProperty("--sheet-top", Math.round(r.bottom + 22) + "px");
}

function openSheet() {
  if (isWide()) return;
  sheetTop();
  const p = $("posts");
  p.style.removeProperty("--drag");
  p.dataset.state = "open";
  document.body.classList.add("sheet-open");
  $("posts-peek").setAttribute("aria-expanded", "true");
}

function closeSheet() {
  const p = $("posts");
  p.style.removeProperty("--drag");
  p.dataset.state = "closed";
  document.body.classList.remove("sheet-open");
  $("posts-peek").setAttribute("aria-expanded", "false");
}

function wirePosts() {
  const p = $("posts");
  closeSheet();
  sheetTop();
  addEventListener("resize", () => { sheetTop(); if (isWide()) closeSheet(); });

  $("posts-peek").onclick = () => { setCat(null); openSheet(); };
  $("scrim").onclick = closeSheet;
  $("posts-clear").onclick = () => setCat(null);

  for (const m of ["all", "photo", "audio"]) {
    $("m-" + m).onclick = () => { S.media = m; render(); $("posts-panel").scrollTop = 0; };
  }
  $("sort").onchange = (e) => {
    S.sort = e.target.value;
    if (S.sort === "shuffle") S.shuffleSeed = Date.now();
    render();
    $("posts-panel").scrollTop = 0;
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && p.dataset.state === "open" && $("detail").hidden && !$("compose").open) closeSheet();
  });

  // Drag by the grabber or the filter bar; or pull the list down
  // when it's already at the top. Past a third of the way, or a
  // decent flick, and it goes.
  const panel = $("posts-panel");
  panel.addEventListener("scroll", () => {
    panel.classList.toggle("is-scrolled", panel.scrollTop > 2);
  }, { passive: true });
  let y0 = null, t0 = 0, dy = 0, fromList = false;
  const start = (e, list) => {
    if (isWide() || p.dataset.state !== "open") return;
    if (list && panel.scrollTop > 0) return;
    y0 = e.clientY; t0 = performance.now(); dy = 0; fromList = list;
  };
  const move = (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.clientY - y0);
    if (fromList && dy < 8) return;          // let small moves be taps/scrolls
    if (fromList && panel.scrollTop > 0) { y0 = null; return; }
    p.classList.add("is-dragging");
    p.style.setProperty("--drag", dy + "px");
  };
  const end = () => {
    if (y0 === null) return;
    const v = dy / Math.max(1, performance.now() - t0);
    y0 = null;
    p.classList.remove("is-dragging");
    if (dy > window.innerHeight / 3 || (dy > 40 && v > 0.6)) closeSheet();
    else p.style.removeProperty("--drag");
  };
  for (const h of [$("posts-grab"), $("posts-head")]) {
    h.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, select, label")) return;
      start(e, false);
      h.setPointerCapture(e.pointerId);
    });
    h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", end);
  }
  panel.addEventListener("touchstart", (e) => start(e.touches[0], true), { passive: true });
  panel.addEventListener("touchmove", (e) => {
    move(e.touches[0]);
    if (y0 !== null && dy >= 8 && e.cancelable) e.preventDefault();
  }, { passive: false });
  panel.addEventListener("touchend", end);
  panel.addEventListener("touchcancel", end);
}

/* A row of solid blocks, not a smooth waveform. A waveform is a
   data visualisation; this is a printed object. Heights are
   seeded off the id so they're stable. */
function waveform(i, small = false) {
  const w = el("div", "wave" + (small ? " wave--small" : ""));
  const rnd = seeded(i.id + "w");
  const n = small ? 28 : 44;
  for (let k = 0; k < n; k++) {
    const bar = el("i");
    bar.style.height = small
      ? `${4 + Math.round(rnd() * 10)}px`
      : `${6 + Math.round(rnd() * 20)}px`;
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
  closePicker();
  S.openId = id;
  S.editing = false;
  S.shuffleOpen = isShuffle;
  $("detail").hidden = false;
  document.body.classList.add("detail-open");
  const body = $("detail-body");
  body.innerHTML = "";
  body.appendChild(el("div", "post post--full")).id = "detail-post";
  body.appendChild(el("div", "detail__thread")).id = "detail-thread";
  paintDetail();
  $("detail-body").scrollTop = 0;
  loadThread(id);
}

function closeDetail() {
  closePicker();
  $("detail").hidden = true;
  document.body.classList.remove("detail-open");
  S.openId = null;
  S.editing = false;
  disarm($("detail-delete"));
}

const openItem = () => allItems().find((x) => x.id === S.openId);

/* The post half of the view. The thread below is built once per open
   and left alone, so a sync landing mid-reply can't eat what you're
   typing. */
function paintDetail() {
  const i = openItem();
  if (!i) return closeDetail();
  const editing = S.editing;

  $("detail-label").textContent = S.shuffleOpen && !editing ? "From the pile" : editing ? "Editing" : "";
  $("detail-again").hidden = !S.shuffleOpen || editing;
  $("detail").classList.toggle("is-shuffle", S.shuffleOpen && !editing);
  $("detail").classList.toggle("is-editing", editing);
  $("detail-close").hidden = editing;
  $("detail-edit").hidden = editing;
  $("detail-delete").hidden = editing;
  $("detail-cancel").hidden = !editing;
  $("detail-save").hidden = !editing;
  $("detail-thread").hidden = editing;

  const post = $("detail-post");
  post.innerHTML = "";
  if (editing) return paintEditor(post, i);

  if (i.photo_path || i._localPhoto) post.appendChild(photo(i));
  post.appendChild(metaRow(i));
  const [head, rest] = split(i.body || i.transcript);
  post.appendChild(el("h2", "post__head", head || "Voice note"));
  if (rest) {
    const b = el("div", "post__md");
    b.innerHTML = md(rest);          // md() escapes first; see md.js
    post.appendChild(b);
  }
  if (i.audio_path || i._localAudio) post.appendChild(waveform(i));
  post.appendChild(footRow(i, { full: true }));
  const likers = i.liked_by || [];
  if (likers.length) {
    const names = likers.map((n) => (n === S.profileName ? "you" : n));
    post.appendChild(el("p", "likedby",
      "Liked by " + (names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names.at(-1) : names[0])));
  }
}

async function loadThread(id) {
  const box = $("detail-thread");
  const i = openItem();
  if (!i || i._pending) return;
  const thread = el("div", "thread");
  box.appendChild(thread);
  const reply = (who, text) => {
    const p = el("p", "reply");
    p.appendChild(el("span", "reply__who", who));
    p.appendChild(document.createTextNode(text));
    thread.appendChild(p);
  };
  try {
    const rs = await api.replies(id);
    if (S.openId !== id) return;
    for (const r of rs) reply(r.profiles?.display_name || "", r.body);
  } catch {}

  const rb = el("div", "replybox");
  const input = el("input");
  input.placeholder = "Riff on it…";
  input.setAttribute("aria-label", "Reply");
  input.onclick = (e) => e.stopPropagation();
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !input.value.trim()) return;
    const item = { client_id: uid(), kind: "reply", entry_id: id, body: input.value.trim(), created_at: now() };
    await queue.put(item);
    reply(S.profileName || "you", item.body);
    input.value = "";
    syncQueue();
  });
  rb.appendChild(input);
  box.appendChild(rb);
}

/* ---- editing ---------------------------------------------------------
   The whole post is one Markdown field: first line is the heading. */
function startEdit() {
  const i = openItem();
  if (!i) return;
  S.editing = true;
  S.edit = { text: i.body || i.transcript || "", tagIds: tagIdsOf(i), photo: null, removePhoto: false, preview: false };
  paintDetail();
  const t = $("detail-post").querySelector(".editor");
  if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
}

function paintEditor(post, i) {
  const E = S.edit;
  const tabs = el("div", "edtabs");
  for (const [label, on] of [["Write", false], ["Preview", true]]) {
    const b = el("button", "edtabs__btn", label);
    b.type = "button";
    b.setAttribute("aria-pressed", String(E.preview === on));
    b.onclick = () => { E.preview = on; paintDetail(); };
    tabs.appendChild(b);
  }
  tabs.appendChild(el("span", "edtabs__hint", "Markdown · first line is the heading"));
  post.appendChild(tabs);

  if (E.preview) {
    const [head, rest] = split(E.text);
    post.appendChild(el("h2", "post__head", head || "Untitled"));
    const b = el("div", "post__md");
    b.innerHTML = md(rest);
    post.appendChild(b);
  } else {
    const t = el("textarea", "editor");
    t.value = E.text;
    t.setAttribute("aria-label", "Post");
    t.autocapitalize = "sentences";
    const grow = () => { t.style.height = "auto"; t.style.height = Math.max(240, t.scrollHeight) + "px"; };
    t.oninput = () => { E.text = t.value; grow(); };
    t.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); } };
    post.appendChild(t);
    requestAnimationFrame(grow);
  }

  // tags
  post.appendChild(el("div", "edlabel", "Tags"));
  const tags = el("div", "edtags");
  for (const t of S.types) {
    const c = el("button", "chip", t.label);
    c.type = "button";
    c.setAttribute("aria-pressed", String(E.tagIds.includes(t.id)));
    c.onclick = () => {
      E.tagIds = E.tagIds.includes(t.id) ? E.tagIds.filter((x) => x !== t.id) : [...E.tagIds, t.id];
      paintDetail();
    };
    tags.appendChild(c);
  }
  tags.appendChild(newTagChip((t) => { E.tagIds = [...E.tagIds, t.id]; paintDetail(); }));
  post.appendChild(tags);

  // photo
  post.appendChild(el("div", "edlabel", "Photo"));
  const ph = el("div", "edphoto");
  const has = !E.removePhoto && (E.photo || i.photo_path || i._localPhoto);
  if (has) {
    const img = el("img", "edphoto__img");
    img.alt = "";
    if (E.photo) img.src = URL.createObjectURL(E.photo);
    else if (i._localPhoto) img.src = URL.createObjectURL(i._localPhoto);
    else API.signedUrl("photos", i.photo_path).then((u) => { if (u) img.src = u; });
    ph.appendChild(img);
  }
  const pick = el("input");
  pick.type = "file"; pick.accept = "image/*"; pick.hidden = true;
  pick.onchange = () => { const f = pick.files[0]; if (f) { E.photo = f; E.removePhoto = false; paintDetail(); } };
  const btn = el("button", "chip", has ? "Replace" : "Add a photo");
  btn.type = "button";
  btn.onclick = () => pick.click();
  ph.appendChild(btn);
  if (has) {
    const rm = el("button", "chip chip--ghost", "Remove");
    rm.type = "button";
    rm.onclick = () => { E.photo = null; E.removePhoto = true; paintDetail(); };
    ph.appendChild(rm);
  }
  ph.appendChild(pick);
  post.appendChild(ph);
}

async function saveEdit() {
  const i = openItem();
  const E = S.edit;
  if (!i || !E) return;
  const text = E.text.trim();
  const before = (i.body || i.transcript || "").trim();
  const tagsChanged = E.tagIds.join() !== tagIdsOf(i).join();
  const photoChanged = !!E.photo || E.removePhoto;
  if (!text && !(i.audio_path || i._localAudio) && !E.photo && (E.removePhoto || !(i.photo_path || i._localPhoto))) {
    status("A post needs words, a recording or a photo.");
    return;
  }

  if (i._pending) {
    const change = { body: text };
    if (tagsChanged) Object.assign(change, { tag_ids: E.tagIds, type_id: E.tagIds[0] || null });
    if (E.photo) change.photo = E.photo;
    if (E.removePhoto) change.photo = null;
    await editPending(i, change);
  } else if (text !== before || tagsChanged || photoChanged) {
    const item = { client_id: uid(), kind: "edit", entry_id: i.id, created_at: now() };
    if (text !== before) item.patch = { body: text, edited_at: now() };
    if (tagsChanged) item.tag_ids = E.tagIds;
    if (E.photo) item.photo = E.photo;
    if (E.removePhoto) item.remove_photo = true;
    await queue.put(item);
  }
  S.editing = false;
  S.edit = null;
  S.pending = await queue.all();
  render();
  paintDetail();
  syncQueue();
}

function cancelEdit() {
  S.editing = false;
  S.edit = null;
  paintDetail();
}

function shuffle() {
  const items = allItems();
  if (!items.length) return;
  openDetail(items[Math.floor(Math.random() * items.length)].id, true);
}

/* Two taps to delete: the first arms the button, the second does it. */
function arm(btn, label) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = "1";
  btn.dataset.label = btn.textContent;
  btn.textContent = label;
  btn.classList.add("is-armed");
  clearTimeout(btn._t);
  btn._t = setTimeout(() => disarm(btn), 3500);
  return false;
}
function disarm(btn) {
  if (!btn?.dataset.armed) return;
  clearTimeout(btn._t);
  btn.textContent = btn.dataset.label;
  delete btn.dataset.armed;
  btn.classList.remove("is-armed");
}

async function deleteOpen() {
  const btn = $("detail-delete");
  if (!arm(btn, "Tap again to delete")) return;
  disarm(btn);
  const i = openItem();
  if (!i) return;
  if (i._pending) {
    await queue.del(i.client_id);
    S.pending = await queue.all();
    closeDetail();
    render();
    return;
  }
  if (!navigator.onLine) { status("Deleting needs a connection."); return; }
  try {
    await api.deleteEntry(i.id);
    S.entries = S.entries.filter((e) => e.id !== i.id);
    await cache.replace(S.entries);
    closeDetail();
    render();
  } catch {}
}

/* ---- tags, the whole set (in Settings) -------------------------------- */
function renderTagManager() {
  const box = $("tagman");
  box.innerHTML = "";
  const counts = new Map(catsWithCounts(allItems()).map((c) => [c.id, c.n]));
  if (!S.types.length) box.appendChild(el("p", "tagrow__empty", "No tags yet."));
  for (const t of S.types) {
    const row = el("div", "tagrow");
    const name = el("input", "tagrow__name");
    name.value = t.label;
    name.setAttribute("aria-label", `Rename ${t.label}`);
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); if (e.key === "Escape") { name.value = t.label; name.blur(); } });
    name.addEventListener("change", () => renameTag(t, name.value.trim(), name));
    row.appendChild(name);
    row.appendChild(el("span", "tagrow__n", String(counts.get(t.id) || 0)));

    const merge = el("button", "tagrow__btn", "Merge");
    merge.type = "button";
    merge.onclick = () => openMerge(row, t);
    const del = el("button", "tagrow__btn tagrow__btn--del", "Delete");
    del.type = "button";
    del.onclick = () => { if (arm(del, "Sure?")) deleteTag(t); };
    row.appendChild(merge);
    row.appendChild(del);
    box.appendChild(row);
  }
}

function openMerge(row, t) {
  const open = row.querySelector(".tagrow__merge");
  if (open) { open.remove(); return; }
  if (S.v2 === false) { status("Merging needs the 002 database update — see db/002_tags_likes.sql."); return; }
  const others = S.types.filter((x) => x.id !== t.id);
  if (!others.length) { status("Nothing to merge into yet."); return; }
  const m = el("div", "tagrow__merge");
  m.appendChild(el("span", null, `Merge ${t.label} into`));
  const sel = el("select", "tagrow__select");
  for (const o of others) { const op = el("option", null, o.label); op.value = o.id; sel.appendChild(op); }
  const go = el("button", "tagrow__btn tagrow__btn--go", "Merge");
  go.type = "button";
  go.onclick = () => mergeTag(t, sel.value);
  m.appendChild(sel);
  m.appendChild(go);
  row.appendChild(m);
}

async function tagOp(fn, ok) {
  if (!navigator.onLine) { status("Tag changes need a connection."); return; }
  try { await fn(); await loadTypes(); await refreshFromServer(); renderTagManager(); status(ok); }
  catch { status("Couldn't do that — try again."); }
}
const renameTag = (t, label, input) => {
  if (!label || label === t.label) { input.value = t.label; return; }
  tagOp(() => api.renameType(t.id, label), `Renamed to ${label}.`);
};
const mergeTag = (t, targetId) => {
  const target = S.types.find((x) => x.id === targetId);
  tagOp(() => api.mergeTags([t.id], targetId), `Merged ${t.label} into ${target?.label}.`);
  if (S.cat === t.id) S.cat = targetId;
};
const deleteTag = (t) => {
  tagOp(() => api.deleteType(t.id), `Deleted ${t.label}. Its posts are still here.`);
  if (S.cat === t.id) S.cat = null;
};

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
