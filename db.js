/* ============================================================
   LOCAL STORE — IndexedDB, hand-rolled, no dependencies.

   Two stores:
     queue  — captures that haven't reached the server yet,
              including their audio and photo blobs
     cache  — the last known server state, so the feed reads
              instantly and works with no signal
   ============================================================ */

const DB_NAME = "archive";
const DB_VERSION = 1;

let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "client_id" });
      }
      if (!db.objectStoreNames.contains("cache")) {
        db.createObjectStore("cache", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "k" });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/* ---- queue -------------------------------------------------- */
export const queue = {
  put:  (item) => tx("queue", "readwrite", s => s.put(item)),
  del:  (id)   => tx("queue", "readwrite", s => s.delete(id)),
  all:  ()     => tx("queue", "readonly",  s => s.getAll()),
  get:  (id)   => tx("queue", "readonly",  s => s.get(id)),
  count:()     => tx("queue", "readonly",  s => s.count()),
};

/* ---- cache -------------------------------------------------- */
export const cache = {
  put:  (item) => tx("cache", "readwrite", s => s.put(item)),
  all:  ()     => tx("cache", "readonly",  s => s.getAll()),
  clear:()     => tx("cache", "readwrite", s => s.clear()),
  async replace(items) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("cache", "readwrite");
      const s = t.objectStore("cache");
      s.clear();
      for (const it of items) s.put(it);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },
};

/* ---- meta (small key/value) --------------------------------- */
export const meta = {
  async get(k, fallback = null) {
    const r = await tx("meta", "readonly", s => s.get(k));
    return r ? r.v : fallback;
  },
  set: (k, v) => tx("meta", "readwrite", s => s.put({ k, v })),
};

/* ---- blob helpers ------------------------------------------- */
export function blobUrl(blob) {
  return blob ? URL.createObjectURL(blob) : null;
}
