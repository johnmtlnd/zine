import asyncio, json, sys
from datetime import datetime, timedelta

# The "one year ago today" card only fires on an exact month/day match,
# so this fixture has to be derived from the run date. Hardcoding it
# makes the suite pass today and fail tomorrow.
_t = datetime.now()
try:    THROWBACK = _t.replace(year=_t.year - 1)
except ValueError:  # 29 Feb
        THROWBACK = _t.replace(year=_t.year - 1, day=28)
THROWBACK_ISO = THROWBACK.strftime("%Y-%m-%dT20:20:00Z")
from playwright.async_api import async_playwright

BASE = "http://localhost:8899"
SB = "https://YOUR-PROJECT.supabase.co"

USER = {"id": "11111111-1111-1111-1111-111111111111", "email": "john@example.com"}

def iso(d): return d
ENTRIES = [
    {"id":"a1","author_id":USER["id"],"type_id":"t1","body":"Wet Cement","transcript":None,
     "audio_path":None,"audio_ms":None,"photo_path":None,"client_id":"c1",
     "created_at":"2026-08-13T18:04:00Z","synced_at":"2026-08-13T18:04:00Z",
     "author_name":"john","type_label":"Band name","type_slug":"band-name","reply_count":2},
    {"id":"a2","author_id":"22222222-2222-2222-2222-222222222222","type_id":"t2",
     "body":"shirt that just says NOT THE DRUMMER","transcript":None,
     "audio_path":None,"audio_ms":None,"photo_path":None,"client_id":"c2",
     "created_at":"2026-08-12T22:41:00Z","synced_at":"2026-08-12T22:41:00Z",
     "author_name":"nora","type_label":"T-shirt","type_slug":"t-shirt","reply_count":0},
    {"id":"a3","author_id":USER["id"],"type_id":"t1","body":"",
     "transcript":"The Municipal Airport Sound","audio_path":"x/a3.webm","audio_ms":7400,
     "photo_path":None,"client_id":"c3","created_at":"2026-08-11T09:15:00Z",
     "synced_at":"2026-08-11T09:15:00Z","author_name":"john",
     "type_label":"Band name","type_slug":"band-name","reply_count":1},
    {"id":"a4","author_id":"22222222-2222-2222-2222-222222222222","type_id":None,
     "body":"hat with a tiny embroidered fire extinguisher","transcript":None,
     "audio_path":None,"audio_ms":None,"photo_path":None,"client_id":"c4",
     "created_at":"2026-07-30T13:02:00Z","synced_at":"2026-07-30T13:02:00Z",
     "author_name":"nora","type_label":None,"type_slug":None,"reply_count":0},
    {"id":"a5","author_id":USER["id"],"type_id":"t3","body":"Hard Water Country Club",
     "transcript":None,"audio_path":None,"audio_ms":None,"photo_path":None,"client_id":"c5",
     "created_at":THROWBACK_ISO,"synced_at":THROWBACK_ISO,
     "author_name":"john","type_label":"Hat","type_slug":"hat","reply_count":0},
]
TYPES = [
    {"id":"t1","label":"Band name","slug":"band-name","sort_order":10,"is_seed":True},
    {"id":"t2","label":"T-shirt","slug":"t-shirt","sort_order":20,"is_seed":True},
    {"id":"t3","label":"Hat","slug":"hat","sort_order":30,"is_seed":True},
    {"id":"t4","label":"Other","slug":"other","sort_order":40,"is_seed":True},
]
REPLIES = [{"id":"r1","entry_id":"a1","author_id":"2","body":"or Wet Concrete",
            "client_id":"rc1","created_at":"2026-08-13T18:10:00Z",
            "profiles":{"display_name":"nora"}}]

created = []

async def handle(route):
    url = route.request.url
    m = route.request.method
    def ok(body, status=200):
        return route.fulfill(status=status, content_type="application/json",
                             headers={"Access-Control-Allow-Origin":"*"},
                             body=json.dumps(body))
    if "/auth/v1/user" in url: return await ok(USER)
    if "/auth/v1/otp"  in url: return await ok({})
    if "entries_full"  in url: return await ok(ENTRIES)
    if "entry_types"   in url:
        if m == "POST":
            row = json.loads(route.request.post_data)
            row["id"] = "t9"; TYPES.append(row); return await ok([row], 201)
        return await ok(TYPES)
    if "/rest/v1/replies" in url:
        if m == "POST": return await ok([json.loads(route.request.post_data)], 201)
        return await ok(REPLIES)
    if "/rest/v1/profiles" in url:
        if m == "PATCH": return await ok([])
        return await ok([{"id":USER["id"],"display_name":"john"}])
    if "/rest/v1/entries" in url:
        if m == "POST":
            row = json.loads(route.request.post_data)
            row["id"] = "new-" + str(len(created)); created.append(row)
            return await ok([row], 201)
        if m in ("PATCH","DELETE"): return await ok([])
    if "/functions/v1/" in url: return await ok({})
    return await ok({})

