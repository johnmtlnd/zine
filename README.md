# Offcuts

Band names, t-shirt ideas, hats, whatever else. For two people.
Lives at [offcuts.info](https://offcuts.info).

**Start with [SETUP.md](SETUP.md).** Every step is a web page — no terminal.

---

## What's here

```
index.html              the whole app shell
app.js                  logic — capture, feed, sync, shuffle
api.js                  Supabase over plain fetch
db.js                   IndexedDB — the offline queue and cache
theme-glass.css         ← the active look. Tune this one.
theme-zine.css          the photocopy alternate
app.css                 components — aesthetic-neutral, leave it alone
sw.js                   service worker — offline shell, push
config.js               name, project URL, keys
manifest.webmanifest    home screen install
CNAME                   the custom domain
db/schema.sql           paste into Supabase once
functions/              two optional Edge Functions
.github/workflows/      daily ping so the free database never pauses
test/smoke.py           34 browser tests against a mocked backend
```

No dependencies. No build step. No `node_modules`. The files you commit
are the files that run.

---

## The playground

Open `playground.html` in a browser. It renders the real components using
the real stylesheets — nothing in it is a mockup — with live controls for
every token and every structural variant.

Drag things until it looks right, hit **Export CSS**, and it hands you a
`:root` block to paste into the theme file plus the `<body>` line for
`index.html`. It only exports what you actually changed.

It works offline with no Supabase project, so you can design against it
before the app is even set up.

---

## Structure, separately from style

Three things are switched with attributes on `<body>`, because they change
what the thing *is* rather than what colour it is:

```html
<body data-cards="raised" data-meta="minimal" data-capture="card">
```

- **`data-cards`** — `raised` (fill + shadow) · `bordered` (adds an outline)
  · `flat` (fill only) · `divided` (no container, hairline between entries)
  · `naked` (nothing but content and space)
- **`data-meta`** — `full` (name, date, type, replies) · `minimal` (name and
  date) · `quiet` (date only)
- **`data-capture`** — `card` (boxed) · `bare` (input sits on the page)

`divided` and `naked` are where the whitespace is. They drop the container
entirely and let the type carry the hierarchy.

---

## Two looks, one component layer

There are two complete themes. **Liquid glass** is active: neutral grays,
sans-serif, rounded, translucent surfaces with backdrop blur. **Xerox zine**
is the original: warm paper, typewriter type, hard borders, halftone
texture, cards tilted a fraction of a degree.

Switching is one line in `index.html`:

```html
<link rel="stylesheet" href="theme-glass.css">   <!-- or theme-zine.css -->
```

They work because `app.css` reads only variables — it has no idea which
aesthetic it's rendering. Both theme files define the same complete set of
tokens, and there's a test that fails if either one drops one.

**Everything derives from a scale.** Spacing comes from `--space-unit` and
`--density`; type comes from `--text-base` and `--ratio`. There are no
hand-picked pixel values in `app.css`. Change `--ratio` and the entire
hierarchy re-proportions at once — that's the difference between a system
and a pile of nudges.

`--title-size` (the idea itself, at base × ratio²) is the most important
number in the file. It's what stops a band name reading like a form label.

**Tuning glass.** The ones worth touching first:

- `--ratio` and `--density` — hierarchy and air, the two big levers
- `--accent` — one colour, one job at a time
- `--surface`, `--blur`, `--saturate` — how glassy the glass is
- `--specular` — the bright top edge. It's the detail that separates real
  glass from a frosted div. Deleting it costs more than you'd think
- `--field-1` / `--field-2` — the soft blooms behind everything. Glass only
  reads if there's something to refract; flatten these to `--bg` and every
  blur in the app goes invisible
- `--radius-card`, `--card-pad`, `--gap` — shape and breathing room

**Tuning zine:** `--halftone` and `--grain` for texture, `--tilt` for how
crooked the cards sit, `--photo-filter` for the dithering.

One gotcha for either: after any change, the service worker keeps serving
the old files until you bump `SHELL_V` in `sw.js` (`shell-v2` → `shell-v3`).
That's the one piece of housekeeping this thing asks of you.

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
