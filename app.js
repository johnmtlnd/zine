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
  return i < 0 ? [t, ""] : [t.slice(0, i).trim(), t.slice(i + 1).trim()];
}

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
  updateCommit();
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
    if (e.key !== "Enter") return;
    // With a keyboard: Return keeps it, Shift+Return is the next line.
    // On a phone Return has to be a newline — there's no Shift to
    // reach for, and the second line is where the body goes.
    const touch = matchMedia("(pointer: coarse)").matches;
    if (e.metaKey || e.ctrlKey || (!touch && !e.shiftKey)) { e.preventDefault(); commit(); }
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
    if (d.dataset.state === "closing") { d.close(); delete d.dataset.state; trackViewport(false); }
  };
  const onEnd = (e) => { if (e.target === d && e.propertyName === "transform") done(); };
  d.addEventListener("transitionend", onEnd);
  closing = setTimeout(done, 380);           // reduced motion, or no transition fired
}

function growComposer() {
  if (isPhone()) return;                      // on a phone it just fills the sheet
  const c = $("composer");
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
  S.draft = { typeId: null, audio: null, audioMs: 0, photo: null };
  renderAttached(); renderTypebar(); updateCommit(); growComposer();
  $("composer").focus();
}

function wireComposer() {
  const d = $("compose");
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
  S.draft = { typeId: S.draft.typeId, audio: null, audioMs: 0, photo: null };
  renderAttached();
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
function renderTypebar() {
  const bar = $("typebar");
  bar.innerHTML = "";
  for (const t of S.types) {
    const c = el("button", "chip", t.label);
    c.setAttribute("aria-pressed", String(S.draft.typeId === t.id));
    c.onclick = () => {
      S.draft.typeId = S.draft.typeId === t.id ? null : t.id;
      renderTypebar();
      updateCommit();
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

/* ---- the home list: categories with counts -------------------- */
function catsWithCounts(items) {
  const count = new Map();
  for (const i of items) {
    const k = i.type_id || "none";
    count.set(k, (count.get(k) || 0) + 1);
  }
  const rows = S.types.map((t) => ({ id: t.id, label: t.label, n: count.get(t.id) || 0 }));
  if (count.get("none")) rows.push({ id: "none", label: "Untyped", n: count.get("none") });
  return rows;
}

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>';

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

  // the sheet's title only appears when it's narrowed to one category
  const t = S.cat === null ? null
    : S.cat === "none" ? "Untyped"
    : S.types.find((x) => x.id === S.cat)?.label || "";
  $("posts-title").hidden = t === null;
  $("posts-title-text").textContent = t || "";

  for (const m of ["all", "photo", "audio"]) {
    $("m-" + m).setAttribute("aria-pressed", String(S.media === m));
  }
  $("sort-label").textContent =
    S.sort === "new" ? "Sort by" : S.sort === "old" ? "Oldest" : "Shuffled";

  let items = all;
  if (S.cat !== null) items = items.filter((i) => (i.type_id || "none") === S.cat);
  if (S.media === "photo") items = items.filter((i) => i.photo_path || i._localPhoto);
  if (S.media === "audio") items = items.filter((i) => i.audio_path || i._localAudio);
  if (S.sort === "old") items = [...items].reverse();
  if (S.sort === "shuffle") {
    const r = seeded(String(S.shuffleSeed));
    items = items.map((i) => [r(), i]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  }

  const feed = $("feed");
  feed.innerHTML = "";
  for (const i of items) feed.appendChild(card(i));
  if (!items.length) {
    feed.appendChild(el("p", "nomatch", all.length ? "Nothing here with that filter." : "Nothing yet."));
  }
}

function setCat(id) {
  S.cat = id;
  render();
  $("posts-panel").scrollTop = 0;
}

/* ---- one post ---------------------------------------------------
   Prototype order: photo full-bleed on top, then who/when in mono,
   the heading in Neue Montreal, the body in Schoolbook, the type as
   a black mono tag. */
function card(i) {
  const c = el("article", "card post" + (i._pending ? " card--pending" : ""));

  if (i.photo_path || i._localPhoto) c.appendChild(photo(i));

  const m = el("div", "post__meta");
  m.appendChild(el("span", "who", i.author_name || "—"));
  m.appendChild(el("span", "when", ago(i.created_at)));
  c.appendChild(m);

  const fromVoice = !i.body && i.transcript;
  const [head, body] = split(i.body || i.transcript);
  const h = el("h2", "post__head card__body" + (fromVoice ? " card__body--muted" : ""),
    head || (i.audio_path || i._localAudio ? "Voice note" : ""));
  c.appendChild(h);
  if (body) c.appendChild(el("p", "post__body", body));

  if (i.audio_path || i._localAudio) c.appendChild(waveform(i, true));

  const f = el("div", "post__foot");
  if (i.type_label) f.appendChild(el("span", "tag", i.type_label));
  if (i.reply_count > 0) f.appendChild(el("span", "post__note", `${i.reply_count} ${i.reply_count === 1 ? "reply" : "replies"}`));
  if (i._pending) f.appendChild(el("span", "post__note pendingmark", "not synced"));
  if (f.childNodes.length) c.appendChild(f);

  c.onclick = () => openDetail(i.id);
  return c;
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
  const i = allItems().find((x) => x.id === id);
  if (!i) return;
  S.openId = id;

  $("detail-label").textContent = isShuffle ? "From the pile" : "";
  $("detail-again").hidden = !isShuffle;
  $("detail").classList.toggle("is-shuffle", isShuffle);
  $("detail-delete").hidden = i._pending;

  const body = $("detail-body");
  body.innerHTML = "";
  const inner = el("div", "post post--full");

  // same anatomy as the row, just given room
  if (i.photo_path || i._localPhoto) inner.appendChild(photo(i));
  const m = el("div", "post__meta");
  m.appendChild(el("span", "who", i.author_name || "—"));
  m.appendChild(el("span", "when", ago(i.created_at)));
  inner.appendChild(m);
  const [head, rest] = split(i.body || i.transcript);
  inner.appendChild(el("h2", "post__head", head || "Voice note"));
  if (rest) inner.appendChild(el("p", "post__body", rest));
  if (i.audio_path || i._localAudio) inner.appendChild(waveform(i));
  if (i.type_label) {
    const f = el("div", "post__foot");
    f.appendChild(el("span", "tag", i.type_label));
    inner.appendChild(f);
  }
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
