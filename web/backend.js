(function() {
  window.Backend = {
    isReal: false,
    ready: null,
    // hooks
    signInWithGoogle: null,
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
      var GoogleAuthProvider = modules[1].GoogleAuthProvider;
      var fbSignOut = modules[1].signOut;
      var onAuthStateChanged = modules[1].onAuthStateChanged;
      var doc = modules[2].doc, getDoc = modules[2].getDoc, setDoc = modules[2].setDoc,
          collection = modules[2].collection, addDoc = modules[2].addDoc, 
          serverTimestamp = modules[2].serverTimestamp, query = modules[2].query, 
          orderBy = modules[2].orderBy, onSnapshot = modules[2].onSnapshot, limit = modules[2].limit;

      Backend.signInWithGoogle = function() {
        var provider = new GoogleAuthProvider();
        return signInWithPopup(auth, provider);
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
        return setDoc(doc(db, "profiles", uid), profile, { merge: true });
      };

      Backend.addPost = function(uid, authorName, isAnon, circle, title, body, meta, hue) {
        return addDoc(collection(db, "posts"), {
          uid: uid,
          author: isAnon ? null : authorName,
          anon: isAnon,
          circle: circle,
          title: title,
          body: body,
          meta: meta,
          hue: hue,
          createdAt: serverTimestamp(),
          replyCount: 0
        });
      };

      Backend.addReply = function(postId, uid, authorName, isAnon, body, hue) {
        return addDoc(collection(db, "posts/" + postId + "/replies"), {
          uid: uid,
          author: isAnon ? null : authorName,
          anon: isAnon,
          body: body,
          hue: hue,
          createdAt: serverTimestamp()
        });
      };
      
      Backend.addReport = function(postId, reason, reporterUid) {
        return addDoc(collection(db, "reports"), {
          postId: postId,
          reason: reason,
          reporterUid: reporterUid,
          createdAt: serverTimestamp()
        });
      };

      Backend.listenPosts = function(circleId, cb) {
        var q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(100));
        return onSnapshot(q, function(snap) {
          var posts = [];
          snap.forEach(function(d) {
            var data = d.data();
            data.id = d.id;
            if (circleId && circleId !== "all" && data.circle !== circleId) return;
            posts.push(data);
          });
          cb(posts);
        });
      };
      
      Backend.listenReplies = function(postId, cb) {
        var q = query(collection(db, "posts/" + postId + "/replies"), orderBy("createdAt", "asc"));
        return onSnapshot(q, function(snap) {
          var replies = [];
          snap.forEach(function(d) {
            var data = d.data();
            data.id = d.id;
            replies.push(data);
          });
          cb(replies);
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
