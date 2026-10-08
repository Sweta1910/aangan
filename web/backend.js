// web/backend.js
// Thin wrapper over Firebase (Auth + Firestore). When window.FIREBASE_CONFIG is
// filled in, Backend.ready resolves with isReal = true and every hook below talks
// to Firestore; otherwise (or if the SDK fails to load) the app stays in demo mode.
//
// Design notes (2026-10-08 hardening):
// - Every write returns the raw Firebase promise so app.js can .catch it and show
//   the mom a toast; nothing here swallows errors silently.
// - Firestore addDoc/setDoc REJECT documents containing `undefined`, so every
//   field is coerced to a safe default before writing (anon is always a boolean).
// - Popup sign-in is blocked on many mobile browsers / in-app webviews, so a few
//   specific popup failures fall back to signInWithRedirect; app.js picks the
//   result up on the next load via Backend.getRedirectResult().
// - replyCount is bumped with increment(1) AFTER the reply is written. It is a
//   best-effort counter: a failed bump never fails the reply itself.
// - Snapshot listeners take an error callback; an onSnapshot error ends the
//   listener for good, so app.js only starts listening once a user is signed in
//   (rules require auth for reads) and re-subscribes after the next sign-in.
(function() {
  window.Backend = {
    isReal: false,
    ready: null,
    user: null,
    // hooks
    signInWithGoogle: null,
    getRedirectResult: null,
    signOut: null,
    onAuth: null,
    getProfile: null,
    saveProfile: null,
    addPost: null,
    addReply: null,
    addReport: null,
    listenPosts: null,
    listenReplies: null
  };

  // Popup failures that mean "this browser can't do popups", not "the mom said no".
  var REDIRECT_FALLBACK_CODES = [
    "auth/popup-blocked",
    "auth/operation-not-supported-in-this-environment",
    "auth/cancelled-popup-request"
  ];

  function str(v, fallback) { return (typeof v === "string") ? v : (v == null ? fallback : String(v)); }
  // JSON round-trip drops undefined values (Firestore rejects them) and functions.
  function plain(obj) { return JSON.parse(JSON.stringify(obj || {})); }

  if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && window.FIREBASE_CONFIG.apiKey.indexOf("PASTE") === -1) {
    Backend.ready = Promise.all([
      import("https://www.gstatic.com/firebasejs/10.4.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.4.0/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.4.0/firebase-firestore.js")
    ]).then(function(modules) {
      var app = modules[0].initializeApp(window.FIREBASE_CONFIG);
      var auth = modules[1].getAuth(app);
      var db = modules[2].getFirestore(app);

      Backend.isReal = true;
      Backend._auth = auth;
      Backend._db = db;

      var signInWithPopup = modules[1].signInWithPopup;
      var signInWithRedirect = modules[1].signInWithRedirect;
      var fbGetRedirectResult = modules[1].getRedirectResult;
      var GoogleAuthProvider = modules[1].GoogleAuthProvider;
      var fbSignOut = modules[1].signOut;
      var onAuthStateChanged = modules[1].onAuthStateChanged;
      var doc = modules[2].doc, getDoc = modules[2].getDoc, setDoc = modules[2].setDoc,
          updateDoc = modules[2].updateDoc, increment = modules[2].increment,
          collection = modules[2].collection, addDoc = modules[2].addDoc,
          serverTimestamp = modules[2].serverTimestamp, query = modules[2].query,
          orderBy = modules[2].orderBy, onSnapshot = modules[2].onSnapshot, limit = modules[2].limit;

      // Resolves with the UserCredential (popup) or {redirecting: true} (page is
      // about to navigate away to Google). Rejects for every other failure.
      Backend.signInWithGoogle = function() {
        var provider = new GoogleAuthProvider();
        return signInWithPopup(auth, provider).catch(function(e) {
          if (e && REDIRECT_FALLBACK_CODES.indexOf(e.code) >= 0) {
            console.warn("Popup sign-in unavailable (" + e.code + "); falling back to redirect");
            return signInWithRedirect(auth, provider).then(function() { return { redirecting: true }; });
          }
          throw e;
        });
      };

      // Null when the page wasn't opened by a sign-in redirect.
      Backend.getRedirectResult = function() {
        return fbGetRedirectResult(auth);
      };

      Backend.signOut = function() {
        return fbSignOut(auth);
      };

      Backend.onAuth = function(cb) {
        return onAuthStateChanged(auth, cb);
      };

      Backend.getProfile = function(uid) {
        return getDoc(doc(db, "profiles", uid)).then(function(snap) {
          return snap.exists() ? snap.data() : null;
        });
      };

      Backend.saveProfile = function(uid, profile) {
        return setDoc(doc(db, "profiles", uid), plain(profile), { merge: true });
      };

      Backend.addPost = function(uid, authorName, isAnon, circle, title, body, meta, hue) {
        var anon = !!isAnon;
        return addDoc(collection(db, "posts"), {
          uid: uid,
          author: anon ? null : str(authorName, "Mom"),
          anon: anon,
          circle: (circle && typeof circle === "string" && circle.trim()) ? circle.trim() : null,
          title: str(title, ""),
          body: str(body, ""),
          meta: str(meta, "Mom"),
          hue: str(hue, "teal"),
          createdAt: serverTimestamp(),
          replyCount: 0
        });
      };

      Backend.addReply = function(postId, uid, authorName, isAnon, body, hue) {
        var anon = !!isAnon;
        return addDoc(collection(db, "posts/" + postId + "/replies"), {
          uid: uid,
          author: anon ? null : str(authorName, "Mom"),
          anon: anon,
          body: str(body, ""),
          hue: str(hue, "teal"),
          createdAt: serverTimestamp()
        }).then(function(ref) {
          // Best-effort counter for the feed; rules only allow +1 on replyCount.
          updateDoc(doc(db, "posts", postId), { replyCount: increment(1) }).catch(function(e) {
            console.warn("replyCount bump failed (reply itself was saved)", e);
          });
          return ref;
        });
      };

      Backend.addReport = function(postId, reason, reporterUid) {
        return addDoc(collection(db, "reports"), {
          postId: str(postId, "unknown"),
          reason: str(reason, "reported"),
          reporterUid: reporterUid,
          createdAt: serverTimestamp()
        });
      };

      // serverTimestamps: "estimate" gives our own just-written docs a local time
      // instead of null while the write is pending, so ordering/labels stay sane.
      Backend.listenPosts = function(circleId, cb, onError) {
        var q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(100));
        return onSnapshot(q, function(snap) {
          var posts = [];
          snap.forEach(function(d) {
            var data = d.data({ serverTimestamps: "estimate" });
            data.id = d.id;
            if (circleId && circleId !== "all" && data.circle !== circleId) return;
            posts.push(data);
          });
          cb(posts);
        }, function(e) {
          console.error("listenPosts failed", e);
          if (onError) onError(e);
        });
      };

      Backend.listenReplies = function(postId, cb, onError) {
        var q = query(collection(db, "posts/" + postId + "/replies"), orderBy("createdAt", "asc"));
        return onSnapshot(q, function(snap) {
          var replies = [];
          snap.forEach(function(d) {
            var data = d.data({ serverTimestamps: "estimate" });
            data.id = d.id;
            replies.push(data);
          });
          cb(replies);
        }, function(e) {
          console.error("listenReplies failed", e);
          if (onError) onError(e);
        });
      };

    }).catch(function(e) {
      console.error("Firebase load failed, demo mode fallback", e);
      Backend.isReal = false;
    });
  } else {
    Backend.ready = Promise.resolve();
  }
})();
