/* =====================================================
   Firebase + Firestore CROSS-DEVICE app.js
   (Replace your complete app.js with this)
===================================================== */

(function () {
  "use strict";

  // ---------- CONFIG ----------
  const SESSION_KEY = "club_session_v2"; // local session only
  const DEFAULT_ADMIN = {
    id: "ADMIN1",
    role: "admin",
    name: "Admin",
    phone: "9316740061",
    password: "Jay@1803"
  };

  // ---------- FIREBASE INIT ----------
  function ensureFirebase() {
    if (!window.firebase) throw new Error("Firebase SDK not loaded");
    if (!window.firebaseConfig) throw new Error("window.firebaseConfig missing");

    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(window.firebaseConfig);
    }
    return firebase.firestore();
  }

  function db() {
    return ensureFirebase();
  }

  // ---------- HELPERS ----------
  function nowISO() { return new Date().toISOString(); }

  function uid(prefix = "C") {
    return prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  function safeNum(n) {
    n = Number(n);
    return Number.isFinite(n) ? n : 0;
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString("en-IN"); }
    catch (e) { return String(iso || "-"); }
  }

  // SHA-256 (browser)
  async function sha256(text) {
    const enc = new TextEncoder().encode(String(text));
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ---------- SESSION ----------
  function setSession(userId) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, at: nowISO() }));
  }
  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
  }
  function getSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); }
    catch { return null; }
  }

  // Cached user (last fetched)
  let _cachedUser = null;

  async function fetchUserById(userId) {
    const snap = await db().collection("users").doc(userId).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
  }

  async function fetchUserByPhone(phone) {
    const qs = await db().collection("users")
      .where("phone", "==", phone)
      .limit(1)
      .get();
    if (qs.empty) return null;
    const doc = qs.docs[0];
    return { id: doc.id, ...doc.data() };
  }

  async function currentUserAsync() {
    const sess = getSession();
    if (!sess || !sess.userId) return null;
    if (_cachedUser && _cachedUser.id === sess.userId) return _cachedUser;

    const u = await fetchUserById(sess.userId);
    _cachedUser = u;
    return u;
  }

  // Sync wrapper (old code compatibility)
  function currentUser() {
    return _cachedUser;
  }

  function logout() {
    clearSession();
    _cachedUser = null;
    window.location.replace("login.html");
  }

  // ---------- GUARDS ----------
  async function requireLoginAsync() {
    const u = await currentUserAsync();
    if (!u) {
      window.location.replace("login.html");
      return null;
    }
    return u;
  }

  async function requireAdminAsync() {
    const u = await requireLoginAsync();
    if (!u || u.role !== "admin") {
      window.location.replace("login.html");
      return null;
    }
    return u;
  }

  // old sync names (some pages call these)
  function requireLogin() {
    // if not fetched yet, force redirect (safe)
    if (!_cachedUser) {
      window.location.replace("login.html");
      return null;
    }
    return _cachedUser;
  }
  function requireAdmin() {
    const u = requireLogin();
    if (!u || u.role !== "admin") {
      window.location.replace("login.html");
      return null;
    }
    return u;
  }

  // ---------- AUTH ----------
  async function ensureAdminProfile() {
    // If ADMIN1 missing in Firestore, create it (safe)
    const ref = db().collection("users").doc(DEFAULT_ADMIN.id);
    const snap = await ref.get();
    if (snap.exists) return;

    const passwordHash = await sha256(DEFAULT_ADMIN.password);
    await ref.set({
      clientId: DEFAULT_ADMIN.id,
      role: "admin",
      name: DEFAULT_ADMIN.name,
      phone: DEFAULT_ADMIN.phone,
      points: 0,
      passwordHash,
      createdAt: nowISO()
    }, { merge: true });
  }

  async function loginSecure({ phoneOrId, password }) {
    await ensureAdminProfile();

    const input = String(phoneOrId || "").trim();
    const pass = String(password || "");

    if (!input || !pass) return { ok: false, msg: "Enter ID/Phone and Password" };

    let user = null;

    // try by document id first (ClientId like C12345 / ADMIN1)
    user = await fetchUserById(input);
    if (!user) {
      // try by phone
      user = await fetchUserByPhone(input);
    }

    if (!user) return { ok: false, msg: "User not found" };

    // If admin has no hash, set it once (rare)
    if (user.role === "admin" && !user.passwordHash) {
      const h = await sha256(DEFAULT_ADMIN.password);
      await db().collection("users").doc(user.id).set({ passwordHash: h }, { merge: true });
      user.passwordHash = h;
    }

    const hash = await sha256(pass);
    if (!user.passwordHash || user.passwordHash !== hash) {
      return { ok: false, msg: "Wrong password" };
    }

    setSession(user.id);
    _cachedUser = user;
    return { ok: true, user };
  }

  async function registerUserSecure({ name, phone, password }) {
    const n = String(name || "").trim();
    const p = String(phone || "").trim();
    const pw = String(password || "");

    if (!n || !p || !pw) return { ok: false, msg: "All fields required" };
    if (!/^\d{10}$/.test(p)) return { ok: false, msg: "Phone must be 10 digits" };
    if (pw.length < 4) return { ok: false, msg: "Password min 4 chars" };

    // phone uniqueness check
    const exists = await db().collection("users").where("phone", "==", p).limit(1).get();
    if (!exists.empty) return { ok: false, msg: "Phone already exists" };

    // create clientId
    const id = uid("C");
    const passwordHash = await sha256(pw);

    const user = {
      clientId: id,
      role: "user",
      name: n,
      phone: p,
      points: 0,
      passwordHash,
      createdAt: nowISO()
    };

    await db().collection("users").doc(id).set(user, { merge: true });
    return { ok: true, user: { id, ...user } };
  }

  // ---------- POINTS + TXNS ----------
  async function adjustPoints(userId, delta, note, byAdminId = null) {
    const d = Number(delta);
    if (!Number.isFinite(d)) return { ok: false, msg: "Invalid points" };

    const userRef = db().collection("users").doc(userId);
    const txRef = db().collection("txns").doc(); // auto id

    try {
      await db().runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) throw new Error("User not found");

        const u = snap.data();
        const cur = safeNum(u.points);
        const next = cur + d;
        if (next < 0) throw new Error("Insufficient points");

        t.set(userRef, { points: next }, { merge: true });

        t.set(txRef, {
          userId,
          type: d >= 0 ? "credit" : "debit",
          amount: Math.abs(d),
          note: note || "",
          byAdminId: byAdminId || null,
          createdAt: nowISO()
        });
      });

      // refresh cache if needed
      const sess = getSession();
      if (sess && sess.userId === userId) {
        _cachedUser = await fetchUserById(userId);
      }

      const fresh = await fetchUserById(userId);
      return { ok: true, points: fresh ? safeNum(fresh.points) : 0 };
    } catch (e) {
      return { ok: false, msg: e && e.message ? e.message : String(e) };
    }
  }

  async function userTxns(userId) {
    const qs = await db().collection("txns")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();
    return qs.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // ---------- PLAY HISTORY ----------
  async function addPlayRow(row) {
    const data = { ...(row || {}) };
    if (!data.createdAt) data.createdAt = nowISO();
    await db().collection("plays").add(data);
    return { ok: true };
  }

  async function playsForUser(userId, limitN = 30) {
    const qs = await db().collection("plays")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(Number(limitN) || 30)
      .get();
    return qs.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // ---------- ADMIN ----------
  async function adminResetClientPassword(clientId, newPass, adminId) {
    const admin = await fetchUserById(adminId);
    if (!admin || admin.role !== "admin") return { ok: false, msg: "Unauthorized" };

    const userRef = db().collection("users").doc(clientId);
    const snap = await userRef.get();
    if (!snap.exists) return { ok: false, msg: "Client not found" };

    const pw = String(newPass || "").trim();
    if (pw.length < 4) return { ok: false, msg: "New password minimum 4 characters" };

    const passwordHash = await sha256(pw);
    await userRef.set({ passwordHash }, { merge: true });
    return { ok: true };
  }

  async function updateAdminProfile(adminId, name, pass) {
    const adminRef = db().collection("users").doc(adminId);
    const snap = await adminRef.get();
    if (!snap.exists) return { ok: false, msg: "Admin not found" };

    const upd = {};
    if (name && String(name).trim()) upd.name = String(name).trim();
    if (pass && String(pass).trim().length >= 4) upd.passwordHash = await sha256(String(pass).trim());

    if (!Object.keys(upd).length) return { ok: false, msg: "Nothing to update" };
    await adminRef.set(upd, { merge: true });

    // refresh cache if admin is logged in
    const sess = getSession();
    if (sess && sess.userId === adminId) _cachedUser = await fetchUserById(adminId);

    return { ok: true };
  }

  async function deleteClient(clientId, adminId) {
    const admin = await fetchUserById(adminId);
    if (!admin || admin.role !== "admin") return { ok: false, msg: "Unauthorized" };
    if (clientId === DEFAULT_ADMIN.id) return { ok: false, msg: "Cannot delete admin" };

    // delete user doc
    await db().collection("users").doc(clientId).delete();

    // NOTE: txns/plays cleanup can be added later (optional)
    return { ok: true };
  }

  // ---------- expose globally (same names) ----------
  window.DEFAULT_ADMIN = DEFAULT_ADMIN;
  window.fmtDate = fmtDate;

  window.logout = logout;
  window.currentUser = currentUser;
  window.currentUserAsync = currentUserAsync;

  window.requireLogin = requireLogin;
  window.requireAdmin = requireAdmin;
  window.requireLoginAsync = requireLoginAsync;
  window.requireAdminAsync = requireAdminAsync;

  window.loginSecure = loginSecure;
  window.registerUserSecure = registerUserSecure;

  window.adjustPoints = adjustPoints;
  window.userTxns = userTxns;

  window.addPlayRow = addPlayRow;
  window.playsForUser = playsForUser;

  window.adminResetClientPassword = adminResetClientPassword;
  window.updateAdminProfile = updateAdminProfile;
  window.deleteClient = deleteClient;

})();
