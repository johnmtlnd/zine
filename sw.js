/* ============================================================
   SERVICE WORKER

   Two jobs: make the shell load instantly with no signal, and
   wake the page up to flush the capture queue when the network
   comes back.

   Bump SHELL_V whenever you change a file in SHELL — otherwise
   browsers will happily serve the old one forever.
   ============================================================ */

const SHELL_V = "shell-v12";
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./auth.css",
  "./fonts/PPNikkeiMaru-Heavy.woff",
  "./fonts/PPNikkeiMaru-Regular.woff",
  "./theme-glass.css",
  "./theme-zine.css",
  "./app.js",
  "./api.js",
  "./db.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL_V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL_V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache Supabase. Stale data is worse than no data, and
  // signed storage URLs expire.
  if (url.origin !== self.location.origin) return;

  // Shell: cache first, revalidate in the background.
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res.ok) caches.open(SHELL_V).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

/* Background Sync where it exists (Chrome, Android). Safari
   doesn't implement it, which is why the app also flushes the
   queue on 'online' and on visibilitychange. */
self.addEventListener("sync", (e) => {
  if (e.tag === "flush-queue") e.waitUntil(pokeClients());
});

async function pokeClients() {
  const cs = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of cs) c.postMessage({ type: "flush" });
}

/* ---- push ---------------------------------------------------- */
self.addEventListener("push", (e) => {
  let data = { title: "New idea", body: "" };
  try { data = { ...data, ...e.data.json() }; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "entry",
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
      for (const c of cs) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    })
  );
});
