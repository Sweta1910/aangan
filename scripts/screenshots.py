"""Capture phone-size screenshots of every MomSakhi screen with headless Chromium.

Why a script (not manual screenshots): the prototype is meant to be iterated on,
so re-shooting all screens must be one command. It serves web/ on a
free local port, walks the real click-paths (onboarding -> verify -> home ->
ask + kindness check -> question -> nearby opt-in -> say hi -> meetups -> chat ->
profile) and writes PNGs to screenshots/. Any uncaught page error
fails the run, so this doubles as a smoke test of the JS.

Run from the repo root (requires Playwright):
    python3 scripts/screenshots.py
"""

import functools
import http.server
import os
import socket
import sys
import threading

from playwright.sync_api import sync_playwright

APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WEB_DIR = os.path.join(APP_DIR, "web")
OUT_DIR = os.path.join(APP_DIR, "screenshots")


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _serve(port):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=WEB_DIR)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    port = _free_port()
    httpd = _serve(port)
    base = f"http://127.0.0.1:{port}/index.html"
    errors = []
    shots = []

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                                  is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))

        def settle(ms=450):
            page.evaluate("document.fonts.ready")
            page.wait_for_timeout(ms)

        def shot(name, ms=450):
            settle(ms)
            path = os.path.join(OUT_DIR, f"{name}.png")
            page.screenshot(path=path)
            shots.append(path)

        def goto(hash_):
            page.evaluate(f"location.hash = '{hash_}'")
            settle(300)

        def scroll(px):
            page.evaluate(f"document.getElementById('screen').scrollTop = {px}")

        page.goto(base + "#welcome")
        page.evaluate("localStorage.clear()")
        page.reload()
        shot("01-welcome")

        # Google sign-in demo flow
        page.click("#google-signin")
        shot("01a-google-chooser", 600)
        page.click("[data-act='pick-google-account']")
        shot("01b-after-google-signin", 600)
        goto("#onboard/verify")
        shot("01c-google-verify-done", 600)

        # Reset back to welcome to walk the standard phone onboarding & full app flow
        page.evaluate("localStorage.clear()")
        goto("#welcome")
        page.reload()
        page.click("#get-started"); shot("02-city-picker")
        page.click("#city-continue"); shot("03-about-you")
        page.click("#about-continue"); shot("04-verify-start")
        page.click("#verify-phone"); page.wait_for_timeout(900)
        shot("05-verify-done", 1800)
        page.click("#enter-app"); shot("06-home", 2900)
        scroll(560); shot("07-home-feed")
        goto("#circle/working"); shot("08-circle")
        goto("#ask"); shot("09-ask")
        page.click("#kindness-demo"); shot("10-ask-kindness-check", 700)
        goto("#q/p1"); shot("11-question-expert")
        page.click("#reply-kindness-demo"); shot("12-reply-kindness-check", 700)
        page.click("[data-act=post-menu]"); shot("13-report-block-sheet")
        goto("#nearby"); shot("14-nearby-optin")
        page.click("#nearby-toggle"); shot("15-nearby-map", 2900)
        page.click("#hi-m4")
        page.evaluate("document.getElementById('mom-m4').scrollIntoView({block:'center'})")
        shot("16-nearby-hi-sent", 300)
        page.wait_for_timeout(2800)
        page.evaluate("document.getElementById('mom-m4').scrollIntoView({block:'center'})")
        shot("17-nearby-chat-unlocked", 300)
        goto("#meetups"); page.click("#rsvp-e1"); shot("18-meetups", 2900)
        goto("#chat/m1")
        page.fill("#chat-text", "See you at Shoreline on Saturday! 🌅")
        page.click("#chat-send"); page.wait_for_timeout(1700); shot("19-chat")
        page.click("#chat-menu"); shot("20-chat-block-report")
        goto("#me"); shot("21-profile-privacy")
        scroll(520); shot("22-profile-settings")

        desk = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        dp = desk.new_page()
        dp.on("pageerror", lambda e: errors.append(str(e)))
        dp.on("console", lambda m: m.type == "error" and errors.append(m.text))

        def d_settle(ms=450):
            dp.evaluate("document.fonts.ready")
            dp.wait_for_timeout(ms)

        def d_shot(name, ms=450):
            d_settle(ms)
            path = os.path.join(OUT_DIR, f"{name}.png")
            dp.screenshot(path=path)
            shots.append(path)

        def d_goto(hash_):
            dp.evaluate(f"location.hash = '{hash_}'")
            d_settle(300)

        # Clear localstorage for desktop context and go to welcome
        dp.goto(base + "#welcome")
        dp.evaluate("localStorage.clear()")
        dp.reload()
        d_shot("23-desktop-welcome")

        # Google sign-in demo flow for desktop
        dp.click("#google-signin")
        d_shot("24-desktop-google-chooser", 600)
        dp.click("[data-act='pick-google-account']")
        
        # Go to home
        d_goto("#home")
        d_shot("25-desktop-home-feed", 2900)
        
        # Circle
        d_goto("#circle/working")
        d_shot("26-desktop-circle")
        
        # Ask
        d_goto("#ask")
        d_shot("27-desktop-ask")
        
        # Nearby
        d_goto("#nearby")
        d_shot("28-desktop-nearby", 2900)

        browser.close()

    httpd.shutdown()
    for s in shots:
        print(os.path.relpath(s, APP_DIR))
    if errors:
        print("PAGE ERRORS:", *errors, sep="\n  ", file=sys.stderr)
        return 1
    print(f"OK: {len(shots)} screenshots, no page errors")
    return 0


if __name__ == "__main__":
    sys.exit(main())
