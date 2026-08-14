# Setup

Every step is a web page. No terminal at any point.

About 20 minutes to a working app; steps 5 and 6 are optional and can wait.

---

## 1 · Put the code on GitHub

1. [github.com/new](https://github.com/new) — name it whatever, set it **Public**.
   (Free GitHub Pages only serves public repos. That's fine here — the
   Supabase anon key is designed to be public, row-level security is what
   actually protects your data, and your email addresses live in the
   database rather than the source.)
2. On the new repo page: **uploading an existing file**.
3. Drag in everything from this folder. Commit.

---

## 2 · Supabase

1. [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.
   Any name. Pick the region nearest you. Save the database password
   somewhere, though you won't need it for this.
2. Wait for it to finish provisioning — about two minutes.
3. Left sidebar → **SQL Editor** → **New query**.
4. Open `db/schema.sql`, copy the whole thing, paste, hit **Run**.
   You should get "Success. No rows returned."
5. Left sidebar → **Table Editor** → `allowed_emails` → **Insert row**.
   Add one row per person, just the email address. **Two rows.**

   Nothing works until these exist. This is the front door.

6. Left sidebar → **Project Settings** → **API**. Copy:
   - Project URL
   - `anon` `public` key

---

## 3 · Wire the app up

Back in GitHub, open `config.js` and click the pencil to edit.

```js
NAME: "MERCH TABLE",                              // ← whatever you two land on
SUPABASE_URL: "https://abcdefgh.supabase.co",     // ← Project URL
SUPABASE_ANON_KEY: "eyJhbGci...",                 // ← anon public key
```

Commit.

While you're here, `manifest.webmanifest` has the name twice as well —
that's what shows under the home screen icon.

---

## 4 · Turn on Pages

1. Repo → **Settings** → **Pages**.
2. Source: **Deploy from a branch**. Branch: `main`, folder: `/ (root)`. Save.
3. Under **Custom domain**, enter your domain and save. GitHub writes a
   `CNAME` file into the repo for you.
4. At your registrar, point the domain at GitHub:
   - apex domain (`example.com`) → four **A** records:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - or a subdomain (`ideas.example.com`) → one **CNAME** → `YOURNAME.github.io`
5. Back in Pages settings, tick **Enforce HTTPS** once it becomes available.
   Can take up to an hour for the certificate. Service workers and
   microphone access both require HTTPS, so wait for this before testing
   on your phone.

**Why the custom domain matters:** without one, GitHub serves the site at
`yourname.github.io/reponame/`. That subpath breaks service worker scope
and the manifest's start URL in ways that quietly kill the home-screen
install. The domain puts everything at the root and the problem disappears.

---

## 5 · Transcription — optional

Skip this and everything else still works; voice notes just won't
have searchable text under them.

1. Get an API key at [platform.openai.com](https://platform.openai.com/api-keys).
2. Supabase → **Edge Functions** → **Deploy a new function** → name it
   exactly `transcribe` → paste in `functions/transcribe/index.ts`.
3. Supabase → **Project Settings** → **Edge Functions** → **Secrets** →
   add `OPENAI_API_KEY`.

Roughly a third of a cent per minute of audio. At two people having ideas,
call it free.

---

## 6 · Push notifications — optional

1. Generate a VAPID key pair at [vapidkeys.com](https://vapidkeys.com).
   Two strings, public and private.
2. Supabase → **Edge Functions** → **Deploy a new function** → name it
   exactly `notify` → paste in `functions/notify/index.ts`.
3. Supabase → **Project Settings** → **Edge Functions** → **Secrets** → add:
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_SUBJECT` → `mailto:your@email.com`
4. In GitHub, edit `config.js` and paste the **public** key into
   `VAPID_PUBLIC_KEY`. Commit.
5. In the app: **···** → Notifications → **Turn on**.

**iPhone caveat, and it's a real one:** iOS only allows web push for apps
that have been added to the home screen. Both of you have to do the
Share → Add to Home Screen dance once before notifications will work at
all. Nothing to be done about it — it's an Apple restriction, not a bug
in this.

---

## 7 · Both of you, on your phones

1. Open the site in Safari (iPhone) or Chrome (Android).
2. Enter your email → **Send the link** → open the email → you're in,
   and you stay in.
3. **Share → Add to Home Screen.** This is the step that makes it stop
   feeling like a website. It's also what enables offline capture and push.
4. Settings **···** → set your name so the other person knows who said what.

---

## The iOS Shortcut

For capture without even opening the app. Shortcuts → new shortcut:

1. **Ask for Input** (Text) — prompt: "Idea"
2. **Get Contents of URL**
   - URL: `https://YOUR-PROJECT.supabase.co/rest/v1/entries`
   - Method: `POST`
   - Headers:
     - `apikey` → your anon key
     - `Authorization` → `Bearer YOUR-ANON-KEY`
     - `Content-Type` → `application/json`
   - Request Body (JSON):
     - `body` → Provided Input
     - `author_id` → your profile UUID (Supabase → Table Editor → profiles)
     - `client_id` → Shortcuts' *UUID* action, or a Random Number

Assign it to the Action Button or a back-tap and capture drops to about
a second.

Two honest caveats. The anon key sits on your phone in plain text — it's
public by design, but anyone holding your unlocked phone could write to
the archive. And the Shortcut can't queue offline the way the app can: no
signal, no capture. It's the fast path, not the reliable one.

---

## If something's wrong

**"That didn't work. Is the address on the list?"** — the email isn't in
`allowed_emails`, or it's spelled differently. Check for a typo and for
stray whitespace.

**The magic link logs you out immediately** — the redirect URL isn't
allowed. Supabase → **Authentication** → **URL Configuration** → add your
domain to **Site URL** and **Redirect URLs**.

**Microphone does nothing** — needs HTTPS. Confirm **Enforce HTTPS** is on
in the Pages settings.

**Changes don't show up** — the service worker is serving the old files.
Bump `SHELL_V` in `sw.js` (`shell-v1` → `shell-v2`) and commit. That's the
one piece of housekeeping this app asks of you.

**Nothing loads at all** — open `config.js` and check the URL and key
actually got pasted in.
