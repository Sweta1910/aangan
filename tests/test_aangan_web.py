"""Structural tests for the Aangan web prototype (web/).

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
DATA_PREFIX = "window.AANGAN_DATA = "


def _read(name):
    with open(os.path.join(WEB_DIR, name), encoding="utf-8") as f:
        return f.read()


def load_data():
    """data.js is `window.AANGAN_DATA = <strict JSON>;` so it can be parsed here."""
    src = _read("data.js").strip()
    assert src.startswith(DATA_PREFIX), "data.js must start with the AANGAN_DATA prefix"
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
        for needed in ("screen", "tabbar", "sheet", "toast", "dt-logo", "right-rail"):
            self.assertNotIn("showcase", p.ids)
            self.assertNotIn("phone", p.ids)
            self.assertIn(needed, p.ids)
        self.assertEqual([s.split("?")[0] for s in p.scripts], ["data.js", "firebase-config.js", "backend.js", "app.js"], "scripts must load in correct order")
        for ref in p.scripts + p.styles:
            self.assertTrue(os.path.exists(os.path.join(WEB_DIR, ref.split("?")[0])), ref)

    def test_viewport_and_description_meta(self):
        src = _read("index.html")
        self.assertIn('name="viewport"', src)
        self.assertIn('name="description"', src)

    def test_cache_busting_present(self):
        html = _read("index.html")
        self.assertRegex(html, r'src="app\.js\?v=[\da-f]{7}"')
        self.assertRegex(html, r'src="backend\.js\?v=[\da-f]{7}"')

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
        self.assertEqual(self.d["brand"]["name"], "Aangan")
        self.assertIn("No judgement", self.d["brand"]["tagline"])
        # app.js must read the name from data, never hard-code it.
        self.assertNotIn('"Aangan"', _read("app.js"))

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


    def test_safety_centre(self):
        app_js = _read("app.js")
        self.assertIn("1-833-852-6262", app_js)
        self.assertIn("988", app_js)
        self.assertIn("1-800-944-4773", app_js)
        # 2026-10-09 re-verification: PSI Spanish text line, 988 chat, hotline languages.
        self.assertIn("sms:19712037773", app_js)
        self.assertIn("https://chat.988lifeline.org/", app_js)
        self.assertIn("1-833-TLC-MAMA", app_js)
        self.assertIn("WORRY_PHRASES", app_js)

    def test_no_soon_stub_for_safety(self):
        app_js = _read("app.js")
        self.assertNotIn('data-act="soon">' + 'icon("shield") + \'<span class="grow">Safety centre & crisis lines</span>', app_js)

    def test_postpartum_circle_exists(self):
        circles = {c["id"] for c in self.d["circles"]}
        self.assertIn("postpartum-feelings", circles)

    def test_views_exist_for_every_screen(self):
        js = _read("app.js")
        for view in ("V.welcome", 'V["onboard/city"]', 'V["onboard/about"]', 'V["onboard/verify"]', "V.home",
                     "V.ask", "V.q", "V.nearby", "V.meetups", "V.chat", "V.me", "V.safety"):
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

    def test_no_saathi_references_in_codebase(self):
        root_dir = os.path.dirname(WEB_DIR)
        for root, dirs, files in os.walk(root_dir):
            if ".git" in root.split(os.sep):
                continue
            for fname in files:
                path = os.path.join(root, fname)
                if fname == "test_aangan_web.py":
                    continue
                if fname.endswith((".js", ".html", ".css", ".json", ".md", ".py")):
                    try:
                        with open(path, encoding="utf-8") as f:
                            content = f.read().lower()
                            self.assertNotIn("saathi", content, f"Found unexpected 'saathi' reference in {path}")
                    except Exception:
                        pass


    def test_css_has_responsive_layout(self):
        css = _read("styles.css")
        self.assertNotIn('.phone {', css)
        self.assertNotIn('.showcase {', css)
        self.assertIn('@media (min-width: 900px)', css, "Must have desktop breakpoint")
        self.assertIn('.app.onboarding-mode', css, "Must have desktop overrides for onboarding mode")
        self.assertIn('.app.onboarding-mode .welcome {', css, "Must style desktop welcome container")
        self.assertIn('@media (min-width: 1200px)', css, "Must have right-rail breakpoint")


    def test_firebase_config_is_wellformed(self):
        # The real web config is committed on purpose: Firebase web apiKeys are
        # public by design; access is controlled by firestore.rules + authorized domains.
        js = _read("firebase-config.js")
        self.assertIn('window.FIREBASE_CONFIG', js)
        self.assertNotIn('PASTE_', js, "placeholders must be replaced by the real config")
        for key in ("apiKey", "authDomain", "projectId", "appId"):
            self.assertRegex(js, r'\b%s:\s*"[^"]+"' % key)
        self.assertIn('aangan-6a58c.firebaseapp.com', js)

    def test_backend_demo_mode_guard(self):
        js = _read("backend.js")
        self.assertIn('window.FIREBASE_CONFIG.apiKey', js)
        self.assertIn('PASTE', js)
        self.assertIn('isReal = false', js)

    def test_firestore_rules(self):
        with open(os.path.join(os.path.dirname(WEB_DIR), "firestore.rules")) as f:
            rules = f.read()
        self.assertIn("allow read, write: if false;", rules)
        self.assertIn("request.auth.uid == uid", rules)
        self.assertIn("resource.data.uid == request.auth.uid", rules)

    def test_anon_posts_no_author_name(self):
        js = _read("app.js")
        self.assertIn('var authorName = isAnon ? null : store.profile.nickname;', js)


class TestRealModeHardening(unittest.TestCase):
    """Real (Firebase) mode used to fail silently: un-caught promises, undefined
    Firestore fields, a premature "Demo mode" badge. These pin the fixes."""

    @classmethod
    def setUpClass(cls):
        cls.app = _read("app.js")
        cls.backend = _read("backend.js")
        with open(os.path.join(APP_DIR, "firestore.rules"), encoding="utf-8") as f:
            cls.rules = f.read()

    def _calls(self, name):
        return [m.start() for m in re.finditer(r"Backend\.%s\(" % name, self.app)]

    def test_every_backend_write_and_profile_read_is_caught(self):
        for name in ("addPost", "addReply", "addReport", "saveProfile", "getProfile", "signOut", "getRedirectResult",
                     "removePost", "deleteReport", "getPost"):
            calls = self._calls(name)
            self.assertTrue(calls, "app.js never calls Backend.%s" % name)
            for start in calls:
                # The promise chain for each call must end in a .catch within the
                # same statement block (before the next `break;` or 1500 chars).
                window = self.app[start:start + 1500]
                end = window.find("break;")
                if end > 0:
                    window = window[:end]
                self.assertIn(".catch(", window, "Backend.%s call at %d has no .catch" % (name, start))

    def test_fail_toast_shows_code_and_logs(self):
        self.assertIn("function failToast(", self.app)
        self.assertIn("console.error(", self.app)
        self.assertIn("Please try again.", self.app)
        self.assertIn("function busy(", self.app)

    def test_demo_label_only_after_ready(self):
        boot = self.app[self.app.index('document.addEventListener("DOMContentLoaded"'):]
        ready = boot.index("Backend.ready.then(")
        first_label = boot.index("showDemoLabel()")
        self.assertGreater(first_label, ready, "Demo label must wait for Backend.ready")
        self.assertNotIn('d.innerHTML = "Demo mode"', boot, "label must come from showDemoLabel, not inline at load")

    def test_posting_requires_sign_in_in_real_mode(self):
        self.assertIn("Please sign in to post", self.app)
        self.assertIn("var isAnon = !!askDraft.anon;", self.app)
        self.assertIn("store.profile.stages || []", self.app)

    def test_addpost_never_writes_undefined(self):
        self.assertIn("!!isAnon", self.backend)
        self.assertIn("function plain(", self.backend)
        for field in ("title: str(title", "body: str(body", "meta: str(meta", "hue: str(hue"):
            self.assertIn(field, self.backend)

    def test_redirect_sign_in_fallback(self):
        for code in ("auth/popup-blocked", "auth/operation-not-supported-in-this-environment",
                     "auth/cancelled-popup-request"):
            self.assertIn(code, self.backend)
        self.assertIn("signInWithRedirect(auth, provider)", self.backend)
        self.assertIn("fbGetRedirectResult(auth)", self.backend)
        self.assertIn("Backend.getRedirectResult()", self.app)

    def test_reply_count_increment_allowed_by_rules(self):
        self.assertIn("replyCount: increment(1)", self.backend)
        self.assertIn("allow update:", self.rules)
        self.assertIn("affectedKeys().hasOnly(['replyCount'])", self.rules)
        self.assertIn("p.replyCount || 0", self.app)
        self.assertIn("match /replies/{replyId}", self.rules)

    def test_null_created_at_and_missing_fields_render(self):
        self.assertIn('if (!t) return "just now";', self.app)
        self.assertIn('serverTimestamps: "estimate"', self.backend)
        self.assertIn("reactionBar(p.id, p.reactions || {})", self.app)
        self.assertIn("p.circle ? circle(p.circle) : null", self.app)

    def test_listeners_have_error_callbacks_and_wait_for_sign_in(self):
        # posts, replies, reports: every listener has an error callback.
        self.assertEqual(self.backend.count("onSnapshot(q, function(snap)"), 3)
        self.assertEqual(self.backend.count("if (onError) onError(e);"), 3)
        self.assertIn("if (!B.user) { B.posts = []; return; }", self.app)

    def test_circle_optional_when_posting(self):
        # canPost check only needs title > 4 chars, circle is optional
        self.assertIn("var canPost = askDraft.title.trim().length > 4;", self.app)
        self.assertNotIn("askDraft.circle && askDraft.title", self.app)
        # circle picker label indicates optional
        self.assertIn('Circle <span class="tiny">(optional)</span>', self.app)
        # ask-post button has hint when disabled
        self.assertIn('id="ask-hint"', self.app)
        self.assertIn("Add a title (at least 5 characters) to post", self.app)
        # circle can be deselected by clicking again
        self.assertIn("askDraft.circle = (askDraft.circle === id ? null : id);", self.app)
        # firestore rules do not mandate circle field
        self.assertNotIn("request.resource.data.circle is string", self.rules)
        # backend stores null when circle is empty/not chosen
        self.assertIn('circle: (circle && typeof circle === "string" && circle.trim()) ? circle.trim() : null', self.backend)

    def test_backend_js_syntax_with_node_if_available(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("node not installed")
        r = subprocess.run([node, "--check", os.path.join(WEB_DIR, "backend.js")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class TestModeration(unittest.TestCase):
    """Moderation queue: moderators/{uid} made by hand in the console; rules gate it."""

    @classmethod
    def setUpClass(cls):
        cls.app = _read("app.js")
        cls.backend = _read("backend.js")
        cls.css = _read("styles.css")
        with open(os.path.join(APP_DIR, "firestore.rules"), encoding="utf-8") as f:
            cls.rules = f.read()

    def _block(self, header):
        i = self.rules.index(header)
        return self.rules[i:self.rules.index("\n    }", i)]

    def test_rules_is_moderator_helper(self):
        self.assertIn("function isModerator()", self.rules)
        self.assertIn("exists(/databases/$(database)/documents/moderators/$(request.auth.uid))", self.rules)

    def test_rules_no_client_can_write_moderators(self):
        block = self._block("match /moderators/{uid}")
        self.assertIn("allow write: if false;", block)
        self.assertIn("request.auth.uid == uid", block)  # may read only her own doc
        self.assertNotIn("create", block)
        self.assertNotIn("update", block)

    def test_rules_moderator_powers(self):
        reports = self._block("match /reports/{reportId}")
        self.assertIn("allow read, delete: if isModerator();", reports)
        self.assertIn("request.resource.data.reporterUid == request.auth.uid", reports)
        self.assertEqual(self.rules.count("(isModerator() || resource.data.uid == request.auth.uid)"), 2)

    def test_rules_keep_existing_and_deny_by_default(self):
        self.assertIn("match /{document=**} {\n      allow read, write: if false;", self.rules)
        self.assertIn("affectedKeys().hasOnly(['replyCount'])", self.rules)
        self.assertIn("request.resource.data.get('replyCount', 0) == 0", self.rules)
        self.assertIn("request.resource.data.get('author', null) == null", self.rules)
        self.assertNotIn("allow read: if false;", self._block("match /reports/{reportId}"))

    def test_backend_remove_post_cascades_in_one_batch(self):
        self.assertIn("Backend.removePost = function(postId)", self.backend)
        self.assertIn("writeBatch(db)", self.backend)
        self.assertIn('collection(db, "posts/" + postId + "/replies")', self.backend)
        self.assertIn('where("postId", "==", postId)', self.backend)
        self.assertIn("return batch.commit();", self.backend)
        self.assertIn('doc(db, "moderators", uid)', self.backend)
        self.assertIn('deleteDoc(doc(db, "reports", reportId))', self.backend)

    def test_app_moderation_screen(self):
        for s in ("V.mod = function", "Remove post", "Keep (dismiss report)", 'href="#mod"',
                  "window.confirm(", 'failToast("remove the post", el)', 'failToast("dismiss the report", el)',
                  'failToast("load reports", null)'):
            self.assertIn(s, self.app)
        self.assertIn("function canModerate() { return isRealMode() ? modState.isMod : true; }", self.app)

    def test_mod_flag_never_persisted(self):
        self.assertIn("var modState = {", self.app)
        self.assertNotIn("store.isMod", self.app)
        self.assertIn("syncModerator(u);", self.app)
        # checkModerator runs via the `B` alias; its chain must still end in .catch.
        i = self.app.index("B.checkModerator(u.uid)")
        self.assertIn(".catch(", self.app[i:i + 1200])
        self.assertIn("if (modState.unsub) { modState.unsub(); modState.unsub = null; }", self.app)

    def test_demo_mode_reports_in_local_store(self):
        self.assertIn("reports: [],        // demo-mode reports", self.app)
        self.assertIn("store.reports.unshift(", self.app)

    def test_account_id_with_copy(self):
        self.assertIn("Your account ID", self.app)
        self.assertIn('data-act="copy-uid"', self.app)
        self.assertIn("navigator.clipboard.writeText(myUid)", self.app)

    def test_moderation_css(self):
        for sel in (".btn-danger", ".mod-item", ".mod-actions", ".uid-row"):
            self.assertIn(sel, self.css)


if __name__ == "__main__":
    unittest.main()