async def main():
    results = []
    posted_urls = []
    def check(name, cond, detail=""):
        results.append((name, bool(cond), detail))
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width":420,"height":950}, device_scale_factor=2)
        async def spy1(route):
            if route.request.method == "POST":
                posted_urls.append(route.request.url)
            await handle(route)
        await ctx.route("https://YOUR-PROJECT.supabase.co/**", spy1)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        pg.on("console", lambda m: errs.append(f"{m.type}: {m.text}") if m.type == "error" else None)

        await pg.add_init_script("""
          localStorage.setItem('archive.session', JSON.stringify({
            access_token:'fake', refresh_token:'fake',
            expires_at: Date.now()+86400000, user:null }));
        """)
        await pg.goto(f"{BASE}/index.html")
        await pg.wait_for_timeout(1800)

        check("main screen shows", await pg.is_visible("#main"))
        check("auth hidden", not await pg.is_visible("#auth"))
        cards = await pg.locator(".card").count()
        check("cards rendered", cards == 5, f"got {cards}")
        check("type chips rendered", await pg.locator("#typebar .chip").count() == 4)
        check("throwback shown (1yr ago today)", await pg.locator(".throwback").count() == 1)
        check("transcript fallback italic", await pg.locator(".card__body--muted").count() >= 1)
        check("waveform for audio entry", await pg.locator(".wave").count() == 1)
        # Compare against the config value, not a literal — the name is
        # John's to change and a hardcoded string here just breaks later.
        cfgname = await pg.evaluate("import('./config.js').then(m => m.CONFIG.NAME)")
        rendered = (await pg.inner_text("#masthead-name")).strip()
        norm = lambda x: "".join(x.lower().split())
        check("masthead name from config", norm(rendered) == norm(cfgname),
              f"rendered {rendered!r} vs config {cfgname!r}")
        await pg.screenshot(path="/tmp/feed.png", full_page=False)

        # tilt is seeded => stable across reloads
        t1 = await pg.locator(".card").first.evaluate("e=>getComputedStyle(e).transform")
        await pg.reload(); await pg.wait_for_timeout(1500)
        t2 = await pg.locator(".card").first.evaluate("e=>getComputedStyle(e).transform")
        check("card tilt is stable across reloads", t1 == t2, f"{t1} vs {t2}")
        # Tilt is theme-dependent — the zine theme sets it, glass zeroes it.
        # Assert against whatever the active theme actually declares.
        tilt_token = await pg.evaluate(
            "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tilt'))")
        flat = t1 in ("none", "matrix(1, 0, 0, 1, 0, 0)")
        check("tilt matches the active theme",
              (tilt_token == 0) == flat, f"--tilt:{tilt_token} transform:{t1}")

        # Every token the component layer reads must exist, or the
        # themes aren't actually interchangeable.
        missing = await pg.evaluate("""() => {
          const s = getComputedStyle(document.documentElement);
          return ['--bg','--field-1','--field-2','--ink','--ink-soft','--ink-faint',
                  '--accent','--surface','--surface-strong','--surface-sunk','--blur',
                  '--saturate','--specular','--hairline','--hairline-strong','--border',
                  '--rule-weight','--shadow-card','--shadow-lift','--masthead-fill',
                  '--masthead-ink','--font-display','--font-body','--display-weight',
                  '--display-track','--display-transform','--label-size','--body-size',
                  '--body-leading','--title-size','--radius-card','--radius-chip',
                  '--radius-btn','--radius-field','--pad','--card-pad','--gap','--space-unit','--density','--space-1','--space-4','--space-7','--text-base','--ratio','--text-xs','--text-sm','--text-lg','--text-xl','--text-2xl','--title-weight','--title-leading',
                  '--measure','--tilt','--grain','--halftone','--dot-size',
                  '--photo-filter','--wave-radius','--wave-width','--dur','--ease']
            .filter(t => s.getPropertyValue(t).trim() === '');
        }""")
        check("theme defines every token app.css reads", not missing, str(missing))

        # BY TYPE lens
        await pg.click("#lens-type"); await pg.wait_for_timeout(400)
        check("type groups appear", await pg.locator(".sectionrule").count() >= 3)
        await pg.screenshot(path="/tmp/bytype.png")
        await pg.click("#lens-all"); await pg.wait_for_timeout(300)

        # capture path
        await pg.fill("#composer", "Glass Ceiling Fan")
        check("commit enabled once there's text", await pg.is_enabled("#btn-commit"))
        await pg.click("#typebar .chip >> nth=0")
        await pg.click("#btn-commit")
        await pg.wait_for_timeout(1200)
        check("composer cleared after commit", (await pg.input_value("#composer")) == "")
        check("entry POSTed to server", len(created) >= 1, f"{len(created)} posts")
        check("client_id sent", created and "client_id" in created[0])
        check("capture time sent, not server time", created and "created_at" in created[0])

        # offline capture
        await ctx.set_offline(True)
        await pg.evaluate("window.dispatchEvent(new Event('offline'))")
        await pg.fill("#composer", "Municipal Waste Authority")
        await pg.click("#btn-commit")
        await pg.wait_for_timeout(900)
        check("offline banner visible", await pg.is_visible("#offline-banner"))
        pend = await pg.locator(".card--pending").count()
        check("offline entry rendered as pending", pend >= 1, f"{pend}")
        await pg.screenshot(path="/tmp/offline.png")

        qn = await pg.evaluate("""() => new Promise(res=>{
            const r = indexedDB.open('archive');
            r.onsuccess = () => { const db=r.result;
              const c = db.transaction('queue').objectStore('queue').count();
              c.onsuccess = ()=>res(c.result); };
        })""")
        check("queued in IndexedDB while offline", qn >= 1, f"queue={qn}")

        await ctx.set_offline(False)
        await pg.evaluate("window.dispatchEvent(new Event('online'))")
        await pg.wait_for_timeout(1800)
        check("offline banner cleared", not await pg.is_visible("#offline-banner"))
        check("queue flushed on reconnect", len(created) >= 2, f"{len(created)} posts")

        # shuffle
        await pg.click("#btn-shuffle"); await pg.wait_for_timeout(600)
        check("shuffle opens detail", await pg.is_visible("#detail"))
        check("shuffle offers Again", await pg.is_visible("#detail-again"))
        await pg.screenshot(path="/tmp/shuffle.png")
        await pg.click("#detail-close"); await pg.wait_for_timeout(300)

        # detail + thread
        await pg.click(".card >> nth=0"); await pg.wait_for_timeout(800)
        check("card opens detail", await pg.is_visible("#detail"))
        check("reply box present", await pg.locator(".replybox input").count() == 1)
        await pg.screenshot(path="/tmp/detail.png")
        await pg.click("#detail-close")

        # settings
        await pg.click("#btn-settings"); await pg.wait_for_timeout(400)
        check("settings opens", await pg.is_visible("#settings"))
        rows = await pg.locator("#settings .row").count()
        check("settings stays at four rows", rows == 4, f"{rows}")
        await pg.screenshot(path="/tmp/settings.png")

        # dark mode
        await pg.click("#set-close")
        await pg.emulate_media(color_scheme="dark")
        await pg.wait_for_timeout(400)
        await pg.screenshot(path="/tmp/dark.png")
        # Theme-agnostic: whatever the theme, dark must actually be dark
        # and text must actually be light. Hardcoding a hex here would
        # just break every time the palette moves.
        lum = await pg.evaluate("""() => {
          const rgb = s => s.match(/\\d+/g).slice(0,3).map(Number);
          const L = ([r,g,b]) => (0.2126*r + 0.7152*g + 0.0722*b) / 255;
          const cs = getComputedStyle(document.body);
          return { bg: L(rgb(cs.backgroundColor)), fg: L(rgb(cs.color)) };
        }""")
        check("dark mode: background is dark", lum["bg"] < 0.25, str(lum))
        check("dark mode: text is light", lum["fg"] > 0.75, str(lum))
        check("dark mode: text/background actually contrast",
              lum["fg"] - lum["bg"] > 0.5, str(lum))

        check("no JS errors anywhere", len(errs) == 0, "; ".join(errs[:5]))

        # ---- signed-out flow, fresh context ----
        ctx2 = await b.new_context(viewport={"width":420,"height":900})
        seen = []
        async def spy(route):
            seen.append(route.request.url)
            await handle(route)
        await ctx2.route("https://YOUR-PROJECT.supabase.co/**", spy)
        pg2 = await ctx2.new_page()
        await pg2.goto(f"{BASE}/index.html")
        await pg2.wait_for_timeout(800)
        check("signed out shows auth", await pg2.is_visible("#auth"))
        await pg2.fill("#auth-email", "john@example.com")
        await pg2.click("#auth-send")
        await pg2.wait_for_timeout(800)
        otp = [u for u in seen if "/auth/v1/otp" in u]
        check("magic link sent", len(otp) == 1, str(seen))
        check("redirect_to is a query param, not a body field",
              otp and "redirect_to=" in otp[0], otp[0] if otp else "none")
        check("confirmation shown", "Check your email" in (await pg2.inner_text("#auth-msg")))

        await pg2.close()
        await b.close()

    # Upsert must name the conflict target, or a retried capture
    # 409s instead of merging. Checked against real traffic.
    entry_posts = [u for u in posted_urls if "/rest/v1/entries" in u]
    check("upsert names the conflict target",
          entry_posts and all("on_conflict=client_id" in u for u in entry_posts),
          str(entry_posts[:2]))

    print()
    fails = 0
    for name, okk, detail in results:
        mark = "PASS" if okk else "FAIL"
        if not okk: fails += 1
        print(f"  [{mark}] {name}" + (f"  ({detail})" if detail and not okk else ""))
    print(f"\n{len(results)-fails}/{len(results)} passed")
    sys.exit(1 if fails else 0)

asyncio.run(main())
