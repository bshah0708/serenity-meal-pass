"""Browser smoke test of the web app against an in-memory Supabase stand-in (tests/web-mock.js).
Run:  python3 tests/web.test.py   (needs Python Playwright + Chromium)
Screenshots go to tests/shots/."""
import os, sys, pathlib, threading, functools, http.server
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
# serve web/ over http like the real site (CSS masks and module rules differ on file://)
_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "web")))
_srv.RequestHandlerClass.log_message = lambda *a: None
threading.Thread(target=_srv.serve_forever, daemon=True).start()
WEB = f"http://127.0.0.1:{_srv.server_address[1]}/index.html"
MOCK = (ROOT / "tests" / "web-mock.js").read_text()
SHOTS = ROOT / "tests" / "shots"; SHOTS.mkdir(exist_ok=True)
CONFIG = 'window.SS_CONFIG={supabaseUrl:"https://mock.supabase.co",supabaseAnonKey:"anon",siteUrl:"https://example.github.io/serenity-meal-pass"};'
CHROME = os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium")
fails = []

def check(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: fails.append(msg)

IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"

def page_for(b, role, logged_in=True, w=400, h=860, ua=None, sw=False):
    # service workers fetch files themselves, bypassing the test's stand-in for Supabase — keep them off except for the install checks
    opts = {"viewport": {"width": w, "height": h}, "service_workers": "allow" if sw else "block"}
    if ua: opts.update(user_agent=ua, is_mobile=True, has_touch=True, device_scale_factor=2)
    ctx = b.new_context(**opts)
    p = ctx.new_page(); errs = []
    p.on("pageerror", lambda e: errs.append(str(e)))
    p.add_init_script(f"window.__MOCK_ROLE={role!r};window.__MOCK_LOGGED_IN={'true' if logged_in else 'false'};")
    p.route("**/vendor/supabase.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=MOCK))
    p.route("**/config.js", lambda r: r.fulfill(status=200, content_type="application/javascript", body=CONFIG))
    p.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    p.goto(WEB); p.wait_for_timeout(700)
    return p, errs

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=CHROME)

    print("Login")
    p, errs = page_for(b, "resident", logged_in=False)
    check(p.is_visible("#login"), "login screen shown when signed out")
    p.fill("#lgPhone", "12345"); p.click("#lgSend"); check("10-digit" in p.inner_text("#lgErr1"), "invalid mobile rejected")
    p.fill("#lgPhone", "9800000001"); p.click("#lgSend"); p.wait_for_timeout(200)
    check(p.is_visible("#otpForm"), "OTP step shown after sending code")
    p.screenshot(path=str(SHOTS / "1_login_otp.png"))
    p.fill("#lgOtp", "111111"); p.wait_for_timeout(300); check("wrong" in p.inner_text("#lgErr2"), "wrong code rejected")
    p.fill("#lgOtp", "123456"); p.wait_for_timeout(900)
    check(p.is_visible("#resident") and not p.is_visible("#login"), "correct code logs in")
    check(p.is_visible("#pfName"), "first login asks for profile details")
    check(errs == [], f"no page errors {errs}")

    print("Resident")
    p.fill("#pfName", "Asha Patel"); p.select_option("#pfBlock", "E"); p.select_option("#pfFlat", "904"); p.fill("#pfMail", "asha@example.com"); p.click("#pfSave"); p.wait_for_timeout(400)
    check("E-904" in p.inner_text("#acctBox"), "profile saved and shown")
    check(p.locator("#resEvents .ev").count() == 2, "published events listed")
    check(p.locator("#myList .passwrap").count() == 0, "resident sees none of the other residents' bookings")
    p.click("#resEvents [data-book]"); p.wait_for_timeout(300)
    check(p.is_disabled("#fBlock") and p.input_value("#fFlat") == "904", "booking locked to own flat")
    p.click("[data-d=a][data-v='1']"); p.wait_for_timeout(100)
    check(p.inner_text("#tAmt").strip() == "₹900", "package price preview (2 adults, all sessions = ₹900)")
    p.screenshot(path=str(SHOTS / "2_booking_form.png"))
    p.click("#fGo"); p.wait_for_timeout(600)
    check(p.locator("#ovl .tk").count() == 2, "confirmation shows one QR ticket per person")
    p.screenshot(path=str(SHOTS / "3_confirmed.png"))
    p.click("#ovl .x2"); p.wait_for_timeout(900)
    check(p.locator("#myList .mybk").count() == 1, "new booking appears under My passes")
    check(p.locator("#myList [data-utr]").count() == 1, "UPI pay box offered for unpaid booking")
    check(p.locator("#myList .mybk .sep").count() == 1 and p.locator("#myList .mybk .paysec").count() == 1, "passes and payment shown as separate sections")

    print("Booking more passes for the same event")
    p.click("[data-bookmore]"); p.wait_for_timeout(300)
    check(p.locator("#ovl .prevbox .prevrow").count() == 1, "booking form lists what was booked before")
    check(p.locator("#ovl .sumrow").count() == 3, "shows Already booked / Adding now / Total for this event")
    tot = p.inner_text("#ovl .sumrow.total-line")
    check("3 passes" in tot and "₹1,350" in tot, f"event total = earlier 2 + now 1 = 3 passes, ₹900 + ₹450 package = ₹1,350 ({tot!r})")
    check("Add 1 more pass" in p.inner_text("#fGo"), "button says how many more passes are being added")
    p.click(".sesslist input >> nth=1"); p.wait_for_timeout(100)   # only Day 1 this time
    check("₹1,150" in p.inner_text("#ovl .sumrow.total-line"), "total updates live when a day is unticked (₹900 + ₹250 = ₹1,150)")
    p.screenshot(path=str(SHOTS / "4a_book_more.png"))
    p.evaluate("document.querySelector('#ovl .sheet').scrollTop = 1e5"); p.wait_for_timeout(150)
    p.screenshot(path=str(SHOTS / "4b_book_more_total.png"))
    p.click("#fGo"); p.wait_for_timeout(600)
    check("booking 2 for this event" in p.inner_text("#ovl").lower(), "confirmation says it is booking 2 and shows the new total")
    p.click("#ovl .x2"); p.wait_for_timeout(900)
    check(p.locator("#myList .evgroup").count() == 1 and p.locator("#myList .mybk").count() == 2, "both bookings grouped under one event")
    check("3" in p.inner_text("#myList .evtot") and "2 bookings" in p.inner_text("#myList .evsum"), "event header shows total passes and bookings")
    p.fill("#myQ", "zzz-nothing"); p.wait_for_timeout(150)
    check("No passes match" in p.inner_text("#myList"), "search with no match says so")
    p.fill("#myQ", ""); p.wait_for_timeout(150)
    first_pass = p.inner_text("#myList .mybk .tk-f .mono >> nth=0").strip()
    p.fill("#myQ", first_pass[-7:]); p.wait_for_timeout(150)
    check(p.locator("#myList .mybk").count() == 1, "search by pass number narrows to that booking")
    p.fill("#myQ", ""); p.wait_for_timeout(150)
    check(p.locator("#myEv option").count() == 2, "event filter lists All + the resident's events")
    p.screenshot(path=str(SHOTS / "4_my_passes.png"), full_page=True)
    check(not p.is_visible("#modeSwitch"), "resident has no committee switch")
    check(errs == [], f"no page errors {errs}")

    print("Super admin")
    p, errs = page_for(b, "super")
    check(p.is_visible("#admin"), "super admin lands on committee view")
    check("Super admin" in p.inner_text("#roleBadge"), "role badge shows Super admin")
    p.screenshot(path=str(SHOTS / "5_overview.png"))
    p.click("#tabs [data-tab=bookings]"); p.wait_for_timeout(300)
    check(p.locator("#bkTable tbody tr").count() == 2, "committee sees every booking")
    seed = p.evaluate("window.__seed")
    p.click(f"[data-pay='{seed['a']['id']}']"); p.wait_for_timeout(200); p.click("#pyGo"); p.wait_for_timeout(900)
    check(p.evaluate(f"window.__T.bookings.find(b=>b.id==='{seed['a']['id']}').status") == "paid", "mark paid works")
    p.click(f"[data-pass='{seed['b']['id']}']"); p.wait_for_timeout(300)
    check(p.locator("#ovl .tk").count() == 3, "pass sheet shows 3 person tickets")
    wa = p.get_attribute("#psWa", "href"); check(wa.startswith("https://wa.me/919724212198") and "pass.html%23DIN26" in wa, "WhatsApp link has per-person pass links")
    p.click("#ovl .x2")
    p.click("#tabs [data-tab=counter]"); p.wait_for_timeout(200)
    p.evaluate(f"document.querySelector('#ctQ').value='E-903';document.querySelector('#ctQ').dispatchEvent(new Event('input'))"); p.wait_for_timeout(200)
    check(p.locator("#ctBody .pchip").count() == 6, "counter search shows a chip per person per session")
    p.screenshot(path=str(SHOTS / "6_counter.png"), full_page=True)
    p.click("#tabs [data-tab=settings]"); p.wait_for_timeout(200)
    check(p.locator("#accessPanel [data-ok]").count() == 1, "pending committee request listed for super admin")
    p.click("#accessPanel [data-ok]"); p.wait_for_timeout(900)
    check(p.evaluate("window.__T.staff.some(s=>s.user_id==='u-akash'&&s.active)"), "approve adds committee member")
    p.click("#tabs [data-tab=events]"); p.wait_for_timeout(200); p.click("#newEvent"); p.wait_for_timeout(200)
    p.fill("#eGu", "હોળી નાસ્તો"); p.fill("#eEn", "Holi Snacks 2027"); p.fill("#eCode", "HOL27"); p.fill(".sessed .sd", "2027-03-22"); p.fill("#pAdult", "60"); p.fill("#eClose", "2027-03-20"); p.click("#eSave"); p.wait_for_timeout(900)
    check(p.evaluate("window.__T.events.some(e=>e.code==='HOL27')") and p.evaluate("window.__T.event_sessions.some(s=>s.date==='2027-03-22')"), "new event with session saved")
    p.click("#tabs [data-tab=reports]"); p.wait_for_timeout(200)
    check(p.is_visible("#xlOne"), "reports tab renders")
    check(errs == [], f"no page errors {errs}")

    print("Desktop + public pass page")
    p, errs = page_for(b, "super", w=1280, h=860); p.click("#tabs [data-tab=bookings]"); p.wait_for_timeout(300); p.screenshot(path=str(SHOTS / "7_desktop_bookings.png"))
    check(errs == [], f"no page errors {errs}")
    p, errs = page_for(b, "super")
    pn = p.evaluate("window.__seed.b.pass_no")
    p.goto(WEB.replace("index.html", "pass.html") + "#" + pn + "-2"); p.wait_for_timeout(700)
    check(p.locator(".tk").count() == 1 and "Adult 2" in p.inner_text(".tk"), "public pass link shows that person's QR and details")
    p.screenshot(path=str(SHOTS / "8_public_pass.png"))
    p.goto(WEB.replace("index.html", "pass.html") + "#NOPE-A101-XXXXX"); p.wait_for_timeout(500)
    check("not found" in p.inner_text("body"), "unknown pass shows not found")
    check(errs == [], f"no page errors {errs}")
    print("Phone app (iOS + Android)")
    no_hscroll = "document.documentElement.scrollWidth <= window.innerWidth + 1"
    p, errs = page_for(b, "resident", logged_in=False, w=375, h=812, ua=IPHONE, sw=True)
    check(p.evaluate("!!document.querySelector('link[rel=manifest]') && !!document.querySelector('link[rel=apple-touch-icon]')"), "manifest and iPhone icon linked")
    m = p.evaluate("fetch('manifest.webmanifest').then(r=>r.json())")
    check(m["display"] == "standalone" and any(i.get("purpose") == "maskable" for i in m["icons"]), "manifest: standalone with maskable icon")
    p.wait_for_timeout(800)
    check(p.evaluate("navigator.serviceWorker.getRegistration().then(r=>!!r)"), "service worker registered (needed for Android install)")
    check(p.is_visible("#installBar"), "install banner shown on iPhone")
    p.click("#ibInstall"); p.wait_for_timeout(300)
    check("Add to Home Screen" in p.inner_text("#ovl"), "iPhone gets Add to Home Screen steps")
    p.screenshot(path=str(SHOTS / "9_iphone_install.png"))
    p.click("#ovl .x2"); p.click("#ibClose"); p.wait_for_timeout(200)
    check(not p.is_visible("#installBar"), "Not now hides the banner")
    p.reload(); p.wait_for_timeout(700)
    check(not p.is_visible("#installBar"), "dismissal remembered after reload")
    check(p.evaluate("getComputedStyle(document.querySelector('#lgPhone')).fontSize") == "16px", "fields are 16px so iPhone does not zoom in")
    check(p.evaluate(no_hscroll), "no sideways scrolling on iPhone login (375 px)")
    check(errs == [], f"no page errors {errs}")
    for w, ua, name in [(375, IPHONE, "iPhone"), (360, ANDROID, "Android")]:
        p, errs = page_for(b, "super", w=w, h=780, ua=ua)
        bad = []
        for t in ["overview", "events", "bookings", "counter", "reports", "settings"]:
            p.click(f"#tabs [data-tab={t}]"); p.wait_for_timeout(150)
            if not p.evaluate(no_hscroll): bad.append(t)
        check(not bad, f"{name} {w}px: no sideways scrolling on committee screens {bad}")
        # long forms: top must be on screen and the last button reachable by scrolling the sheet
        reach = """(btn)=>{const s=document.querySelector('#ovl .sheet');const top=s.getBoundingClientRect().top;
          s.scrollTop=s.scrollHeight;const b=document.querySelector(btn).getBoundingClientRect();
          const h=s.querySelector('header .x').getBoundingClientRect();
          return top>=0 && b.bottom<=innerHeight+1 && h.top>=0}"""
        for t, opener, last in [("events", "#newEvent", "#eSave"), ("bookings", "#bkNew", "#fGo")]:
            p.click(f"#tabs [data-tab={t}]"); p.wait_for_timeout(150); p.click(opener); p.wait_for_timeout(300)
            check(p.evaluate(reach, last), f"{name} {w}px: {opener} form fully reachable by scrolling, close button stays visible")
            p.click("#ovl .x"); p.wait_for_timeout(150)
        check(p.evaluate("document.body.style.overflow") == "", f"{name} {w}px: page scrolls again after closing a form")
        p.click("#mRes"); p.wait_for_timeout(200)
        check(p.evaluate(no_hscroll), f"{name} {w}px: no sideways scrolling on resident home")
        check(errs == [], f"no page errors {errs}")
    p.screenshot(path=str(SHOTS / "10_android_resident.png"))
    b.close()

print("\n" + ("All web checks passed." if not fails else f"{len(fails)} check(s) failed."))
sys.exit(1 if fails else 0)
