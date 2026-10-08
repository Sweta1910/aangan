"""Structural tests for the Saathi web prototype (web/).

These are stdlib-only and fast: they prove the static app is complete and
self-consistent without a browser. Rendering and click-path coverage lives
in scripts/screenshots.py (Playwright), which fails on any uncaught page error.
"""

import html.parser
import json
import os
import re
import shutil
import subprocess
import unittest

APP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WEB_DIR = os.path.join(APP_DIR, "web")
DATA_PREFIX = "window.SAATHI_DATA = "


def _read(name):
    with open(os.path.join(WEB_DIR, name), encoding="utf-8") as f:
        return f.read()


def load_data():
    """data.js is `window.SAATHI_DATA = <strict JSON>;` so it can be parsed here."""
    src = _read("data.js").strip()
    assert src.startswith(DATA_PREFIX), "data.js must start with the SAATHI_DATA prefix"
    return json.loads(src[len(DATA_PREFIX):].rstrip(";"))


class _Collector(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.scripts, self.styles, self.stack, self.errors = set(), [], [], [], []

    void = {"meta", "link", "br", "img", "input", "hr", "source"}

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            if a["id"] in self.ids:
                self.errors.append("duplicate id " + a["id"])
            self.ids.add(a["id"])
        if tag == "script" and a.get("src"):
            self.scripts.append(a["src"])
        if tag == "link" and a.get("rel") == "stylesheet" and not a["href"].startswith("http"):
            self.styles.append(a["href"])
        if tag not in self.void:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in self.void:
            return
        if not self.stack or self.stack[-1] != tag:
            self.errors.append("mismatched </%s>" % tag)
        else:
            self.stack.pop()


class TestShell(unittest.TestCase):
    def test_index_parses_and_references_exist(self):
        p = _Collector()
        p.feed(_read("index.html"))
        self.assertEqual(p.errors, [])
        self.assertEqual(p.stack, [], "unclosed tags in index.html")
        for needed in ("screen", "tabbar", "sheet", "toast", "showcase"):
            self.assertIn(needed, p.ids)
        self.assertEqual(p.scripts, ["data.js", "app.js"], "data.js must load before app.js")
        for ref in p.scripts + p.styles:
            self.assertTrue(os.path.exists(os.path.join(WEB_DIR, ref)), ref)

    def test_viewport_and_description_meta(self):
        src = _read("index.html")
        self.assertIn('name="viewport"', src)
        self.assertIn('name="description"', src)

    def test_js_syntax_with_node_if_available(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        for name in ("data.js", "app.js"):
            r = subprocess.run([node, "--check", os.path.join(WEB_DIR, name)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_css_braces_balanced(self):
        css = re.sub(r"/\*.*?\*/", "", _read("styles.css"), flags=re.S)
        self.assertEqual(css.count("{"), css.count("}"))


class TestData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = load_data()

    def test_brand_is_single_constant(self):
        self.assertEqual(self.d["brand"]["name"], "Saathi")
        self.assertIn("No judgement", self.d["brand"]["tagline"])
        # app.js must read the name from data, never hard-code it.
        self.assertNotIn('"Saathi"', _read("app.js"))

    def test_launch_city_live_others_soon(self):
        live = [c for c in self.d["cities"] if c["status"] == "live"]
        self.assertEqual([c["name"] for c in live], ["Mountain View / Sunnyvale"])
        soon = {c["name"] for c in self.d["cities"] if c["status"] == "soon"}
        self.assertTrue({"Cupertino", "San Jose", "Fremont"} <= soon)

    def test_required_languages_and_stages(self):
        self.assertEqual(set(self.d["languages"]), {"English", "Hindi", "Tamil", "Telugu", "Kannada", "Marathi",
                                                     "Bengali", "Gujarati", "Punjabi", "Malayalam"})
        self.assertEqual(len(self.d["stages"]), 4)

    def test_reactions_are_supportive_only(self):
        labels = {r["label"].lower() for r in self.d["reactions"]}
        self.assertEqual(labels, {"hug", "been there", "helpful"})
        self.assertFalse(any("down" in l or "dislike" in l for l in labels))

    def test_posts_reference_known_circles_and_have_anon_examples(self):
        circles = {c["id"] for c in self.d["circles"]}
        self.assertGreaterEqual(len(circles), 9)
        for p in self.d["posts"]:
            self.assertIn(p["circle"], circles, p["id"])
            self.assertEqual(p["anon"], p["author"] is None, p["id"])
        self.assertTrue(any(p["anon"] for p in self.d["posts"]))
        self.assertTrue(any(not p["anon"] for p in self.d["posts"]))

    def test_expert_badge_example_exists(self):
        experts = [a for p in self.d["posts"] for a in p["answers"] if a.get("expert")]
        self.assertTrue(experts)
        self.assertIn("Lactation", experts[0]["expert"]["role"])

    def test_nearby_is_neighbourhood_level_only(self):
        hoods = {h["id"]: h for h in self.d["neighbourhoods"]}
        for m in self.d["moms"]:
            self.assertIn(m["area"], hoods)
            self.assertTrue(m["distance"].startswith("~"), "distances must be approximate")
            for banned in ("lat", "lng", "lon", "address", "street"):
                self.assertNotIn(banned, m)

    def test_ids_unique(self):
        for key in ("circles", "posts", "moms", "events", "neighbourhoods"):
            ids = [x["id"] for x in self.d[key]]
            self.assertEqual(len(ids), len(set(ids)), key)

    def test_chats_only_for_mutually_accepted_moms(self):
        moms = {m["id"]: m for m in self.d["moms"]}
        for mid in self.d["chats"]:
            self.assertEqual(moms[mid]["status"], "accepted")

    def test_kindness_demo_triggers_and_rewrites(self):
        k = self.d["kindness"]
        phrases = [p["match"] for p in k["phrases"]]
        for demo in (k["demo"], k["demoAsk"]):
            self.assertTrue(any(re.search(r"\b" + re.escape(p) + r"\b", demo.lower()) for p in phrases), demo)
            rewrite = [r["to"] for r in k["rewrites"] if r["from"] == demo]
            self.assertEqual(len(rewrite), 1)
            self.assertFalse(any(re.search(r"\b" + re.escape(p) + r"\b", rewrite[0].lower()) for p in phrases))

    def test_views_exist_for_every_screen(self):
        js = _read("app.js")
        for view in ("V.welcome", 'V["onboard/city"]', 'V["onboard/about"]', 'V["onboard/verify"]', "V.home",
                     "V.ask", "V.q", "V.nearby", "V.meetups", "V.chat", "V.me"):
            self.assertIn(view + " = function", js)

    def test_google_and_phone_auth_elements(self):
        app_js = _read("app.js")
        styles = _read("styles.css")
        # Google sign-in button exists with official branding
        self.assertIn("Continue with Google", app_js)
        self.assertIn("btn-google", app_js)
        self.assertIn(".btn-google", styles)
        self.assertIn("google-signin", app_js)

        # "or" divider exists between sign-in options
        self.assertIn("auth-divider", app_js)
        self.assertIn(".auth-divider", styles)
        self.assertIn(">or<", app_js)

        # signInWithGoogle demo stub exists with Firebase Auth migration documentation
        self.assertIn("function signInWithGoogle", app_js)
        self.assertIn("GoogleAuthProvider", app_js)
        self.assertIn("signInWithPopup", app_js)

        # Phone flow is still present
        self.assertIn("verify-phone", app_js)
        self.assertIn("Phone verified", app_js)
        self.assertIn("get-started", app_js)

    def test_no_selfie_references_in_web(self):
        for root, _, files in os.walk(WEB_DIR):
            for fname in files:
                if fname.endswith((".js", ".html", ".css", ".json")):
                    path = os.path.join(root, fname)
                    with open(path, encoding="utf-8") as f:
                        content = f.read().lower()
                        self.assertNotIn("selfie", content, f"Found unexpected 'selfie' reference in {fname}")


if __name__ == "__main__":
    unittest.main()
