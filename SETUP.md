# Setting up Offcuts

Everything here happens on a web page. You never open a terminal.

Steps 1–10 get you a working app at **offcuts.info**. Everything after that
is optional and nothing depends on it.

Budget about half an hour, plus some waiting around for the domain.

---

## The three pieces, so the steps make sense

**GitHub** stores the files and puts them on the internet. It's the storefront.

**Supabase** is a free hosted database with a web dashboard. The app itself is
just HTML and JavaScript — files have no memory. Supabase is what actually
holds the ideas you two write, stores the audio, and handles the "email me a
link to sign in" part. It's the filing cabinet.

**Your domain** points at GitHub so people type `offcuts.info` instead of
something ending in `github.io`.

---

## 1 · Put the files on GitHub

Go to [github.com/new](https://github.com/new).

Name the repo whatever you like. Set it to **Public** — GitHub only hosts
websites from public repos unless you pay, and public is fine here. Nothing
secret ends up in these files: the database key is designed to be public,
and your email addresses live in the database rather than the code.

Create it, then on the next page click **uploading an existing file**.

Drag in everything from inside the `offcuts` folder — the files themselves,
not the folder. You should end up with `index.html` sitting at the top level
of the repo, not inside another folder. Click **Commit changes**.

---

## 2 · Make a Supabase account

Go to [supabase.com](https://supabase.com) and click **Start your project**.

When it asks how you want to sign in, **pick GitHub** — you already have that
account and it's one less password.

No credit card. The free plan covers two people with room to spare.

---

## 3 · Create the project

On the dashboard, click **New project**. It asks for five things:

- **Organization** — it makes one for you. Accept whatever it suggests.
- **Name** — anything. "offcuts" is fine. Only you ever see it.
- **Database password** — click **Generate**, then save it in your password
  manager. You almost certainly won't need it again, and there's no way to
  recover it later.
- **Region** — whichever is geographically closest to you.
- **Plan** — Free.

Click create. It spends about two minutes building your database and shows
you a progress screen.

When it finishes you land on the project dashboard. **That screen is where
steps 4 through 7 happen** — everything you need is in the left sidebar.

---

## 4 · Build the tables

Left sidebar → **SQL Editor** → **New query**. You get a big empty text box.

Open the file `db/schema.sql`, select all of it, copy it, paste it into that
box, and click **Run**.

It should say "Success. No rows returned." That one paste creates every
table the app needs. You never have to look at that file again.

---

## 5 · Add the guest list

Left sidebar → **Table Editor**. Find the table called `allowed_emails`.

Click **Insert row**, type your email address, save. Do it again for Biz's.
Two rows total.

This is the entire security model. Anyone whose address isn't in that table
can't get in, even if they somehow get a sign-in link. It's also why your
emails aren't in the code — the public repo never sees them.

**Nothing works until these two rows exist.**

---

## 6 · Connect the app to the database

Left sidebar → **Project Settings** → **API**.

You'll see a web address ending in `.supabase.co`, and below it a very long
string of characters labelled `anon` `public`. Copy both.

Now back to GitHub. Click `config.js`, then the pencil icon to edit it.
Paste the web address and the long string between the quote marks on their
lines. The name is already set to `OFFCUTS`. Click **Commit changes**.

---

## 7 · Tell Supabase your website is allowed

Signing in works by emailing you a link that bounces you back to your site.
Supabase won't bounce anyone to a site it doesn't already know about, so you
have to name yours up front.

Left sidebar → **Authentication** → **URL Configuration**.

- **Site URL** → `https://offcuts.info`
- **Redirect URLs** → add `https://offcuts.info` there too

Save.

Skip this and sign-in fails silently with no useful error message, which is
a miserable half hour of your life.

---

## 8 · Switch the website on

In GitHub: your repo → **Settings** → **Pages**.

Set the source to **Deploy from a branch**, branch `main`, folder `/ (root)`.
Save.

Your site is now live at some `yourname.github.io` address. The `CNAME` file
already in the repo tells GitHub you want `offcuts.info` instead, so the
custom domain box should fill itself in. If it doesn't, type `offcuts.info`
into it and save.

---

## 9 · Point the domain at GitHub

Log in wherever you bought `offcuts.info` and find the **DNS** settings.

Because you're using the bare domain rather than something like
`ideas.offcuts.info`, you need four records. All of them are type **A**, and
the name field is either blank or `@` depending on how your registrar words it.

```
A    @    185.199.108.153
A    @    185.199.109.153
A    @    185.199.110.153
A    @    185.199.111.153
```

Four separate records with the same name and different addresses. That's
normal — it's how the site stays up if one of GitHub's servers goes down.

Optionally add one more so `www.offcuts.info` works too:

```
CNAME    www    YOURNAME.github.io
```

Then wait. Anywhere from ten minutes to a few hours.

---

## 10 · Wait for the padlock, then tick the box

Back in GitHub → Settings → Pages. A checkbox called **Enforce HTTPS** will
be greyed out at first, then become clickable once the security certificate
is issued. Can take up to an hour. Tick it.

**Don't test on your phone before this is on.** Browsers refuse to give a
website microphone access over an insecure connection, so recording will
silently do nothing and you'll think it's broken.

---

## 11 · Both of you, on your phones

1. Open **offcuts.info**.
2. Type your email, hit **Send the link**, check your inbox, tap the link.
   You're in, and you stay in.
3. **Share → Add to Home Screen.** Do this. It's what lets the app save
   ideas with no signal, and on iPhone it's what Apple requires before
   notifications will work at all.
4. Tap **···** and set your name, so the other person knows who said what.

That's it. You're done. Everything below is optional.

---

# Optional extras

## 12 · Stop the database going to sleep

Supabase pauses free projects after about a week of no activity. Your data
is safe and waking it up is two clicks, but the app stops working until
someone notices. For two people who might not have an idea for a fortnight,
that will happen.

There's a job already in the repo that pings the database daily so it never
looks idle. It just needs its two values:

Repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**. Add two:

- `SUPABASE_URL` — the `.supabase.co` address from step 6
- `SUPABASE_ANON_KEY` — the long string from step 6

Then go to the **Actions** tab, pick **Keep Supabase awake**, and click
**Run workflow** once to check it works. It should print `Supabase replied 200`.

One honest caveat: GitHub switches off scheduled jobs on repos that haven't
been committed to in 60 days. It emails you a link to switch it back on. So
this reduces the babysitting a lot, but doesn't quite eliminate it.

## 13 · Transcription for voice notes

Without this, voice notes still record and play back fine — they just don't
have searchable text underneath them.

1. Get an API key at [platform.openai.com](https://platform.openai.com/api-keys).
2. Supabase → **Edge Functions** → **Deploy a new function**. Name it exactly
   `transcribe`. Paste in the contents of `functions/transcribe/index.ts`.
3. Supabase → **Project Settings** → **Edge Functions** → **Secrets** →
   add `OPENAI_API_KEY`.

Costs about a third of a cent per minute of audio.

## 14 · Notifications

1. Generate a key pair at [vapidkeys.com](https://vapidkeys.com). You get two
   strings, one public and one private.
2. Supabase → **Edge Functions** → **Deploy a new function**. Name it exactly
   `notify`. Paste in `functions/notify/index.ts`.
3. Supabase → **Project Settings** → **Edge Functions** → **Secrets** → add
   three: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`
   (set that last one to `mailto:` followed by your email).
4. In GitHub, edit `config.js` and paste the **public** key into
   `VAPID_PUBLIC_KEY`. Commit.
5. In the app: **···** → Notifications → **Turn on**.

**iPhone catch, and it's Apple's, not mine:** iOS only allows notifications
from web apps that have been added to the home screen. Both of you have to do
that first or this won't work at all.

## 15 · The iPhone shortcut

For capturing an idea without opening the app. Shortcuts app → new shortcut:

1. **Ask for Input**, type Text, prompt "Idea"
2. **Get Contents of URL**
   - URL: `https://YOUR-PROJECT.supabase.co/rest/v1/entries`
   - Method: `POST`
   - Headers:
     - `apikey` → your anon key
     - `Authorization` → `Bearer` then your anon key
     - `Content-Type` → `application/json`
   - Request Body, JSON:
     - `body` → Provided Input
     - `author_id` → your profile ID (Supabase → Table Editor → profiles)
     - `client_id` → the UUID action, or a Random Number

Assign it to the Action Button or a back-tap and capture drops to about a second.

Two honest caveats. The key sits on your phone in plain text — it's public by
design, but anyone holding your unlocked phone could write to the archive. And
the shortcut can't save things offline the way the app can: no signal, no
capture. It's the fast path, not the reliable one.

---

# When something goes wrong

**"That didn't work. Is the address on the list?"**
The email isn't in `allowed_emails`, or it's spelled differently. Check for
typos and stray spaces.

**The sign-in link logs you straight back out.**
Step 7 didn't take. Check the Site URL and Redirect URLs in Supabase.

**The microphone button does nothing.**
Needs HTTPS. Check **Enforce HTTPS** is ticked in the Pages settings.

**You changed something and the site looks the same.**
The app caches itself on your phone so it works offline, and it'll keep
serving the old files until you tell it not to. Open `sw.js` and change
`shell-v1` to `shell-v2`. Commit. That's the one bit of housekeeping this
thing asks of you, and you'll need it every time you edit the CSS.

**Nothing loads at all.**
Open `config.js` and check the address and key actually got pasted in
between the quote marks.

**The site says 404 after setting up the domain.**
DNS hasn't caught up yet, or the files got uploaded one folder too deep.
Check that `index.html` is at the top level of the repo.
