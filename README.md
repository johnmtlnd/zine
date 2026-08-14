# A shared archive

Band names, t-shirt ideas, hats, whatever else. For two people.

**Start with [SETUP.md](SETUP.md).** Every step is a web page — no terminal.

---

## What's here

```
index.html              the whole app shell
app.js                  logic — capture, feed, sync, shuffle
api.js                  Supabase over plain fetch
db.js                   IndexedDB — the offline queue and cache
theme.css               ← the only file you need to touch
app.css                 structure and layout
sw.js                   service worker — offline shell, push
config.js               name, project URL, keys
manifest.webmanifest    home screen install
db/schema.sql           paste into Supabase once
functions/              two optional Edge Functions
test/smoke.py           34 browser tests against a mocked backend
```

No dependencies. No build step. No `node_modules`. The files you commit
are the files that run.

---

## Changing how it looks

Everything visual is a variable in `theme.css`, and it's commented with
what each one does and what the usable range is. Edit it in GitHub's web
editor, commit, and the site rebuilds.

The ones worth playing with first:

- `--accent` — one colour, used for one thing at a time
- `--halftone` and `--grain` — the photocopy texture. Push them up until
  it's too much, then back off
- `--tilt` — how crooked the cards sit. `0deg` for a straight grid
- `--font-display` — the condensed face in the masthead and labels

One gotcha: after any change, the service worker will keep serving the
old files until you bump `SHELL_V` in `sw.js`. That's the one piece of
housekeeping this thing asks of you.

---

## Running it locally

```
python3 -m http.server 8899
```

Then open `http://localhost:8899`. Auth and storage need the real
Supabase project, so `config.js` has to be filled in first.

To run the tests you need Playwright (`pip install playwright &&
playwright install chromium`), the server above, and then
`python3 test/smoke.py`. They stub out Supabase entirely, so they run
against nothing but the files in this folder.

---

## The shape of it

Capture is the home screen — the app opens into a focused input with the
keyboard up, and the feed starts immediately below. Everything on that
screen is measured against one number: open to committed in under three
seconds.

Captures are written to IndexedDB before anything touches the network, so
an idea is real to you the instant you hit return. `client_id` is
generated on-device and unique in the database, which makes every sync
step safe to retry — a flaky tunnel can fire the same entry five times
and you still get one row.

`created_at` is capture time, not insert time. An idea recorded in a
basement at 11pm and synced at 8am belongs at 11pm in the feed. That's
the difference between a journal and a server log.
