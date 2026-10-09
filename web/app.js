/* Aangan prototype — single-file SPA, zero backend.
 *
 * Why this shape: the prototype must open from `python3 -m http.server` (or even
 * file://) with no build step, so it is plain ES2017 in one IIFE. Views are pure
 * functions of (route, store) that return HTML strings; a single delegated click
 * handler on #app dispatches `data-act` attributes. Hash routes (#home, #q/p1,
 * #chat/m1 ...) make every screen deep-linkable, which is also what the
 * screenshot script relies on.
 *
 * State: immutable mock content lives in data.js (window.AANGAN_DATA). Anything
 * the visitor does (posts, reactions, RSVPs, hi-requests, chats, privacy
 * settings) is kept in `store` and persisted to localStorage so a demo survives
 * a refresh. "Reset demo" on the Me tab clears it.
 */
(function () {
  "use strict";

  var D = window.AANGAN_DATA;
  var BRAND = D.brand; // single rename point: change brand.name in data.js
  var STORE_KEY = "aangan.demo.v1";

  // ---------------------------------------------------------------- store
  function freshStore() {
    return {
      onboarded: false,
      city: "mv-sv",
      waitlist: [],
      profile: { nickname: D.me.nickname, fullName: "", email: "", anonDefault: true, stages: ["Toddler"], langs: ["English", "Hindi"] },
      verify: { phone: false, google: false },
      authMethod: null,
      nearbyOn: false,
      msgPolicy: "mutual",
      posts: [],          // posts created in this demo session
      answers: {},        // postId -> [answers created in this demo]
      reacted: {},        // "p1:hug" | "p1/a2:helpful" -> true
      rsvp: {},           // eventId -> true
      req: {},            // momId -> "pending" | "accepted"
      chats: {},          // momId -> [messages]
      hidden: [],         // post ids hidden by this user
      reports: [],        // demo-mode reports (real mode reads Firestore /reports)
      blocked: [],        // author nicknames / mom ids blocked
      joined: {}          // circleId -> true
    };
  }
  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) { var s = JSON.parse(raw); return Object.assign(freshStore(), s); }
    } catch (e) { /* private mode or bad JSON: start fresh */ }
    return freshStore();
  }
  var store = load();
  // Moderator state is deliberately NOT in `store`: it must never be persisted to
  // localStorage (a stale/forged flag would only hide buttons anyway -- Firestore
  // rules are the real gate). Reset on every auth change by syncModerator().
  var modState = { isMod: false, reports: [], unsub: null, postCache: {}, fetching: {} };
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } }

  // -------------------------------------------------------------- helpers
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function initials(name) {
    var parts = String(name).replace(/([a-z])([A-Z])/g, "$1 $2").split(/[\s._-]+/).filter(Boolean);
    return ((parts[0] || "?")[0] + ((parts[1] || "")[0] || "")).toUpperCase();
  }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function circle(id) { return byId(D.circles, id); }
  function mom(id) { return byId(D.moms, id); }
  function hood(id) { return byId(D.neighbourhoods, id); }
  // Firestore createdAt is null on a pending local write (serverTimestamp not yet
  // resolved); treat anything missing or odd as "just now" rather than throwing.
  function formatTime(t) {
    if (!t) return "just now";
    if (typeof t === "string") return t;
    if (typeof t === "number") { var ms = t; t = { toDate: function () { return new Date(ms); } }; }
    if (typeof t.toDate === "function") {
      var d = t.toDate();
      if (!d || isNaN(d.getTime())) return "just now";
      var diff = (Date.now() - d.getTime()) / 60000;
      if (diff < 1) return "just now";
      if (diff < 60) return Math.floor(diff) + "m";
      if (diff < 1440) return Math.floor(diff/60) + "h";
      return Math.floor(diff/1440) + "d";
    }
    return "now";
  }

  function allPosts() {
    if (window.Backend && window.Backend.isReal) {
       return (window.Backend.posts || []).filter(function (p) {
         p.time = formatTime(p.createdAt);
         return store.hidden.indexOf(p.id) < 0 && !(p.author && store.blocked.indexOf(p.author) >= 0);
       });
    }
    return store.posts.concat(D.posts).filter(function (p) {
      return store.hidden.indexOf(p.id) < 0 && !(p.author && store.blocked.indexOf(p.author) >= 0);
    });
  }
  function post(id) {
    if (window.Backend && window.Backend.isReal) {
      var arr = window.Backend.posts || [];
      for (var i=0; i<arr.length; i++) if (arr[i].id === id) { arr[i].time = formatTime(arr[i].createdAt); return arr[i]; }
      return null;
    }
    return byId(store.posts.concat(D.posts), id);
  }
  function answersFor(p) {
    if (window.Backend && window.Backend.isReal) {
      var list = window.Backend._currentReplies || [];
      list.forEach(function(a) { a.time = formatTime(a.createdAt); });
      return list.filter(function (a) { return !(a.author && store.blocked.indexOf(a.author) >= 0); });
    }
    var list = (p.answers || []).concat(store.answers[p.id] || []);
    return list.filter(function (a) { return !(a.author && store.blocked.indexOf(a.author) >= 0); });
  }
  function momStatus(m) { return store.req[m.id] || m.status; }

  var ICONS = {
    home: '<path d="M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5h-4.5V15h-5v5.5H5A1.5 1.5 0 0 1 3.5 19z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.4-3.6 4.3-5.5 7.5-5.5s6.1 1.9 7.5 5.5"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    send: '<path d="M4.5 12 20 4.5 14 20l-2.8-6.2z"/><path d="m11.2 13.8 3.3-3.3"/>',
    chat: '<path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z"/>',
    shield: '<path d="M12 3 4.5 6v5.5c0 4.7 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.8 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    flag: '<path d="M5.5 21V4.5m0 0h11l-2.2 4 2.2 4h-11"/>',
    block: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
    eyeoff: '<path d="M3 3l18 18M10.6 6.1c.5-.1.9-.1 1.4-.1 5 0 8.5 4.5 9.5 6-.5.8-1.6 2.3-3.2 3.6M6.6 6.6C4.6 7.9 3.1 9.9 2.5 12c1 1.5 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2L9 5h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.5"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    heart: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/>',
    users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5c1-3 3.5-4.5 6.5-4.5s5.5 1.5 6.5 4.5"/><path d="M16 5.2a3.5 3.5 0 0 1 0 6.6M18 15.2c1.7.6 2.9 2 3.5 4.3"/>',
    reset: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20"/>',
    hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-1V4a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L5 15.5a1.6 1.6 0 0 1 2.4-2.1L8 14"/>'
  };
  function icon(name, cls) {
    return '<svg class="' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + "</svg>";
  }
  function logoMark(cls) {
    return '<svg class="logo-mark ' + (cls || "") + '" viewBox="0 0 64 64" aria-hidden="true">' +
      '<circle cx="32" cy="32" r="32" fill="#FCEFD3"/>' +
      '<path d="M32 13c6.5 7.5 8.5 15.5 0 28-8.5-12.5-6.5-20.5 0-28z" fill="#B9572F"/>' +
      '<path d="M13 25.5c9.5 0 16 5.5 19 15.5-10.5 1-17-4.5-19-15.5z" fill="#E8A33D"/>' +
      '<path d="M51 25.5c-9.5 0-16 5.5-19 15.5 10.5 1 17-4.5 19-15.5z" fill="#E8A33D"/>' +
      '<path d="M17 46c4.6 2.6 9.6 3.8 15 3.8S42.4 48.6 47 46" stroke="#1E4D4F" stroke-width="3.2" fill="none" stroke-linecap="round"/>' +
      "</svg>";
  }
  function googleIcon(size) {
    var sz = size || 18;
    return '<svg viewBox="0 0 24 24" width="' + sz + '" height="' + sz + '" class="google-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>' +
      '<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>' +
      '<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>' +
      '<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>' +
      '</svg>';
  }
  function mandala() {
    // Concentric petal rings, drawn at low opacity behind the welcome hero.
    var s = '<svg class="mandala" viewBox="-100 -100 200 200" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">';
    [[16, 78, 14], [12, 54, 11], [8, 32, 8]].forEach(function (ring) {
      for (var i = 0; i < ring[0]; i++) {
        var a = (360 / ring[0]) * i;
        s += '<ellipse cx="0" cy="-' + ring[1] + '" rx="' + (ring[2] * 0.55) + '" ry="' + ring[2] + '" transform="rotate(' + a + ')"/>';
      }
    });
    s += '<circle r="92"/><circle r="66"/><circle r="18"/><circle r="6" fill="currentColor"/></svg>';
    return s;
  }
  function avatar(name, hue, size) {
    if (!name) return '<span class="avatar hue-anon ' + (size || "") + '" aria-label="Anonymous mom">' + icon("user") + "</span>";
    return '<span class="avatar hue-' + (hue || "teal") + " " + (size || "") + '" aria-hidden="true">' + esc(initials(name)) + "</span>";
  }
  function switchEl(on, act, label, extra) {
    return '<button class="switch" role="switch" aria-checked="' + (on ? "true" : "false") + '" aria-label="' + esc(label) + '" data-act="' + act + '"' + (extra || "") + "></button>";
  }
  function greeting() {
    var h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  }

  // ---------------------------------------------------------- kindness
  // Client-side demo only: a phrase list with softer alternatives. A real build
  // would use a moderation model server-side; this just shows the UX moment.
  function kindnessScan(text) {
    var lower = text.toLowerCase(), hits = [];
    D.kindness.phrases.forEach(function (p) {
      var re = new RegExp("\\b" + p.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
      if (re.test(lower) && !hits.some(function (h) { return h.match.indexOf(p.match) >= 0; })) hits.push(p);
    });
    return hits;
  }
  function softenText(text, hits) {
    var curated = (D.kindness.rewrites || []).filter(function (r) { return r.from.trim() === String(text).trim(); })[0];
    if (curated) return curated.to;
    var out = text;
    hits.forEach(function (h) {
      out = out.replace(new RegExp("\\b" + h.match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi"), h.softer);
    });
    return out;
  }
  function highlight(text, hits, tag) {
    var out = esc(text);
    hits.forEach(function (h) {
      var src = tag === "ins" ? h.softer : h.match;
      out = out.replace(new RegExp("\\b(" + esc(src).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b", "gi"), "<" + tag + ">$1</" + tag + ">");
    });
    return out;
  }
  function nudgeHtml(text, hits, scope) {
    var softened = softenText(text, hits);
    return '<div class="nudge" id="' + scope + '-nudge" role="alert">' +
      '<div class="nudge-head"><span class="ni">💛</span><b>Kindness check</b></div>' +
      "<p>This might land harder than you mean. Moms here are often having a tough day — " +
      "could you say it a little more gently?</p>" +
      '<p class="tiny" style="margin-top:8px">Words that may sting: ' + hits.map(function (h) { return "<mark>" + esc(h.match) + "</mark>"; }).join(" ") + "</p>" +
      '<div class="suggest"><span class="tiny">Suggested</span><br>' + highlight(softened, hits, "ins") + "</div>" +
      '<div class="nudge-actions">' +
      '<button class="btn btn-primary btn-sm" data-act="kind-use" data-scope="' + scope + '" id="' + scope + '-kind-use">Use kinder wording</button>' +
      '<button class="btn btn-ghost btn-sm" data-act="kind-edit" data-scope="' + scope + '">Edit myself</button>' +
      "</div>" +
      '<button class="skip" data-act="kind-skip" data-scope="' + scope + '">Post as is</button>' +
      "</div>";
  }

  // Client-side demo only: A real launch needs server-side moderation + trained human review.
  var WORRY_PHRASES = ["kill myself", "end my life", "want to die", "hurt myself", "hurt my baby", "better off without me", "can't go on", "no reason to live"];
  function worryingScan(text) {
    var lower = String(text).toLowerCase();
    for (var i = 0; i < WORRY_PHRASES.length; i++) {
      if (lower.indexOf(WORRY_PHRASES[i]) >= 0) return true;
    }
    return false;
  }

  function showSafetySheet(postCbAction) {
    var html = '<div style="padding:10px">' +
      '<div style="text-align:center;margin-bottom:16px"><span style="font-size:32px">🤍</span></div>' +
      '<h3 style="text-align:center;margin-bottom:8px">It sounds like you\'re carrying a lot right now. You deserve support right away.</h3>' +
      '<p class="tiny" style="text-align:center;margin-bottom:24px">National Maternal Mental Health Hotline: 1-833-852-6262<br>988 Suicide & Crisis Lifeline: 988</p>' +
      '<button class="btn btn-primary btn-block" data-act="sheet-close-then-safety" style="margin-bottom:12px">Talk to someone now</button>' +
      '<button class="btn btn-ghost btn-block" data-act="' + postCbAction + '">Post to the circle</button>' +
      '</div>';
    openSheet(html);
  }

  // ---------------------------------------------------------- components
  function reactionBar(key, counts) {
    return D.reactions.map(function (r) {
      var on = !!store.reacted[key + ":" + r.id];
      var n = (counts[r.id] || 0) + (on ? 1 : 0);
      return '<button class="react" data-act="react" data-key="' + key + '" data-r="' + r.id + '" aria-pressed="' + on + '" aria-label="' + r.label + " (" + n + ')">' +
        '<span class="e">' + r.emoji + "</span>" + r.label + (n ? " · " + n : "") + "</button>";
    }).join("");
  }
  function postCard(p, opts) {
    opts = opts || {};
    // Firestore posts carry no reactions/answers and may name an unknown circle;
    // fall back instead of throwing, which would blank the whole feed.
    var c = p.circle ? circle(p.circle) : null;
    var name = p.anon ? "Anonymous mom" : (p.author || "Mom");
    var count = (window.Backend && window.Backend.isReal) ? (p.replyCount || 0) : answersFor(p).length;
    return '<article class="card post ' + (opts.full ? "" : "clickable") + '" ' + (opts.full ? "" : 'data-href="#q/' + p.id + '"') + ' id="post-' + p.id + '">' +
      '<div class="post-head">' + avatar(p.anon ? null : p.author, p.hue) +
      '<div class="who"><b>' + esc(name) + "</b><span>" + esc(p.meta) + " · " + esc(p.time) + "</span></div>" +
      (opts.full ? '<button class="icon-btn" data-act="post-menu" data-id="' + p.id + '" aria-label="More options">' + icon("more") + "</button>" : "") +
      "</div>" +
      (opts.full || !c ? "" : '<div class="post-tagrow"><a class="tag" style="text-decoration:none" href="#circle/' + c.id + '">' + c.emoji + " " + esc(c.name) + "</a></div>") +
      "<h3>" + esc(p.title) + "</h3>" +
      (p.body ? '<p class="body ' + (opts.full ? "" : "clamp") + '">' + esc(p.body) + "</p>" : "") +
      '<div class="post-foot">' + reactionBar(p.id, p.reactions || {}) +
      (opts.full ? "" : '<span class="replies-count">' + icon("chat") + count + "</span>") +
      "</div></article>";
  }
  function emptyState(emoji, title, text) {
    return '<div class="empty-answers"><div class="ea">' + emoji + '</div><b>' + title + '</b><p class="tiny" style="margin-top:4px">' + text + "</p></div>";
  }

  // ---------------------------------------------------------------- views
  var V = {};

  V.welcome = function () {
    return { tab: null, html:
      '<div class="welcome view">' +
      '<div class="toran" aria-hidden="true"></div>' + mandala() +
      '<div class="welcome-hero">' +
      '<div class="logo">' + logoMark() + '<span class="logo-word" style="font-size:28px">' + esc(BRAND.name) + "</span></div>" +
      "<h1>No judgement.<br><em>Just moms.</em></h1>" +
      "<p>" + esc(BRAND.blurb) + "</p></div>" +
      '<div class="promise">' +
      promiseRow("🤍", "var(--plum-soft)", "Women-only & verified", "Every member is verified by phone or Google") +
      promiseRow("🫶", "var(--peach)", "Anonymous when you need it", "Ask anything without your name on it") +
      promiseRow("📍", "var(--teal-soft)", "Moms near you", "Starting in Mountain View & Sunnyvale") +
      "</div>" +
      '<div class="welcome-cta">' +
      '<div class="welcome-cta-header"><h3>Join the circle</h3><p>Women-only · Safe · Verified</p></div>' +
      '<button class="btn btn-google btn-block" data-act="google-signin" id="google-signin">' + googleIcon(18) + "<span>Continue with Google</span></button>" +
      '<div class="auth-divider"><span>or</span></div>' +
      '<button class="btn btn-primary btn-block" data-act="start-phone-onboard" id="get-started">Continue with phone</button>' +
      '<button class="btn btn-ghost btn-block" data-act="skip-onboarding" id="have-account">I already have an account</button>' +
      '<p class="tiny" style="margin-bottom:8px;font-weight:600">Moms supporting moms — not a replacement for your doctor or therapist.</p>' +
      '<p class="tiny">Prototype · all people, posts and places are fictional demo data</p>' +
      "</div></div>" };
  };
  function promiseRow(emoji, bg, title, sub) {
    return '<div class="card promise-row"><span class="pi" style="background:' + bg + '">' + emoji + "</span><div><b>" + title + "</b><span>" + sub + "</span></div></div>";
  }
  function steps(n) {
    return '<div class="ob-steps" aria-label="Step ' + n + ' of 3">' + [1, 2, 3].map(function (i) { return "<i class=\"" + (i <= n ? "on" : "") + "\"></i>"; }).join("") + "</div>";
  }
  function obBack(to) {
    return '<div class="backbar"><button class="icon-btn" data-act="go" data-to="' + to + '" aria-label="Back">' + icon("back") + '</button><span class="title"></span></div>';
  }

  V["onboard/city"] = function () {
    var cities = D.cities.map(function (c) {
      if (c.status === "live") {
        return '<button class="card city live" aria-pressed="' + (store.city === c.id) + '" data-act="city" data-id="' + c.id + '" id="city-' + c.id + '">' +
          '<span class="ci">🌼</span><span class="grow"><b>' + esc(c.name) + "</b><span>" + c.members.toLocaleString() + ' moms already here</span></span><span class="live-pill">Live</span></button>';
      }
      var wl = store.waitlist.indexOf(c.id) >= 0;
      return '<button class="card city soon" data-act="waitlist" data-id="' + c.id + '" id="city-' + c.id + '">' +
        '<span class="ci">🌱</span><span class="grow"><b>' + esc(c.name) + "</b><span>" + (wl ? "You're on the waitlist ✓" : "Opening " + esc(c.eta)) + '</span></span><span class="soon-pill">Coming soon</span></button>';
    }).join("");
    return { tab: null, html:
      '<div class="view">' + obBack("#welcome") + '<div class="ob">' + steps(1) +
      "<h1>Where are you, mama?</h1>" +
      '<p class="lead">We\'re launching city by city so every circle feels truly local.</p>' +
      '<div class="city-list">' + cities + "</div>" +
      '<p class="waitlist">Tap a "coming soon" city to join its waitlist.</p>' +
      '<div class="ob-foot"><button class="btn btn-primary btn-block" data-act="go" data-to="#onboard/about" id="city-continue">Continue</button></div>' +
      "</div></div>" };
  };

  V["onboard/about"] = function () {
    var p = store.profile;
    var stageChips = D.stages.map(function (s) {
      return '<button class="chip" data-act="toggle-stage" data-v="' + esc(s) + '" aria-pressed="' + (p.stages.indexOf(s) >= 0) + '">' + icon("check", "check") + esc(s) + "</button>";
    }).join("");
    var langChips = D.languages.map(function (l) {
      return '<button class="chip" data-act="toggle-lang" data-v="' + esc(l) + '" aria-pressed="' + (p.langs.indexOf(l) >= 0) + '">' + icon("check", "check") + esc(l) + "</button>";
    }).join("");
    return { tab: null, html:
      '<div class="view">' + obBack("#onboard/city") + '<div class="ob">' + steps(2) +
      "<h1>A little about you</h1>" +
      '<p class="lead">Only what you choose to share. You can change this anytime.</p>' +
      '<div class="field"><label for="nick">Pick a nickname</label>' +
      '<input class="input" id="nick" maxlength="20" value="' + esc(p.nickname) + '" autocomplete="off" data-input="nick">' +
      '<p class="hint">No need for your real name — most moms here don\'t use it.</p></div>' +
      '<div class="card toggle-row" style="margin-top:16px"><div class="grow"><b>Post anonymously by default</b><span>You can switch it per post</span></div>' + switchEl(p.anonDefault, "toggle-anon-default", "Post anonymously by default") + "</div>" +
      '<div class="field"><span class="label">Your kids\' stages</span><div class="chips">' + stageChips + "</div></div>" +
      '<div class="field"><span class="label">Languages you speak</span><div class="chips">' + langChips + "</div></div>" +
      '<div class="ob-foot"><button class="btn btn-primary btn-block" data-act="go" data-to="#onboard/verify" id="about-continue"' + (p.nickname.trim() ? "" : " disabled") + ">Continue</button></div>" +
      "</div></div>" };
  };

  V["onboard/verify"] = function () {
    var v = store.verify;
    var isGoogle = !!(v.google || store.authMethod === "google");
    var phoneState = v.phone ? '<span class="done-badge">' + icon("check") + "Phone verified</span>"
      : '<div class="phone-input"><input class="input cc" value="+1" aria-label="Country code" readonly><input class="input" value="(650) 555-0142" aria-label="Phone number" inputmode="tel"></div>' +
        '<button class="btn btn-ghost btn-sm" style="margin-top:10px" data-act="verify-phone" id="verify-phone">Send code</button>';

    var verifyCard;
    if (isGoogle) {
      verifyCard = '<div class="card verify-card"><span class="vi" style="background:#fff;border:1px solid #dadce0">' + googleIcon(22) + '</span><div class="grow"><b>Google account verified</b><span class="tiny">' + esc(store.profile.email || "priya.sharma@gmail.com") + '</span><div class="state"><span class="done-badge">' + icon("check") + "Verified with Google</span></div></div></div>";
    } else {
      verifyCard = '<div class="card verify-card"><span class="vi">' + icon("phone") + '</span><div class="grow"><b>Verify your phone</b><span class="tiny">One account per number — keeps out fake profiles.</span><div class="state">' + phoneState + "</div></div></div>" +
        (v.phone ? "" : '<div class="auth-divider" style="margin:14px 0 10px"><span>or</span></div>' +
          '<button class="btn btn-google btn-block btn-sm" data-act="google-signin" id="verify-google">' + googleIcon(16) + '<span>Verify with Google instead</span></button>');
    }

    var canEnter = isGoogle || v.phone;
    return { tab: null, html:
      '<div class="view">' + obBack("#onboard/about") + '<div class="ob">' + steps(3) +
      "<h1>Keeping it moms-only</h1>" +
      '<p class="lead">A quick, private check so this stays a women-only space.</p>' +
      verifyCard +
      '<div class="ob-foot"><button class="btn btn-primary btn-block" data-act="finish-onboarding" id="enter-app"' + (canEnter ? "" : " disabled") + ">Enter " + esc(BRAND.name) + "</button>" +
      '<p class="tiny" style="text-align:center;margin-top:10px">Demo: no real data is sent anywhere.</p></div>' +
      "</div></div>" };
  };

  function homeTop() {
    var c = byId(D.cities, store.city);
    return '<header class="topbar"><div class="logo">' + logoMark() + '<div><div class="logo-word">' + esc(BRAND.name) + '</div><div class="sub">' + icon("pin", "") .replace('class=""', 'style="width:12px;height:12px"') + esc(c.name) + "</div></div></div>" +
      '<span style="flex:1"></span>' +
      '<a href="#safety" class="icon-btn" aria-label="Need help now?" style="color:var(--plum)">' + icon("shield") + '</a>' +
      '<a class="icon-btn" href="#chats" aria-label="Messages" id="open-chats">' + icon("chat") + '<span class="dot"></span></a></header>';
  }

  V.home = function () {
    var circles = D.circles.map(function (c) {
      return '<a class="card circle-card" href="#circle/' + c.id + '" style="text-decoration:none;color:inherit"><span class="ce">' + c.emoji + "</span><b>" + esc(c.name) + "</b><span>" + c.members + " moms</span></a>";
    }).join("");
    var feed = allPosts().map(function (p) { return postCard(p); }).join("");
    return { tab: "home", html:
      '<div class="view">' + homeTop() +
      '<div class="hello"><h2>' + greeting() + ", " + esc(store.profile.nickname) + ' <span aria-hidden="true">🌼</span></h2><p>Here\'s what moms near you are talking about.</p></div>' +
      '<div class="section" style="padding:0;margin-top:14px"><div class="section-head" style="padding:0 18px"><h2>Your circles</h2><span class="muted">Swipe →</span></div>' +
      '<div class="circles-row">' + circles + "</div></div>" +
      '<div class="kind-banner"><span class="kb-i">💛</span><div><b>A kind space, always</b><span>Supportive reactions only — no downvotes, no shaming.</span></div></div>' +
      '<div class="section-head" style="padding:0 18px"><h2>Fresh today</h2><span class="muted">' + allPosts().length + " posts</span></div>" +
      '<div class="feed">' + (feed || '<div style="text-align:center;padding:40px 20px;color:var(--text-muted)">Be the first to share. You\'re not alone.</div>') + "</div></div>" };
  };

  V.circle = function (id) {
    var c = circle(id);
    if (!c) return V.home();
    var posts = allPosts().filter(function (p) { return p.circle === id; });
    var joined = store.joined[id] !== false;
    return { tab: "home", html:
      '<div class="view"><div class="backbar"><button class="icon-btn" data-act="back" aria-label="Back">' + icon("back") + '</button><span class="title">Circle</span></div>' +
      '<div class="card circle-hero"><span class="ce">' + c.emoji + '</span><div style="flex:1"><h2>' + esc(c.name) + '</h2><p class="tiny">' + esc(c.desc) + " · " + c.members + ' moms</p></div>' +
      '<button class="btn btn-sm ' + (joined ? "btn-ghost" : "btn-primary") + '" data-act="join" data-id="' + id + '">' + (joined ? "Joined ✓" : "Join") + "</button></div>" +
      '<div style="padding:0 14px 14px"><a class="btn btn-warm btn-block" href="#ask/' + id + '" style="text-decoration:none">' + icon("plus") + "Ask in this circle</a></div>" +
      '<div class="feed">' + (posts.length ? posts.map(function (p) { return postCard(p); }).join("") : emptyState("🌱", "Be the first to post here", "Your question could help another mom feel less alone.")) + "</div></div>" };
  };

  var askDraft = { circle: null, title: "", body: "", anon: null, nudge: null };
  V.ask = function (circleId) {
    if (circleId && circle(circleId)) askDraft.circle = circleId;
    if (askDraft.anon === null) askDraft.anon = store.profile.anonDefault;
    var picks = D.circles.map(function (c) {
      return '<button class="chip" data-act="ask-circle" data-id="' + c.id + '" aria-pressed="' + (askDraft.circle === c.id) + '">' + c.emoji + " " + esc(c.name) + "</button>";
    }).join("");
    var canPost = askDraft.title.trim().length > 4;
    return { tab: "ask", html:
      '<div class="view"><header class="topbar"><h1>Ask your circle</h1><button class="icon-btn" data-act="go" data-to="#home" aria-label="Close">' + icon("close") + "</button></header>" +
      '<div class="compose">' +
      '<div class="field"><span class="label">Circle <span class="tiny">(optional)</span></span><div class="circle-pick">' + picks + "</div></div>" +
      '<div class="field"><label for="ask-title">Your question</label><input class="input" id="ask-title" data-input="ask-title" maxlength="140" placeholder="e.g. How did you handle the first week of daycare?" value="' + esc(askDraft.title) + '"></div>' +
      '<div class="field"><label for="ask-body">Add details <span class="tiny">(optional)</span></label><textarea class="input" id="ask-body" data-input="ask-body" maxlength="1200" placeholder="Share as much or as little as you like. This is a safe space.">' + esc(askDraft.body) + "</textarea>" +
      '<p class="demo-link">✨ <button class="link" data-act="ask-demo" id="kindness-demo">See the kindness check in action</button></p></div>' +
      '<div class="card toggle-row" style="margin-top:16px"><div class="grow"><b>Post anonymously</b><span>' + (askDraft.anon ? 'Hidden from other moms. Aangan\'s moderators can see who posted, for safety.' : "Shown as " + esc(store.profile.nickname)) + "</span></div>" + switchEl(askDraft.anon, "ask-anon", "Post anonymously") + "</div>" +
      '<div class="anon-preview">' + avatar(askDraft.anon ? null : store.profile.nickname, D.me.hue, "sm") + "<span>Posting as <b>" + (askDraft.anon ? "Anonymous mom" : esc(store.profile.nickname)) + "</b></span></div>" +
      '<div id="ask-nudge-slot">' + (askDraft.nudge ? nudgeHtml(askDraft.body || askDraft.title, askDraft.nudge, "ask") : "") + "</div>" +
      '<div style="margin-top:18px"><button class="btn btn-primary btn-block" data-act="ask-post" id="ask-post"' + (canPost ? "" : " disabled") + ">Post question</button>" +
      '<p class="tiny ask-hint" id="ask-hint" style="text-align:center;margin-top:6px;' + (canPost ? "display:none;" : "") + '">Add a title (at least 5 characters) to post</p></div>' +
      '<p class="tiny" style="text-align:center;margin-top:10px;font-weight:600">Moms supporting moms — not a replacement for your doctor or therapist.</p>' +
      '<p class="tiny" style="text-align:center;margin-top:4px">Be kind. Every mom here is doing her best. 💛</p>' +
      "</div></div>" };
  };

  var replyDraft = { pid: null, text: "", anon: null, nudge: null };
  V.q = function (id) {
    var p = post(id);
    if (!p) return V.home();
    if (replyDraft.pid !== id) replyDraft = { pid: id, text: "", anon: store.profile.anonDefault, nudge: null };
    var c = p.circle ? circle(p.circle) : null;
    var ans = answersFor(p).slice().sort(function (a, b) { return (b.expert ? 1 : 0) - (a.expert ? 1 : 0); });
    var list = ans.map(function (a) {
      var name = a.anon ? "Anonymous mom" : a.author;
      return '<article class="card answer ' + (a.expert ? "expert" : "") + '" id="answer-' + a.id + '">' +
        '<div class="post-head">' + avatar(a.anon ? null : a.author, a.hue) + '<div class="who"><b>' + esc(name) +
        (a.expert ? ' <span class="expert-badge">' + icon("check") + esc(a.expert.label) + "</span>" : "") + "</b><span>" +
        (a.expert ? esc(a.expert.role) + " · " : "") + esc(a.time) + "</span></div>" +
        '<button class="icon-btn" style="width:34px;height:34px;box-shadow:none;background:transparent" data-act="answer-menu" data-author="' + esc(a.author || "") + '" aria-label="More options">' + icon("more") + "</button></div>" +
        '<p class="body">' + esc(a.body) + '</p><div class="post-foot">' + reactionBar(p.id + "/" + a.id, a.reactions || {}) + "</div></article>";
    }).join("");
    return { tab: null, after: function () { var t = $("#reply-text"); if (t && t.value) { t.style.height = "auto"; t.style.height = Math.min(120, t.scrollHeight) + "px"; } }, html:
      '<div class="view" style="padding-bottom:0"><div class="backbar"><button class="icon-btn" data-act="back" aria-label="Back">' + icon("back") + '</button><span class="title">' + (c ? (c.emoji + " " + esc(c.name)) : "Community") + "</span></div>" +
      '<div class="q-detail">' + postCard(p, { full: true }) + "</div>" +
      '<div class="answers-head"><h2>' + ans.length + " supportive " + (ans.length === 1 ? "reply" : "replies") + '</h2><span class="tiny">Kindest first</span></div>' +
      '<div class="answers">' + (list || emptyState("🤍", "No replies yet", "Share what worked for you — even a hug helps.")) + "</div>" +
      '<div style="height:16px"></div>' +
      '<div class="reply-box"><div id="reply-nudge-slot">' + (replyDraft.nudge ? nudgeHtml(replyDraft.text, replyDraft.nudge, "reply") : "") + "</div>" +
      '<div class="reply-anon">' + switchEl(replyDraft.anon, "reply-anon", "Reply anonymously") + "Reply " + (replyDraft.anon ? "anonymously" : "as " + esc(store.profile.nickname)) +
      '<span style="flex:1"></span><button class="link" style="font-size:12px" data-act="reply-demo" id="reply-kindness-demo">Try kindness check</button></div>' +
      '<div class="reply-inner"><textarea id="reply-text" data-input="reply-text" rows="1" placeholder="Write a kind reply…" aria-label="Write a reply">' + esc(replyDraft.text) + "</textarea>" +
      '<button class="send-btn" data-act="reply-send" aria-label="Send reply" id="reply-send">' + icon("send") + "</button></div></div>" +
      '<p class="tiny" style="text-align:center;margin-top:10px;font-weight:600">Moms supporting moms — not a replacement for your doctor or therapist.</p></div>' };
  };

  function mapSvg(activeHood) {
    var s = '<svg viewBox="0 0 340 220" role="img" aria-label="Stylised map of Mountain View and Sunnyvale neighbourhoods">' +
      '<rect width="340" height="220" fill="#F7EEDF"/>' +
      '<path d="M0 0H340V26C290 40 236 22 176 36 112 50 64 30 0 44Z" fill="#D5E8E4"/>' +
      '<text x="250" y="18" font-size="8" fill="#5D8580" font-family="Plus Jakarta Sans" letter-spacing="1.5">SF BAY</text>' +
      '<path d="M54 40c18-6 44-6 58 4 4 10-6 18-26 18-20 0-36-8-32-22z" fill="#D9E8CF"/>' +
      '<text x="62" y="55" font-size="7" fill="#5E7A4E" font-family="Plus Jakarta Sans">Shoreline</text>' +
      '<path d="M0 72C90 62 200 74 340 62" stroke="#EBCB9C" stroke-width="7" fill="none"/>' +
      '<rect x="296" y="56" width="22" height="13" rx="4" fill="#fff" stroke="#E2B676"/><text x="300" y="66" font-size="8" font-weight="700" fill="#8A5A17" font-family="Plus Jakarta Sans">101</text>' +
      '<path d="M0 134C100 128 220 122 340 116" stroke="#EADBC5" stroke-width="5" fill="none"/>' +
      '<text x="96" y="125" font-size="7" fill="#9A8370" font-family="Plus Jakarta Sans">El Camino Real</text>' +
      '<path d="M112 44C118 100 102 160 120 220" stroke="#A9CFC9" stroke-width="2.5" fill="none" stroke-dasharray="1 0"/>' +
      '<path d="M162 66V220" stroke="#E6D6C2" stroke-width="1.5" stroke-dasharray="4 4" fill="none"/>' +
      '<text x="18" y="210" font-size="8.5" font-weight="700" fill="#8F7E74" letter-spacing="2" font-family="Plus Jakarta Sans">MOUNTAIN VIEW</text>' +
      '<text x="236" y="210" font-size="8.5" font-weight="700" fill="#8F7E74" letter-spacing="2" font-family="Plus Jakarta Sans">SUNNYVALE</text>';
    D.neighbourhoods.forEach(function (h) {
      var on = activeHood === h.id;
      s += '<g class="hood ' + (on ? "active" : "") + '" data-act="hood" data-id="' + h.id + '" tabindex="0" role="button" aria-label="' + esc(h.name) + ", about " + h.moms + ' moms">' +
        '<circle class="halo" cx="' + h.x + '" cy="' + h.y + '" r="' + (on ? 24 : 19) + '" fill="rgba(232,163,61,.22)"/>' +
        '<circle cx="' + h.x + '" cy="' + h.y + '" r="11" fill="' + (on ? "#1E4D4F" : "#B9572F") + '"/>' +
        '<text x="' + h.x + '" y="' + (h.y + 3.5) + '" font-size="9" font-weight="700" fill="#fff" text-anchor="middle" font-family="Plus Jakarta Sans">' + h.moms + "</text>" +
        '<text x="' + h.x + '" y="' + (h.y + 22) + '" font-size="7" font-weight="600" fill="#5E4A40" text-anchor="middle" font-family="Plus Jakarta Sans">' + esc(h.short) + "</text></g>";
    });
    return s + "</svg>";
  }

  var nearbyFilter = null;
  V.nearby = function () {
    if (!store.nearbyOn) {
      return { tab: "nearby", html:
        '<div class="view"><div class="optin">' +
        '<svg class="optin-art" viewBox="0 0 220 170" aria-hidden="true"><circle cx="110" cy="88" r="78" fill="#FDE9DA"/><circle cx="110" cy="88" r="52" fill="#FCEFD3"/>' +
        '<circle cx="110" cy="88" r="26" fill="#E0EEEB"/><circle cx="62" cy="58" r="14" fill="#B9572F"/><circle cx="160" cy="70" r="14" fill="#1E4D4F"/><circle cx="138" cy="134" r="14" fill="#E8A33D"/><circle cx="74" cy="124" r="12" fill="#5A2D4C"/>' +
        '<text x="62" y="63" font-size="12" text-anchor="middle" fill="#fff" font-weight="700" font-family="Plus Jakarta Sans">PR</text><text x="160" y="75" font-size="12" text-anchor="middle" fill="#fff" font-weight="700" font-family="Plus Jakarta Sans">AK</text>' +
        '<text x="138" y="139" font-size="12" text-anchor="middle" fill="#fff" font-weight="700" font-family="Plus Jakarta Sans">SN</text><text x="74" y="128" font-size="10" text-anchor="middle" fill="#fff" font-weight="700" font-family="Plus Jakarta Sans">MV</text>' +
        '<path d="M110 74c-6 0-10 4-10 10 0 7 10 16 10 16s10-9 10-16c0-6-4-10-10-10z" fill="#1E4D4F"/><circle cx="110" cy="84" r="3.4" fill="#fff"/></svg>' +
        "<h1>Moms near you</h1>" +
        '<p class="lead">Find moms in your neighbourhood for walks, playdates and chai. You\'re invisible until you choose otherwise.</p>' +
        '<div class="optin-list">' +
        '<div class="row"><span class="oi">' + icon("pin") + "</span><div><b>Neighbourhood only</b>Others see \"Cuesta Park area · ~1 mi\" — never your exact location.</div></div>" +
        '<div class="row"><span class="oi">' + icon("hand") + "</span><div><b>Mutual hellos</b>Chat unlocks only when you both say hi.</div></div>" +
        '<div class="row"><span class="oi">' + icon("eyeoff") + "</span><div><b>Hide anytime</b>Turn this off in one tap from your profile.</div></div></div>" +
        '<div class="card toggle-row"><div class="grow"><b>Show me to moms near me</b><span>Off by default</span></div>' + switchEl(false, "nearby-on", "Show me to moms near me", ' id="nearby-toggle"') + "</div>" +
        "</div></div>" };
    }
    var moms = D.moms.filter(function (m) { return store.blocked.indexOf(m.id) < 0 && (!nearbyFilter || m.area === nearbyFilter); });
    var cards = moms.map(function (m) {
      var st = momStatus(m), h = hood(m.area);
      var action = st === "accepted"
        ? '<a class="btn btn-primary btn-sm" href="#chat/' + m.id + '" style="text-decoration:none">' + icon("chat") + "Message</a>"
        : st === "pending" ? '<button class="btn btn-ghost btn-sm" disabled>' + icon("clock") + "Hi sent</button>"
        : '<button class="btn btn-warm btn-sm" data-act="say-hi" data-id="' + m.id + '" id="hi-' + m.id + '">👋 Say hi</button>';
      var note = st === "accepted" ? icon("check") + "You both said hi — chat is open"
        : st === "pending" ? icon("lock") + "Chat unlocks when " + esc(m.nickname) + " says hi back"
        : icon("lock") + "Chat unlocks after you both say hi";
      return '<article class="card mom" id="mom-' + m.id + '"><div class="mom-top">' + avatar(m.nickname, m.hue, "lg") +
        '<div class="grow"><b>' + esc(m.nickname) + '</b><span class="loc">' + icon("pin") + "<span>" + esc(h.name) + ' · <span style="white-space:nowrap">' + esc(m.distance) + "</span></span></span></div>" +
        '<button class="icon-btn" style="width:34px;height:34px" data-act="mom-menu" data-id="' + m.id + '" aria-label="More options">' + icon("more") + "</button></div>" +
        '<div class="rows"><div class="r"><span class="k">Kids</span><div class="chips">' + m.kids.map(function (k) { return '<span class="tag marigold">' + esc(k) + "</span>"; }).join("") + "</div></div>" +
        '<div class="r"><span class="k">Speaks</span><div class="chips">' + m.languages.map(function (k) { return '<span class="tag teal">' + esc(k) + "</span>"; }).join("") + "</div></div>" +
        '<div class="r"><span class="k">Into</span><div class="chips">' + m.interests.map(function (k) { return '<span class="tag plum">' + esc(k) + "</span>"; }).join("") + "</div></div></div>" +
        '<div class="mom-actions">' + action + "</div>" +
        '<p class="status-note">' + note + "</p></article>";
    }).join("");
    var fh = nearbyFilter && hood(nearbyFilter);
    return { tab: "nearby", html:
      '<div class="view"><header class="topbar"><h1>Moms nearby</h1><a class="icon-btn" href="#chats" aria-label="Messages">' + icon("chat") + "</a></header>" +
      '<div class="card map-card">' + mapSvg(nearbyFilter) +
      '<div class="map-legend"><span>' + icon("shield") + "Neighbourhoods only · never exact spots</span><span>" + (fh ? '<button class="link" data-act="hood-clear">Show all</button>' : "Tap an area") + "</span></div></div>" +
      '<div class="section-head" style="padding:18px 18px 0"><h2>' + (fh ? esc(fh.name) : "Say hi to a mom") + '</h2><span class="muted">' + moms.length + " shown</span></div>" +
      '<div class="privacy-strip">' + icon("eyeoff") + "You're visible as \"" + esc(store.profile.nickname) + ' · Cuesta Park area". <a class="link" href="#me" style="margin-left:auto">Change</a></div>' +
      '<div class="mom-list">' + (cards || emptyState("🌿", "No moms shown here yet", "Try another area — more moms join every week.")) + "</div></div>" };
  };

  var meetupsSeg = "all";
  V.meetups = function () {
    var evs = D.events.filter(function (e) { return meetupsSeg === "all" || store.rsvp[e.id]; });
    var list = evs.map(function (e) {
      var going = !!store.rsvp[e.id];
      var faces = D.moms.slice(0, 3).map(function (m) { return avatar(m.nickname, m.hue, "sm"); }).join("");
      return '<article class="card event" id="event-' + e.id + '"><div class="date-tile"><div class="m">' + e.month + '</div><div class="d">' + e.date + '</div><div class="w">' + e.day + "</div></div>" +
        '<div class="grow"><h3>' + e.emoji + " " + esc(e.title) + "</h3>" +
        '<div class="meta"><span>' + icon("clock") + esc(e.time) + "</span><span>" + icon("pin") + esc(e.place) + "</span></div>" +
        '<p class="desc">' + esc(e.desc) + '</p><div class="chips" style="margin-top:8px;gap:6px">' + e.tags.map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") + '<span class="tag teal">Hosted by ' + esc(e.host) + "</span></div>" +
        '<div class="event-foot"><span class="avatar-stack">' + faces + '</span><span class="going">' + (e.going + (going ? 1 : 0)) + " going</span>" +
        '<button class="btn btn-primary btn-sm rsvp" data-act="rsvp" data-id="' + e.id + '" aria-pressed="' + going + '" id="rsvp-' + e.id + '">' + (going ? icon("check") + "Going" : "RSVP") + "</button></div></div></article>";
    }).join("");
    return { tab: "meetups", html:
      '<div class="view"><header class="topbar"><h1>Meetups</h1></header>' +
      '<p class="muted" style="padding:0 18px 14px;margin-top:-6px;font-size:14px">Small, mom-hosted, in public places around Mountain View & Sunnyvale.</p>' +
      '<div class="seg" role="tablist"><button data-act="seg" data-v="all" aria-pressed="' + (meetupsSeg === "all") + '">Upcoming</button><button data-act="seg" data-v="going" aria-pressed="' + (meetupsSeg === "going") + '">Going (' + Object.keys(store.rsvp).filter(function (k) { return store.rsvp[k]; }).length + ")</button></div>" +
      '<div class="events">' + (list || emptyState("🗓️", "Nothing yet", "RSVP to a meetup and it will show up here.")) + "</div>" +
      '<div class="card host-cta"><span style="font-size:28px">🪔</span><div class="grow"><b>Host a meetup</b><span>Stroller walk, chai morning, toy swap — you pick.</span></div><button class="btn btn-ghost btn-sm" data-act="soon">Start</button></div>' +
      "</div>" };
  };

  var MOCK_REPLIES = ["That sounds lovely 😊", "Haha same here! Toddler life 😅", "Yes! Let's do it. Saturday works for me.", "Aww thank you, that means a lot 💛", "I'll bring the chai ☕"];
  V.chat = function (id) {
    var m = mom(id);
    if (!m) return V.chats();
    var blocked = store.blocked.indexOf(id) >= 0;
    var st = momStatus(m);
    if (!store.chats[id]) store.chats[id] = (D.chats[id] || []).slice();
    var msgs = store.chats[id].map(function (x) {
      return '<div class="msg ' + x.from + '">' + esc(x.text) + '<span class="t">' + esc(x.time) + "</span></div>";
    }).join("");
    var body;
    if (blocked) body = '<div class="blocked-note">' + icon("block", "") .replace('class=""', 'style="width:34px;height:34px"') + "<p style=\"margin-top:8px\"><b>You blocked " + esc(m.nickname) + "</b></p><p class=\"tiny\">She can't see your profile or message you. You can unblock from settings.</p></div>";
    else if (st !== "accepted") body = '<div class="blocked-note">' + icon("lock", "").replace('class=""', 'style="width:34px;height:34px"') + '<p style="margin-top:8px"><b>Chat is locked</b></p><p class="tiny">Chat unlocks once you both say hi.</p><a class="btn btn-warm btn-sm" style="margin-top:12px;text-decoration:none" href="#nearby">Go to Nearby</a></div>';
    else body = '<div class="msgs" id="msgs"><div class="safety-pill">🔒 You both said hi. Meet in public places first, and you can block or report anytime from ⋯</div><div class="day-sep">Today</div>' + msgs + "</div>" +
      '<div class="chat-input"><div class="reply-inner"><textarea id="chat-text" rows="1" placeholder="Message ' + esc(m.nickname) + '…" aria-label="Message"></textarea><button class="send-btn" data-act="chat-send" data-id="' + id + '" aria-label="Send" id="chat-send">' + icon("send") + "</button></div></div>";
    return { tab: null, after: function () { var el = $("#screen"); el.scrollTop = el.scrollHeight; }, html:
      '<div class="view chat-view" style="padding-bottom:0"><div class="chat-head"><button class="icon-btn" data-act="back" aria-label="Back">' + icon("back") + "</button>" + avatar(m.nickname, m.hue) +
      '<div class="grow"><b>' + esc(m.nickname) + "</b><span>" + esc(hood(m.area).name) + " · " + esc(m.kids.join(", ")) + "</span></div>" +
      '<button class="icon-btn" data-act="chat-menu" data-id="' + id + '" aria-label="Block or report" id="chat-menu">' + icon("more") + "</button></div>" + body + "</div>" };
  };

  V.chats = function () {
    var rows = D.moms.filter(function (m) { return momStatus(m) === "accepted" && store.blocked.indexOf(m.id) < 0; }).map(function (m) {
      var msgs = store.chats[m.id] || D.chats[m.id] || [];
      var last = msgs[msgs.length - 1];
      return '<a class="card inbox-row" href="#chat/' + m.id + '" style="text-decoration:none;color:inherit">' + avatar(m.nickname, m.hue) + '<div class="grow"><b>' + esc(m.nickname) + "</b><span>" + esc(last ? last.text : "You both said hi — start the conversation!") + "</span></div>" + icon("chevron", "").replace('class=""', 'style="width:18px;height:18px;color:var(--ink-3)"') + "</a>";
    }).join("");
    var pending = D.moms.filter(function (m) { return momStatus(m) === "pending"; }).length;
    return { tab: null, html:
      '<div class="view"><div class="backbar"><button class="icon-btn" data-act="back" aria-label="Back">' + icon("back") + '</button><span class="title">Messages</span></div>' +
      '<div class="inbox">' + (rows || emptyState("💬", "No chats yet", "Say hi to a mom nearby — chat opens when she says hi back.")) + "</div>" +
      (pending ? '<p class="footer-note">' + pending + " hello" + (pending > 1 ? "s" : "") + " waiting for a reply</p>" : "") +
      '<p class="footer-note">Only moms you\'ve both said hi to can message you.</p></div>' };
  };


  // Helplines re-verified 2026-10-09 against official pages:
  // - PSI (postpartum.net/get-help/psi-helpline/): call 1-800-944-4773 (#1 Espanol, #2 English);
  //   text "Help" to 800-944-4773 (English); text en Espanol 971-203-7773; messages returned daily
  //   8am-11pm ET; PSI says it is NOT a crisis hotline.
  // - 988 (988lifeline.org): call, text or chat (chat.988lifeline.org), 24/7/365, free, confidential;
  //   text and chat also in Spanish.
  // - National Maternal Mental Health Hotline 1-833-852-6262 / 1-833-TLC-MAMA (HRSA,
  //   mchb.hrsa.gov/national-maternal-mental-health-hotline): call or text, 24/7, English & Spanish.
  // Demo only: a real launch needs server-side moderation and trained human review.
  V.safety = function () {
    return { tab: "me", html:
      '<div class="view"><header class="topbar"><h1>Safety centre</h1><button class="icon-btn" data-act="back" aria-label="Back">' + icon("back") + "</button></header>" +
      '<div class="card" style="margin-top:20px;text-align:center">' +
      '<div style="font-size:32px;margin-bottom:12px">🤍</div>' +
      '<h2 style="margin-bottom:8px">You deserve support right away</h2>' +
      '<p class="muted">The first two lines are free, confidential, and open 24/7.</p></div>' +
      '<div class="settings-group"><h3>National Maternal Mental Health Hotline</h3><p class="muted" style="font-size:13px;margin:0 4px 8px">Call or text 1-833-TLC-MAMA \u00b7 24/7 \u00b7 English &amp; Spanish</p><div class="card">' +
      '<a class="link-row" href="tel:18338526262" style="text-decoration:none;color:inherit">' + icon("phone") + '<span class="grow">Call 1-833-852-6262</span>' + icon("chevron") + "</a>" +
      '<a class="link-row" href="sms:18338526262" style="text-decoration:none;color:inherit">' + icon("chat") + '<span class="grow">Text 1-833-852-6262</span>' + icon("chevron") + "</a></div></div>" +
      '<div class="settings-group"><h3>988 Suicide & Crisis Lifeline</h3><p class="muted" style="font-size:13px;margin:0 4px 8px">Call, text or chat \u00b7 24/7 \u00b7 Spanish available</p><div class="card">' +
      '<a class="link-row" href="tel:988" style="text-decoration:none;color:inherit">' + icon("phone") + '<span class="grow">Call 988</span>' + icon("chevron") + "</a>" +
      '<a class="link-row" href="sms:988" style="text-decoration:none;color:inherit">' + icon("chat") + '<span class="grow">Text 988</span>' + icon("chevron") + "</a>" +
      '<a class="link-row" href="https://chat.988lifeline.org/" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">' + icon("chat") + '<span class="grow">Chat online at 988lifeline.org</span>' + icon("chevron") + "</a></div></div>" +
      '<div class="settings-group"><h3>Postpartum Support International (support, not a crisis line)</h3><p class="muted" style="font-size:13px;margin:0 4px 8px">Leave a message any day \u2014 they reply 8am\u201311pm ET. English &amp; Spanish.</p><div class="card">' +
      '<a class="link-row" href="tel:18009444773" style="text-decoration:none;color:inherit">' + icon("phone") + '<span class="grow">Call 1-800-944-4773 (#1 Espa\u00f1ol, #2 English)</span>' + icon("chevron") + "</a>" +
      '<a class="link-row" href="sms:18009444773&body=HELP" style="text-decoration:none;color:inherit">' + icon("chat") + '<span class="grow">Text \u201cHelp\u201d to 800-944-4773 (English)</span>' + icon("chevron") + "</a>" +
      '<a class="link-row" href="sms:19712037773" style="text-decoration:none;color:inherit">' + icon("chat") + '<span class="grow">Texto en espa\u00f1ol: 971-203-7773</span>' + icon("chevron") + "</a></div></div>" +
      '<p class="footer-note">If you or your baby are in immediate danger, call 911.<br><br>Moms supporting moms \u2014 not a replacement for your doctor or therapist.</p>' +
      "</div>" };
  };

  V.me = function () {
    var p = store.profile;
    var authMethodLabel = (store.authMethod === "google" || store.verify.google) ? "Google" : "phone";
    var policy = [
      ["mutual", "Only moms I've said hi to", "Recommended · chat after a mutual hello"],
      ["verified", "Any verified mom", "Still women-only and verified"],
      ["none", "No one for now", "Pause all new messages"]
    ].map(function (o) {
      return '<button class="radio-row" role="radio" aria-checked="' + (store.msgPolicy === o[0]) + '" data-act="policy" data-v="' + o[0] + '"><span class="grow"><b>' + o[1] + "</b><span>" + o[2] + '</span></span><span class="radio"></span></button>';
    }).join("");
    var c = byId(D.cities, store.city);
    return { tab: "me", html:
      '<div class="view"><header class="topbar"><h1>Me</h1></header>' +
      '<div class="card profile-card">' + avatar(p.nickname, D.me.hue, "xl") +
      "<h2>" + esc(p.nickname) + '</h2><span class="verified">' + icon("shield") + "Verified mom · " + authMethodLabel + "</span>" +
      '<div class="chips">' + p.stages.map(function (s) { return '<span class="tag marigold">' + esc(s) + "</span>"; }).join("") + p.langs.map(function (s) { return '<span class="tag teal">' + esc(s) + "</span>"; }).join("") + "</div>" +
      '<div class="stats"><div><b>' + (2 + store.posts.length) + "</b><span>Questions</span></div><div><b>" + (7 + Object.keys(store.answers).reduce(function (n, k) { return n + store.answers[k].length; }, 0)) + "</b><span>Replies</span></div><div><b>" + (31 + Object.keys(store.reacted).length) + "</b><span>Hugs given</span></div></div></div>" +
      '<div class="settings-group"><h3>Privacy</h3><div class="card">' +
      '<div class="toggle-row"><div class="grow"><b>Post anonymously by default</b><span>Switch per post anytime</span></div>' + switchEl(p.anonDefault, "toggle-anon-default", "Post anonymously by default", ' id="set-anon"') + "</div>" +
      '<div class="toggle-row"><div class="grow"><b>Show me to moms near me</b><span>Neighbourhood only · never exact location</span></div>' + switchEl(store.nearbyOn, "nearby-toggle", "Show me to moms near me", ' id="set-nearby"') + "</div></div></div>" +
      '<div class="settings-group"><h3>Who can message me</h3><div class="card" role="radiogroup">' + policy + "</div></div>" +
      '<div class="settings-group"><h3>Safety</h3><div class="card">' +
      '<button class="link-row" data-act="blocked-list">' + icon("block") + '<span class="grow">Blocked moms</span><span class="tiny">' + store.blocked.length + "</span>" + icon("chevron") + "</button>" +
      '<button class="link-row" data-act="guidelines">' + icon("book") + '<span class="grow">Community guidelines</span>' + icon("chevron") + "</button>" +
      (canModerate() ? '<a class="link-row" href="#mod" id="open-mod" style="text-decoration:none;color:inherit">' + icon("flag") + '<span class="grow">Moderation' + (isRealMode() ? "" : " (demo)") + '</span><span class="tiny">' + modReports().length + " open</span>" + icon("chevron") + "</a>" : "") +
      '<a class="link-row" href="#safety" style="text-decoration:none;color:inherit">' + icon("shield") + '<span class="grow">Safety centre & crisis lines</span>' + icon("chevron") + "</a></div></div>" +
      '<div class="settings-group"><h3>Account</h3><div class="card">' +
      '<button class="link-row" data-act="go" data-to="#onboard/city">' + icon("pin") + '<span class="grow">City</span><span class="tiny">' + esc(c.name) + "</span>" + icon("chevron") + "</button>" +
      ((window.Backend && window.Backend.isReal) ? 
        (window.Backend.user ? '<div class="link-row uid-row"><span class="grow"><b>Your account ID</b><span class="tiny" id="my-uid">' + esc(window.Backend.user.uid) + '</span></span><button class="btn btn-ghost btn-sm" data-act="copy-uid" id="copy-uid">Copy</button></div>' : "") +
        '<button class="link-row" data-act="sign-out" id="sign-out">' + icon("reset") + '<span class="grow">Sign out</span>' + icon("chevron") + "</button></div></div>" :
        '<button class="link-row" data-act="reset" id="reset-demo">' + icon("reset") + '<span class="grow">Reset demo</span>' + icon("chevron") + "</button></div></div>") +
      '<p class="footer-note">' + esc(BRAND.name) + " prototype · v0.1 · all data is fictional</p></div>" };
  };

  // ----------------------------------------------------------- moderation
  // Real mode: shown only to moderators (a /moderators/{uid} doc made by hand in the
  // Firebase console). Hiding the screen is cosmetic -- firestore.rules isModerator()
  // is what actually allows reading/deleting reports and deleting others' posts.
  // Demo mode: everyone is a pretend moderator over reports kept in localStorage.
  function isRealMode() { return !!(window.Backend && window.Backend.isReal); }
  function canModerate() { return isRealMode() ? modState.isMod : true; }
  function modReports() { return isRealMode() ? modState.reports : (store.reports || []); }
  // undefined = still loading, null = gone. Reported posts outside the feed's latest
  // 100 are fetched once and cached for the session.
  function modPost(pid) {
    var p = post(pid);
    if (p) return p;
    if (!isRealMode()) return null;
    if (Object.prototype.hasOwnProperty.call(modState.postCache, pid)) return modState.postCache[pid];
    if (!modState.fetching[pid] && window.Backend.getPost) {
      modState.fetching[pid] = true;
      window.Backend.getPost(pid).then(function (d) {
        modState.postCache[pid] = d;
        if (parseHash().name === "mod") rerender();
      }).catch(function (e) { console.error("Aangan: couldn't load reported post", e); modState.postCache[pid] = null; });
    }
    return undefined;
  }
  V.mod = function () {
    var head = '<div class="view"><header class="topbar"><h1>Moderation</h1><button class="icon-btn" data-act="back" aria-label="Back">' + icon("back") + "</button></header>";
    if (!canModerate()) return { tab: "me", html: head + emptyState("🔒", "Moderators only", "This page is for Aangan moderators.") + "</div>" };
    var list = modReports().map(function (r) {
      var p = modPost(r.postId);
      var title = p ? (p.title || "(no title)") : (p === null ? "Post already removed or not found" : "Loading post…");
      var body = p && p.body ? String(p.body) : "";
      if (body.length > 160) body = body.slice(0, 160) + "…";
      return '<article class="card mod-item" id="mod-' + esc(r.id) + '">' +
        '<div class="mod-meta"><span class="tag marigold">' + esc(r.reason || "Reported") + '</span><span class="tiny">' + esc(formatTime(r.createdAt)) + "</span></div>" +
        '<h3 class="mod-title">' + esc(title) + "</h3>" + (body ? '<p class="muted mod-body">' + esc(body) + "</p>" : "") +
        '<div class="mod-actions">' +
        '<button class="btn btn-danger btn-sm" data-act="mod-remove" data-id="' + esc(r.id) + '" data-pid="' + esc(r.postId) + '">Remove post</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="mod-keep" data-id="' + esc(r.id) + '">Keep (dismiss report)</button>' +
        "</div></article>";
    }).join("");
    return { tab: "me", html: head +
      '<p class="muted" style="padding:0 18px 6px;font-size:14px">' + (isRealMode() ? "Reported posts, newest first. Removing deletes the post, its replies and its reports for everyone." : "Demo mode: reports you make on this device show up here.") + "</p>" +
      (list || emptyState("🌿", "No open reports", "All clear. Thank you for keeping Aangan kind.")) + "</div>" };
  };

  // --------------------------------------------------------------- router
  var TABS = [
    { id: "home", href: "#home", label: "Home", icon: "home" },
    { id: "nearby", href: "#nearby", label: "Nearby", icon: "pin" },
    { id: "ask", href: "#ask", label: "Ask", icon: "plus", fab: true },
    { id: "meetups", href: "#meetups", label: "Meetups", icon: "calendar" },
    { id: "me", href: "#me", label: "Me", icon: "user" }
  ];
  function parseHash() {
    var h = (location.hash || "").replace(/^#\/?/, "");
    if (!h) return { name: store.onboarded ? "home" : "welcome", arg: null };
    if (h.indexOf("onboard/") === 0) return { name: h, arg: null };
    var i = h.indexOf("/");
    return i < 0 ? { name: h, arg: null } : { name: h.slice(0, i), arg: decodeURIComponent(h.slice(i + 1)) };
  }
  var lastRoute = "";
  function render(keepScroll) {
    var r = parseHash();
    var view = V[r.name] || V.home;
    var out = view(r.arg);
    var screen = $("#screen");
    var y = screen.scrollTop;
    screen.innerHTML = out.html;
    var routeKey = r.name + "/" + (r.arg || "");
    if (keepScroll && routeKey === lastRoute) {
      screen.scrollTop = y;
      var v = screen.querySelector(".view"); if (v) v.style.animation = "none";
    } else screen.scrollTop = 0;
    lastRoute = routeKey;
    var tabbar = $("#tabbar");
    var dtLogo = $("#dt-logo");
    if (dtLogo) dtLogo.innerHTML = logoMark() + '<span class="logo-word" style="font-size:22px">' + esc(BRAND.name) + '</span>';
    var isPreAuth = out.tab === null || ["onboard/city", "onboard/about", "onboard/verify"].indexOf(r.name) >= 0 || r.name === "welcome";
    var app = $("#app");
    if (app) app.classList.toggle("onboarding-mode", isPreAuth);
    document.body.setAttribute("data-view", r.name);

    tabbar.hidden = isPreAuth && ["chats"].indexOf(r.name) < 0;
    var tabLinks = $("#tab-links") || tabbar;
    tabLinks.innerHTML = TABS.map(function (t) {
      var cur = out.tab === t.id ? ' aria-current="page"' : "";
      var ic = t.fab ? '<span class="ask-fab">' + icon(t.icon) + "</span>" : icon(t.icon);
      return '<a class="tab" href="' + t.href + '"' + cur + ' id="tab-' + t.id + '">' + ic + "<span>" + t.label + "</span></a>";
    }).join("");
    document.title = BRAND.name + " — " + BRAND.tagline;
    
    var rightRail = $("#right-rail");
    if (rightRail) {
      if (isPreAuth) {
        rightRail.hidden = true;
      } else {
        rightRail.hidden = false;
        rightRail.innerHTML = '<div class="rr-section"><h3>Your Circles</h3>' + 
          D.circles.slice(0, 3).map(function(c) { return '<a class="rr-link" href="#circle/' + c.id + '">' + c.emoji + ' ' + esc(c.name) + '</a>'; }).join('') + 
          '</div>' +
          '<div class="rr-section"><h3>Upcoming Meetups</h3>' + 
          D.events.slice(0, 2).map(function(e) { return '<a class="rr-link" href="#meetups">🗓️ ' + esc(e.title) + '</a>'; }).join('') + 
          '</div>' +
          '<div class="rr-section"><h3>Kindness Guidelines</h3><p class="tiny">Supportive reactions only — no downvotes, no shaming. A safe space for moms.</p></div>' +
          '<div class="rr-section"><a href="#safety" class="rr-link" style="color:var(--plum);font-weight:600">🤍 Need help now?</a></div>';
      }
    }

    if (out.after) out.after();
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  // ---------------------------------------------------------- sheet/toast
  var toastTimer;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  // Every real-mode Firebase call ends in .catch(failToast(...)): the mom sees what
  // failed (e.g. "Couldn't post yet (permission-denied)") and the console keeps the
  // full error for debugging. `btn` (optional) is re-enabled so she can retry.
  function errCode(e) { return String((e && (e.code || e.message)) || "error").replace(/^(firestore|auth)\//, ""); }
  function failToast(what, btn) {
    return function (e) {
      console.error("Aangan: couldn't " + what, e);
      if (btn) btn.disabled = false;
      toast("Couldn't " + what + " yet (" + errCode(e) + "). Please try again.");
    };
  }
  function busy(btn) { if (btn && btn.tagName === "BUTTON") btn.disabled = true; return btn; }
  function openSheet(html) {
    var s = $("#sheet"), b = $("#sheet-backdrop");
    s.innerHTML = html; s.hidden = false; b.hidden = false;
    var first = s.querySelector("button"); if (first) first.focus();
  }
  function closeSheet() { $("#sheet").hidden = true; $("#sheet-backdrop").hidden = true; }
  function reportSheet(opts) {
    var sheetEl = document.getElementById("sheet");
    if (sheetEl) { if (opts.postId) sheetEl.setAttribute("data-pid", opts.postId); else sheetEl.removeAttribute("data-pid"); }
    // opts: {title, subject, author, postId, momId}
    var items = '<button class="sheet-item" data-act="report-start" data-label="' + esc(opts.subject) + '">' + icon("flag") + "<span>Report " + esc(opts.subject) + "<small>Unkind, unsafe, spam or not from a mom</small></span></button>";
    if (opts.postId) items += '<button class="sheet-item" data-act="hide-post" data-id="' + opts.postId + '">' + icon("eyeoff") + "<span>Hide this post<small>You won't see it again</small></span></button>";
    if (opts.author || opts.momId) items += '<button class="sheet-item danger" data-act="block" data-who="' + esc(opts.momId || opts.author) + '" data-name="' + esc(opts.name || opts.author) + '">' + icon("block") + "<span>Block " + esc(opts.name || opts.author) + "<small>They won't see you or be able to message you</small></span></button>";
    items += '<button class="sheet-item" data-act="sheet-close">' + icon("close") + "<span>Cancel</span></button>";
    openSheet("<h3>" + esc(opts.title) + '</h3><p class="muted">Reports are anonymous. Our moderators review every one within 24 hours.</p><div class="sheet-list">' + items + "</div>");
  }

  // ------------------------------------------------------------- auth (demo)
  /* signInWithGoogle: Demo stub simulating Google OAuth account selection.
   *
   * In production with Firebase Auth, replace this demo stub with:
   *   import { getAuth, signInWithPopup, GoogleAuthProvider } from "firebase/auth";
   *   const auth = getAuth();
   *   const provider = new GoogleAuthProvider();
   *   provider.addScope("profile");
   *   provider.addScope("email");
   *   try {
   *     const result = await signInWithPopup(auth, provider);
   *     const user = result.user; // user.displayName, user.email, user.photoURL
   *     // Sync user profile to Firestore / store
   *   } catch (error) {
   *     console.error("Google sign-in failed:", error);
   *   }
   *
   * Requirements for production:
   *   1. A configured Firebase project with Google sign-in provider enabled in Firebase Console.
   *   2. OAuth 2.0 Web Client ID registered in Google Cloud Console with authorized redirect URIs.
   *   3. Firebase SDK scripts / bundle (firebase/app, firebase/auth) initialized with project config.
   * No API keys or external Firebase scripts are loaded in this static prototype.
   */
  // Shared by the popup path and the redirect path (getRedirectResult on load).
  function afterGoogleSignIn(u) {
    store.authMethod = "google";
    store.verify.google = true;
    var firstName = u.displayName ? (u.displayName.split(" ")[0] || u.displayName) : "Mom";
    store.profile.nickname = firstName;
    store.profile.fullName = u.displayName || "";
    store.profile.email = u.email || "";
    save();
    return window.Backend.getProfile(u.uid).then(function(p) {
      if (p) {
        store.profile = Object.assign(store.profile, p);
        store.onboarded = true;
        save();
        go("#home");
      } else {
        toast("Signed in ✓");
        go("#onboard/city");
      }
    }).catch(function (e) {
      failToast("load your profile", null)(e);
      go("#onboard/city");
    });
  }
  function signInWithGoogle(account, btn) {
    if (window.Backend && window.Backend.isReal) {
      busy(btn);
      // Backend falls back to signInWithRedirect for popup-blocked & co; in that
      // case the page navigates away and the result lands via getRedirectResult.
      window.Backend.signInWithGoogle().then(function(result) {
         if (btn) btn.disabled = false;
         if (!result || result.redirecting || !result.user) return;
         return afterGoogleSignIn(result.user);
      }).catch(function(e) {
         if (btn) btn.disabled = false;
         if (e && e.code === "auth/popup-closed-by-user") { toast("Sign-in cancelled"); return; }
         failToast("sign you in", btn)(e);
      });
      return;
    }
    if (!account) {
      openGoogleChooser();
      return;
    }
    store.authMethod = "google";
    store.verify.google = true;
    var firstName = account.name ? (account.name.split(" ")[0] || account.name) : "Priya";
    store.profile.nickname = firstName;
    store.profile.fullName = account.name || "Priya Sharma";
    store.profile.email = account.email || "priya.sharma@gmail.com";
    save();
    toast("Signed in as " + store.profile.fullName + " ✓");
    go("#onboard/city");
  }

  function openGoogleChooser() {
    var accounts = [
      { name: "Priya Sharma", email: "priya.sharma@gmail.com", initial: "P", color: "#6366F1" },
      { name: "Ananya Iyer", email: "ananya.iyer@gmail.com", initial: "A", color: "#0D9488" }
    ];
    var accHtml = accounts.map(function (a) {
      return '<button class="sheet-item gc-account-item" data-act="pick-google-account" data-name="' + esc(a.name) + '" data-email="' + esc(a.email) + '">' +
        '<span class="avatar sm" style="background:' + a.color + ';color:#fff">' + a.initial + '</span>' +
        '<span class="grow"><b>' + esc(a.name) + '</b><small>' + esc(a.email) + '</small></span></button>';
    }).join("");
    accHtml += '<button class="sheet-item gc-account-item" data-act="pick-google-another">' +
      '<span class="avatar sm" style="background:#F1F5F9;color:#475569">' + icon("user") + '</span>' +
      '<span class="grow"><b>Use another account</b></span></button>';

    var html = '<div class="google-chooser">' +
      '<div class="gc-header">' + googleIcon(28) +
      '<h3>Choose an account</h3><p class="muted">to continue to ' + esc(BRAND.name) + '</p></div>' +
      '<div class="sheet-list gc-accounts">' + accHtml + '</div>' +
      '<p class="tiny muted gc-disclaimer">To continue, Google will share your name, email address, and language preference with ' + esc(BRAND.name) + '.</p>' +
      '<button class="btn btn-ghost btn-block btn-sm" data-act="sheet-close" style="margin-top:10px">Cancel</button>' +
      '</div>';
    openSheet(html);
  }
  window.signInWithGoogle = signInWithGoogle;

  // --------------------------------------------------------------- events
  function rerender() { render(true); }
  function onClick(e) {
    var hrefEl = e.target.closest("[data-href]");
    var el = e.target.closest("[data-act]");
    if (!el && hrefEl && !e.target.closest("a,button")) { go(hrefEl.getAttribute("data-href")); return; }
    if (!el) return;
    var act = el.getAttribute("data-act"), id = el.getAttribute("data-id");
    switch (act) {
      case "go": go(el.getAttribute("data-to")); break;
      case "back": if (history.length > 1) history.back(); else go("#home"); break;
      case "google-signin": signInWithGoogle(undefined, el); break;
      case "pick-google-account": {
        var gName = el.getAttribute("data-name");
        var gEmail = el.getAttribute("data-email");
        closeSheet();
        signInWithGoogle({ name: gName, email: gEmail });
        break;
      }
      case "pick-google-another": {
        closeSheet();
        var entered = prompt("Enter Google account email:", "sweta.demo@gmail.com");
        if (entered && entered.trim()) {
          var cleanEmail = entered.trim();
          var rawName = cleanEmail.split("@")[0].replace(/[._-]/g, " ").replace(/\b\w/g, function (l) { return l.toUpperCase(); });
          signInWithGoogle({ name: rawName, email: cleanEmail });
        }
        break;
      }
      case "start-phone-onboard":
        store.authMethod = "phone"; save(); go("#onboard/city"); break;
      case "skip-onboarding": store.onboarded = true; save(); go("#home"); break;
      case "city": store.city = id; save(); rerender(); break;
      case "waitlist": {
        var c = byId(D.cities, id);
        if (store.waitlist.indexOf(id) < 0) store.waitlist.push(id);
        save(); rerender(); toast("We'll tell you when " + c.name + " opens 💛"); break;
      }
      case "toggle-stage": case "toggle-lang": {
        var arr = act === "toggle-stage" ? store.profile.stages : store.profile.langs, v = el.getAttribute("data-v");
        var i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v);
        save(); el.setAttribute("aria-pressed", i < 0); break;
      }
      case "toggle-anon-default":
        store.profile.anonDefault = !store.profile.anonDefault; askDraft.anon = null; save();
        el.setAttribute("aria-checked", store.profile.anonDefault); break;
      case "verify-phone":
        store.authMethod = "phone";
        el.textContent = "Sending…"; el.disabled = true;
        setTimeout(function () { store.verify.phone = true; save(); rerender(); toast("Code 482 913 auto-filled (demo) ✓"); }, 700); break;
      case "finish-onboarding":
        store.onboarded = true; save();
        if (window.Backend && window.Backend.isReal && window.Backend.user) {
           busy(el);
           window.Backend.saveProfile(window.Backend.user.uid, store.profile).then(function () {
             go("#home"); toast("Welcome to the circle, " + store.profile.nickname + " 💛");
           }).catch(failToast("save your profile", el));
           break;
        }
        go("#home"); toast("Welcome to the circle, " + store.profile.nickname + " 💛"); break;
      case "react": {
        var key = el.getAttribute("data-key") + ":" + el.getAttribute("data-r");
        if (store.reacted[key]) delete store.reacted[key]; else store.reacted[key] = true;
        save();
        var on = !!store.reacted[key];
        el.setAttribute("aria-pressed", on);
        var label = el.textContent.replace(/ · \d+$/, "").replace(/^\S+/, "").trim();
        var m = el.textContent.match(/ · (\d+)$/); var n = (m ? +m[1] : 0) + (on ? 1 : -1);
        el.innerHTML = el.querySelector(".e").outerHTML + label + (n > 0 ? " · " + n : "");
        if (on) { el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }
        break;
      }
      case "join": store.joined[id] = store.joined[id] === false; save(); rerender(); toast(store.joined[id] === false ? "Left circle" : "Joined 💛"); break;
      case "ask-circle": askDraft.circle = (askDraft.circle === id ? null : id); askDraft.nudge = null; rerender(); break;
      case "ask-anon": askDraft.anon = !askDraft.anon; rerender(); break;
      case "ask-demo":
        if (!askDraft.circle) askDraft.circle = "toddlers";
        askDraft.title = askDraft.title || "Screen time for toddlers — what's normal?";
        askDraft.body = D.kindness.demoAsk; askDraft.nudge = kindnessScan(askDraft.body); rerender();
        setTimeout(function () { var n = $("#ask-nudge"); if (n) n.scrollIntoView({ behavior: "smooth", block: "center" }); }, 50); break;
      case "ask-post": {
        if (!askDraft.title || askDraft.title.trim().length <= 4) break;
        var textToScan = askDraft.title + " " + askDraft.body;
        if (worryingScan(textToScan) && !askDraft.skipWorry) {
           showSafetySheet("ask-post-worry-skip");
           break;
        }
        var hits = kindnessScan(textToScan);
        if (hits.length && !askDraft.skipKind) { askDraft.nudge = hits; rerender(); setTimeout(function () { var n = $("#ask-nudge"); if (n) n.scrollIntoView({ behavior: "smooth", block: "center" }); }, 50); break; }
        var isAnon = !!askDraft.anon;
        var authorName = isAnon ? null : store.profile.nickname;
        var stages = store.profile.stages || [];
        var meta = stages.length ? "Mom · " + stages.join(", ") : "Mom";
        var cId = askDraft.circle || null;
        var cObj = cId ? circle(cId) : null;
        var cn = cObj ? cObj.name : "the circle";
        
        if (window.Backend && window.Backend.isReal) {
          if (!window.Backend.user) { toast("Please sign in to post"); go("#welcome"); break; }
          if (askDraft.saving) break;
          askDraft.saving = true; busy(el);
          window.Backend.addPost(window.Backend.user.uid, authorName, isAnon, cId, askDraft.title.trim(), askDraft.body.trim(), meta, D.me.hue).then(function(docRef) {
            askDraft = { circle: null, title: "", body: "", anon: null, nudge: null };
            go("#q/" + docRef.id); toast("Posted to " + cn + " 💛");
          }).catch(function (e) { askDraft.saving = false; failToast("post", el)(e); });
          break;
        }

        var p = { id: "u" + Date.now(), circle: cId, anon: isAnon, author: authorName, hue: D.me.hue,
          meta: meta, time: "now", title: askDraft.title.trim(), body: askDraft.body.trim(),
          reactions: { hug: 0, been: 0, helpful: 0 }, answers: [] };
        store.posts.unshift(p); save();
        askDraft = { circle: null, title: "", body: "", anon: null, nudge: null };
        go("#q/" + p.id); toast("Posted to " + cn + " 💛"); break;
      }
      case "kind-use": {
        var scope = el.getAttribute("data-scope");
        if (scope === "ask") { askDraft.title = softenText(askDraft.title, kindnessScan(askDraft.title)); askDraft.body = softenText(askDraft.body, askDraft.nudge); askDraft.nudge = null; }
        else { replyDraft.text = softenText(replyDraft.text, replyDraft.nudge); replyDraft.nudge = null; }
        rerender(); toast("Thank you for keeping it kind 💛"); break;
      }
      case "kind-edit": {
        var sc = el.getAttribute("data-scope");
        if (sc === "ask") { askDraft.nudge = null; rerender(); $("#ask-body").focus(); } else { replyDraft.nudge = null; rerender(); $("#reply-text").focus(); }
        break;
      }
      case "kind-skip": {
        var s2 = el.getAttribute("data-scope");
        if (s2 === "ask") { askDraft.skipKind = true; askDraft.nudge = null; onClick({ target: $("#ask-post") }); askDraft.skipKind = false; }
        else { replyDraft.skipKind = true; replyDraft.nudge = null; onClick({ target: $("#reply-send") }); replyDraft.skipKind = false; }
        break;
      }
      case "reply-anon": replyDraft.anon = !replyDraft.anon; rerender(); break;
      case "reply-demo": replyDraft.text = D.kindness.demo; replyDraft.nudge = kindnessScan(replyDraft.text); rerender();
        setTimeout(function () { var s = $("#screen"); s.scrollTop = s.scrollHeight; }, 30); break;
      case "reply-send": {
        var txt = replyDraft.text.trim();
        if (!txt) { $("#reply-text").focus(); break; }
        if (worryingScan(txt) && !replyDraft.skipWorry) {
           showSafetySheet("reply-send-worry-skip");
           break;
        }
        var rh = kindnessScan(txt);
        if (rh.length && !replyDraft.skipKind) { replyDraft.nudge = rh; rerender(); setTimeout(function () { var s = $("#screen"); s.scrollTop = s.scrollHeight; }, 30); break; }
        var pid = replyDraft.pid;
        if (window.Backend && window.Backend.isReal) {
          // Real mode previously wrote replies to localStorage only, so nobody else
          // ever saw them. Now they go to Firestore and the listener re-renders.
          if (!window.Backend.user) { toast("Please sign in to reply"); go("#welcome"); break; }
          if (replyDraft.saving) break;
          replyDraft.saving = true; busy(el);
          var rAnon = !!replyDraft.anon;
          window.Backend.addReply(pid, window.Backend.user.uid, rAnon ? null : store.profile.nickname, rAnon, txt, D.me.hue).then(function () {
            replyDraft.saving = false; replyDraft.text = ""; replyDraft.nudge = null; rerender();
            setTimeout(function () { var s = $("#screen"); s.scrollTop = s.scrollHeight; }, 30);
            toast("Reply posted 💛");
          }).catch(function (e) { replyDraft.saving = false; failToast("post your reply", el)(e); });
          break;
        }
        (store.answers[pid] = store.answers[pid] || []).push({ id: "ua" + Date.now(), anon: replyDraft.anon, author: replyDraft.anon ? null : store.profile.nickname, hue: D.me.hue, time: "now", body: txt, reactions: {} });
        save(); replyDraft.text = ""; replyDraft.nudge = null; rerender();
        setTimeout(function () { var s = $("#screen"); s.scrollTop = s.scrollHeight; }, 30);
        toast("Reply posted 💛"); break;
      }
      case "post-menu": {
        var pp = post(id);
        reportSheet({ title: "Report or block", subject: "this post", postId: id, author: pp.anon ? null : pp.author, name: pp.anon ? null : pp.author });
        break;
      }
      case "answer-menu": {
        var au = el.getAttribute("data-author");
        reportSheet({ title: "Report or block", subject: "this reply", author: au || null }); break;
      }
      case "mom-menu": { var mm = mom(id); reportSheet({ title: mm.nickname, subject: "this profile", momId: id, name: mm.nickname }); break; }
      case "chat-menu": { var cm = mom(id); reportSheet({ title: "Chat with " + cm.nickname, subject: "this conversation", momId: id, name: cm.nickname }); break; }
      case "ask-post-worry-skip":
        askDraft.skipWorry = true;
        closeSheet();
        onClick({ target: $("#ask-post") });
        askDraft.skipWorry = false;
        break;
      case "reply-send-worry-skip":
        replyDraft.skipWorry = true;
        closeSheet();
        onClick({ target: $("#reply-send") });
        replyDraft.skipWorry = false;
        break;
      case "sheet-close-then-safety":
        closeSheet();
        go("#safety");
        break;
      case "sheet-close": closeSheet(); break;
      case "report-start": {
        var lbl = el.getAttribute("data-label");
        var reasons = ["Unkind or shaming", "Harassment or bullying", "Unsafe advice", "Spam or selling", "Not a mom / fake profile", "Something else"];
        openSheet("<h3>Why are you reporting " + esc(lbl) + '?</h3><p class="muted">They won\'t know it was you.</p><div class="sheet-list">' +
          reasons.map(function (r) { return '<button class="sheet-item" data-act="report-done">' + icon("flag") + "<span>" + r + "</span></button>"; }).join("") + "</div>");
        break;
      }
      case "report-done":
        if (window.Backend && window.Backend.isReal && window.Backend.user) {
           var reason = (el.textContent || "reported").trim();
           busy(el);
           window.Backend.addReport(document.getElementById("sheet").getAttribute("data-pid") || "unknown", reason, window.Backend.user.uid).then(function () {
             closeSheet(); toast("Thanks — a moderator will review within 24h");
           }).catch(failToast("send your report", el));
           break;
        }
        // Demo mode: keep the report on this device so Moderation (demo) can show it.
        store.reports = store.reports || [];
        store.reports.unshift({ id: "r" + Date.now(), postId: document.getElementById("sheet").getAttribute("data-pid") || "unknown",
          reason: (el.textContent || "reported").trim(), createdAt: Date.now() });
        save(); closeSheet(); toast("Thanks — a moderator will review within 24h"); break;
      case "mod-remove": {
        var rpid = el.getAttribute("data-pid");
        if (!window.confirm("Remove this post for everyone? Its replies and reports will be deleted too.")) break;
        if (isRealMode()) {
          busy(el);
          window.Backend.removePost(rpid).then(function () { toast("Post removed"); })
            .catch(failToast("remove the post", el));
          break;
        }
        store.posts = store.posts.filter(function (p) { return p.id !== rpid; });
        if (store.hidden.indexOf(rpid) < 0) store.hidden.push(rpid); // built-in demo posts can only be hidden
        store.reports = (store.reports || []).filter(function (r) { return r.postId !== rpid; });
        save(); rerender(); toast("Post removed"); break;
      }
      case "mod-keep": {
        if (!window.confirm("Keep this post and dismiss the report?")) break;
        if (isRealMode()) {
          busy(el);
          window.Backend.deleteReport(id).then(function () { toast("Report dismissed — post kept"); })
            .catch(failToast("dismiss the report", el));
          break;
        }
        store.reports = (store.reports || []).filter(function (r) { return r.id !== id; });
        save(); rerender(); toast("Report dismissed — post kept"); break;
      }
      case "copy-uid": {
        var myUid = (window.Backend && window.Backend.user) ? window.Backend.user.uid : "";
        if (!myUid) break;
        var askCopy = function () { window.prompt("Copy your account ID:", myUid); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(myUid).then(function () { toast("Account ID copied"); }).catch(askCopy);
        } else askCopy();
        break;
      }
      case "sign-out":
        if (window.Backend && window.Backend.isReal) {
           window.Backend.signOut().then(function() {
             localStorage.removeItem(STORE_KEY); store = freshStore();
             go("#welcome"); toast("Signed out");
           }).catch(failToast("sign you out", null));
        }
        break;
      case "hide-post": store.hidden.push(id); save(); closeSheet(); go("#home"); toast("Post hidden"); break;
      case "block": {
        var who = el.getAttribute("data-who"), nm = el.getAttribute("data-name");
        if (store.blocked.indexOf(who) < 0) store.blocked.push(who);
        save(); closeSheet(); rerender(); toast(nm + " is blocked"); break;
      }
      case "blocked-list": {
        var bl = store.blocked.map(function (b) { var bm = mom(b); var n2 = bm ? bm.nickname : b;
          return '<button class="sheet-item" data-act="unblock" data-who="' + esc(b) + '">' + avatar(n2, bm ? bm.hue : "plum", "sm") + "<span>" + esc(n2) + "<small>Tap to unblock</small></span></button>"; }).join("");
        openSheet('<h3>Blocked moms</h3><p class="muted">Blocked moms can\'t see you, message you, or reply to you.</p><div class="sheet-list">' + (bl || '<p class="tiny" style="padding:10px 4px">No one blocked. 🌿</p>') + '<button class="sheet-item" data-act="sheet-close">' + icon("close") + "<span>Close</span></button></div>");
        break;
      }
      case "unblock": store.blocked.splice(store.blocked.indexOf(el.getAttribute("data-who")), 1); save(); closeSheet(); rerender(); toast("Unblocked"); break;
      case "guidelines":
        openSheet('<h3>Our promise to each other</h3><div class="sheet-list" style="gap:10px;font-size:14px">' +
          ["💛 Assume every mom is doing her best.", "🙅🏽‍♀️ No shaming — feeding, sleep, work, culture or choices.", "🔒 What's shared here stays here.", "🩺 Advice isn't a diagnosis. Experts are badged.", "🚩 Report anything that feels off. We act within 24h."].map(function (g) { return '<div class="card" style="padding:12px 14px">' + g + "</div>"; }).join("") +
          '<button class="btn btn-primary btn-block" data-act="sheet-close" style="margin-top:6px">I promise</button></div>');
        break;
      case "nearby-on": store.nearbyOn = true; save(); render(); toast("You're visible at neighbourhood level only"); break;
      case "nearby-toggle": store.nearbyOn = !store.nearbyOn; save(); el.setAttribute("aria-checked", store.nearbyOn); toast(store.nearbyOn ? "Visible to nearby moms (neighbourhood only)" : "You're hidden from Nearby"); break;
      case "hood": nearbyFilter = nearbyFilter === id ? null : id; rerender(); break;
      case "hood-clear": nearbyFilter = null; rerender(); break;
      case "say-hi": {
        var sm = mom(id);
        store.req[id] = "pending"; save(); rerender(); toast("Hi sent to " + sm.nickname + " 👋");
        // Mock the other mom accepting a moment later so the unlock is demoable.
        setTimeout(function () {
          store.req[id] = "accepted"; save();
          if (parseHash().name === "nearby") rerender();
          toast(sm.nickname + " said hi back — chat unlocked 🎉");
        }, 2600);
        break;
      }
      case "rsvp": store.rsvp[id] = !store.rsvp[id]; save(); rerender(); toast(store.rsvp[id] ? "You're going! We'll remind you the day before 🌼" : "RSVP removed"); break;
      case "seg": meetupsSeg = el.getAttribute("data-v"); rerender(); break;
      case "policy": store.msgPolicy = el.getAttribute("data-v"); save(); rerender(); break;
      case "chat-send": {
        var ta = $("#chat-text"), t = ta.value.trim();
        if (!t) { ta.focus(); break; }
        var now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        store.chats[id].push({ from: "me", text: t, time: now }); save(); render(true);
        var msgsEl = $("#msgs");
        msgsEl.insertAdjacentHTML("beforeend", '<div class="typing" id="typing"><i></i><i></i><i></i></div>');
        $("#screen").scrollTop = $("#screen").scrollHeight;
        setTimeout(function () {
          store.chats[id].push({ from: "them", text: MOCK_REPLIES[store.chats[id].length % MOCK_REPLIES.length], time: now }); save();
          if (parseHash().name === "chat") render(true);
          var s = $("#screen"); s.scrollTop = s.scrollHeight;
        }, 1400);
        break;
      }
      case "soon": toast("Coming soon in the real app ✨"); break;
      case "reset": localStorage.removeItem(STORE_KEY); store = freshStore(); askDraft = { circle: null, title: "", body: "", anon: null, nudge: null }; go("#welcome"); toast("Demo reset"); break;
    }
  }
  function onInput(e) {
    var k = e.target.getAttribute("data-input");
    if (!k) return;
    var v = e.target.value;
    if (k === "nick") {
      store.profile.nickname = v.trim() ? v.trim() : ""; save();
      var b = $("#about-continue"); if (b) b.disabled = !v.trim();
    } else if (k === "ask-title" || k === "ask-body") {
      askDraft[k === "ask-title" ? "title" : "body"] = v;
      var canPost = askDraft.title.trim().length > 4;
      var bt = $("#ask-post"); if (bt) bt.disabled = !canPost;
      var hint = $("#ask-hint"); if (hint) hint.style.display = canPost ? "none" : "";
    } else if (k === "reply-text") {
      replyDraft.text = v;
      e.target.style.height = "auto"; e.target.style.height = Math.min(120, e.target.scrollHeight) + "px";
    }
  }
  function onKey(e) {
    if (e.key === "Escape") closeSheet();
    if (e.key === "Enter" && !e.shiftKey && e.target.id === "chat-text") { e.preventDefault(); $("#chat-send").click(); }
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("g.hood")) { e.preventDefault(); onClick({ target: e.target }); }
  }

  function showcase() {
    var links = [["#welcome", "Welcome"], ["#onboard/city", "City picker"], ["#onboard/about", "About you"], ["#onboard/verify", "Verification"], ["#home", "Home feed"],
      ["#ask", "Ask"], ["#q/p1", "Question + expert"], ["#nearby", "Nearby moms"], ["#meetups", "Meetups"], ["#chat/m1", "Chat"], ["#me", "Profile & privacy"]];
    var sc = $("#showcase");
    if (sc) sc.innerHTML = '<div class="sc-logo">' + logoMark() + '<span class="logo-word">' + esc(BRAND.name) + "</span></div>" +
      "<h2>" + esc(BRAND.tagline) + "</h2><p>" + esc(BRAND.blurb) + " Launching first in Mountain View &amp; Sunnyvale.</p>" +
      '<div class="sc-links">' + links.map(function (l) { return '<a href="' + l[0] + '">' + l[1] + "</a>"; }).join("") + "</div>" +
      "<small>Clickable prototype · mock data only · all people are fictional</small>";
  }

  // "Demo mode" badge. Shown ONLY once Backend.ready has resolved with isReal
  // false: Backend.isReal is false while the Firebase SDK is still loading, so
  // checking it at DOMContentLoaded labelled real mode as demo.
  function showDemoLabel() {
    if (document.getElementById("demo-label")) return;
    var d = document.createElement("div");
    d.id = "demo-label";
    d.innerHTML = "Demo mode";
    d.style = "position:fixed;bottom:env(safe-area-inset-bottom, 5px);right:5px;font-size:10px;background:rgba(0,0,0,0.5);color:#fff;padding:2px 6px;border-radius:4px;z-index:9999;pointer-events:none;";
    document.body.appendChild(d);
  }

  // Firestore listeners. Rules require sign-in to read, and an onSnapshot error
  // kills the listener permanently, so we (re)subscribe on every sign-in and tear
  // down on sign-out instead of subscribing once at load.
  function syncReplies() {
    var B = window.Backend;
    if (!B || !B.isReal) return;
    var r = parseHash();
    if (B._unsubReplies) { B._unsubReplies(); B._unsubReplies = null; }
    B._currentReplies = [];
    if (r.name !== "q" || !r.arg || !B.user) return;
    B._unsubReplies = B.listenReplies(r.arg, function(reps) {
      B._currentReplies = reps;
      if (parseHash().name === "q" && parseHash().arg === r.arg) rerender();
    }, failToast("load replies", null));
  }
  // Re-evaluated on every auth change: drop the old listener/flag first so a
  // signed-out or different user never sees the previous moderator's queue.
  // A failed check (e.g. rules not yet published) just means "not a moderator".
  function syncModerator(u) {
    var B = window.Backend;
    if (modState.unsub) { modState.unsub(); modState.unsub = null; }
    modState.isMod = false; modState.reports = []; modState.postCache = {}; modState.fetching = {};
    if (!u || !B || !B.checkModerator) return;
    B.checkModerator(u.uid).then(function (isMod) {
      if (!isMod || !B.user || B.user.uid !== u.uid) return;
      modState.isMod = true;
      modState.unsub = B.listenReports(function (reps) {
        modState.reports = reps;
        var n = parseHash().name; if (n === "mod" || n === "me") rerender();
      }, failToast("load reports", null));
      var n2 = parseHash().name; if (n2 === "mod" || n2 === "me") rerender();
    }).catch(function (e) { console.warn("Aangan: moderator check failed (treated as not a moderator)", e); });
  }
  function syncPosts() {
    var B = window.Backend;
    if (B._unsubPosts) { B._unsubPosts(); B._unsubPosts = null; }
    if (!B.user) { B.posts = []; return; }
    B._unsubPosts = B.listenPosts("all", function(posts) {
      var r = parseHash();
      var had = r.name === "q" && (B.posts || []).some(function (p) { return p.id === r.arg; });
      B.posts = posts;
      // On #q only re-render when the post first shows up (direct link / just
      // posted); otherwise a feed update would wipe focus while she types a reply.
      if (r.name === "home" || r.name === "circle" || (r.name === "q" && !had)) rerender();
    }, failToast("load posts", null));
  }

  document.addEventListener("DOMContentLoaded", function () {
    var app = $("#app");
    app.addEventListener("click", onClick);
    app.addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);
    $("#sheet-backdrop").addEventListener("click", closeSheet);
    window.addEventListener("hashchange", function () { 
      closeSheet(); 
      syncReplies();
      render(); 
    });
    showcase();
    if (window.Backend && window.Backend.ready) {
      window.Backend.ready.then(function() {
        if (window.Backend.isReal) {
          // Coming back from a signInWithRedirect fallback: finish sign-in here.
          window.Backend.getRedirectResult().then(function (result) {
            if (result && result.user) return afterGoogleSignIn(result.user);
          }).catch(function (e) {
            failToast("sign you in", null)(e);
          });
          window.Backend.onAuth(function(u) {
            window.Backend.user = u;
            syncPosts();
            syncReplies();
            syncModerator(u);
            if (u) {
               window.Backend.getProfile(u.uid).then(function(p) {
                 if (p) { store.profile = Object.assign(store.profile || {}, p); store.onboarded = true; }
                 render();
               }).catch(function (e) {
                 failToast("load your profile", null)(e);
                 render();
               });
            } else {
               render();
            }
          });
        } else {
          showDemoLabel();
          render();
        }
      });
    } else {
      showDemoLabel();
      render();
    }
  });

  // Exposed for tests/screenshot tooling only.
  window.AANGAN = { kindnessScan: kindnessScan, softenText: softenText, reset: function () { localStorage.removeItem(STORE_KEY); },
    syncModerator: syncModerator };
})();
