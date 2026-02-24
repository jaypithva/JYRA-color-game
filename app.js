/* =====================================================
   Firebase + Firestore Cross-Device App (CLEAN + SAFE)
   - Works with compat SDK
===================================================== */

(function () {
  "use strict";

  const SESSION_KEY = "club_session_v2";

  const DEFAULT_ADMIN = {
    clientId: "ADMIN1",
    role: "admin",
    name: "Admin",
    phone: "9316740061",
    password: "Jay@1803",
  };

  // ====== FIREBASE INIT ======
  function ensureFirebase() {
    if (typeof firebase === "undefined") {
      throw new Error("Firebase SDK missing. Add firebase-app-compat + firebase-firestore-compat before app.js");
    }
    if (!window.firebaseConfig) {
      throw new Error("firebaseConfig missing. Set window.firebaseConfig before app.js");
    }
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(window.firebaseConfig);
    }
    if (!firebase.firestore) {
      throw new Error("Firestore SDK missing. Add firebase-firestore-compat before app.js");
    }
    return firebase.firestore();
  }

  function db() { return ensureFirebase(); }

  // ====== HELPERS ======
  function nowISO() { return new Date().toISOString(); }
  function safeNum(n) { n = Number(n); return Number.isFinite(n) ? n : 0; }

  // ✅ Improved: supports ISO string, Date, Firestore Timestamp
  function fmtDate(v) {
    try {
      if (!v) return "-";
      if (typeof v === "string") return new Date(v).toLocaleString("en-IN");
      if (v instanceof Date) return v.toLocaleString("en-IN");
      if (v && typeof v.toDate === "function") return v.toDate().toLocaleString("en-IN"); // Timestamp
      if (v && typeof v.seconds === "number") return new Date(v.seconds * 1000).toLocaleString("en-IN");
      return String(v);
    } catch (e) {
      return String(v || "-");
    }
  }

  async function sha256(text) {
    const enc = new TextEncoder().encode(String(text));
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ✅ Store both userId + clientId (some pages expect clientId)
  function setSession(userIdOrClientId) {
    const id = String(userIdOrClientId || "").trim();
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: id, clientId: id, at: nowISO() }));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    window.__ME = null;
  }

  // ✅ Normalize old sessions that had only userId OR only clientId
  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      const s = raw ? JSON.parse(raw) : null;
      if (!s) return null;

      // normalize
      if (!s.userId && s.clientId) s.userId = s.clientId;
      if (!s.clientId && s.userId) s.clientId = s.userId;

      return s;
    } catch (e) {
      return null;
    }
  }

  // ====== FIRESTORE PATHS ======
  function userRef(userId) { return db().collection("users").doc(userId); }
  function txnsCol(userId) { return userRef(userId).collection("txns"); }
  function playsCol(userId) { return userRef(userId).collection("plays"); }

  // ====== USER READS ======
  async function getUserById(userId) {
    const snap = await userRef(userId).get();
    return snap.exists ? snap.data() : null;
  }

  // ✅ alias for older admin.html fallback
  async function getUserByIdFS(userId) {
    const snap = await userRef(String(userId)).get();
    return snap.exists ? ({ id: snap.id, ...snap.data() }) : null;
  }

  async function getUserByPhone(phone) {
    const q = await db().collection("users").where("phone", "==", String(phone)).limit(1).get();
    if (q.empty) return null;
    return q.docs[0].data();
  }

  async function currentUserAsync() {
    const sess = getSession();
    if (!sess || !sess.userId) return null;
    if (window.__ME && window.__ME.clientId === sess.userId) return window.__ME;

    const u = await getUserById(sess.userId);
    window.__ME = u;
    return u;
  }

  function currentUser() { return window.__ME || null; }

  function logout() {
    clearSession();
    window.location.replace("login.html");
  }

  // ====== GUARDS ======
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

  // ====== BOOTSTRAP ADMIN DOC ======
  async function ensureAdminDoc() {
    const ref = userRef(DEFAULT_ADMIN.clientId);
    const snap = await ref.get();
    if (snap.exists) return;

    const passwordHash = await sha256(DEFAULT_ADMIN.password);
    await ref.set({
      clientId: DEFAULT_ADMIN.clientId,
      role: DEFAULT_ADMIN.role,
      name: DEFAULT_ADMIN.name,
      phone: DEFAULT_ADMIN.phone,
      points: 0,
      passwordHash,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
  }

  // ====== AUTH ======
  async function loginSecure({ phoneOrId, password }) {
    await ensureAdminDoc();

    const key = String(phoneOrId || "").trim();
    if (!key) return { ok: false, msg: "Enter phone or Client ID" };

    let user = null;
    const byId = await getUserById(key);
    if (byId) user = byId;
    if (!user) user = await getUserByPhone(key);

    if (!user) return { ok: false, msg: "User not found" };
    if (!user.passwordHash) return { ok: false, msg: "Password not set for this profile" };

    const hash = await sha256(password || "");
    if (hash !== user.passwordHash) return { ok: false, msg: "Wrong password" };

    setSession(user.clientId);
    window.__ME = user;
    return { ok: true, user };
  }

  async function registerUserSecure({ name, phone, password }) {
    await ensureAdminDoc();

    name = String(name || "").trim();
    phone = String(phone || "").trim();
    password = String(password || "");

    if (!name || !phone || !password) return { ok: false, msg: "All fields required" };
    if (!/^\d{10}$/.test(phone)) return { ok: false, msg: "Phone must be 10 digits" };

    const q = await db().collection("users").where("phone", "==", phone).limit(1).get();
    if (!q.empty) return { ok: false, msg: "Phone already exists" };

    const clientId = "C" + Math.floor(10000 + Math.random() * 90000);

    const ref = userRef(clientId);
    const exists = await ref.get();
    if (exists.exists) return { ok: false, msg: "Try again (ID collision)" };

    const passwordHash = await sha256(password);

    const user = {
      clientId,
      role: "user",
      name,
      phone,
      points: 0,
      passwordHash,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };

    await ref.set(user);
    return { ok: true, user };
  }

  async function adminCreateClient({ name, phone, password }, adminId) {
    const a = await getUserById(adminId);
    if (!a || a.role !== "admin") return { ok: false, msg: "Unauthorized" };
    return await registerUserSecure({ name, phone, password });
  }

  // ====== POINTS + TXNS ======
  async function adjustPoints(userId, delta, note, byAdminId = null) {
    userId = String(userId || "").trim();
    const d = Number(delta);
    if (!userId) return { ok: false, msg: "User missing" };
    if (!Number.isFinite(d)) return { ok: false, msg: "Invalid points" };

    const uref = userRef(userId);

    try {
      const result = await db().runTransaction(async (tx) => {
        const snap = await tx.get(uref);
        if (!snap.exists) throw new Error("User not found");

        const u = snap.data();
        const cur = safeNum(u.points);
        const next = cur + d;
        if (next < 0) throw new Error("Insufficient points");

        tx.update(uref, { points: next, updatedAt: nowISO() });

        const tdoc = txnsCol(userId).doc();
        tx.set(tdoc, {
          id: tdoc.id,
          userId,
          type: d >= 0 ? "credit" : "debit",
          amount: Math.abs(d),
          note: note || "",
          byAdminId: byAdminId || null,
          createdAt: nowISO(),
        });

        return next;
      });

      if (window.__ME && window.__ME.clientId === userId) {
        window.__ME = await getUserById(userId);
      }

      return { ok: true, points: result };
    } catch (e) {
      return { ok: false, msg: e && e.message ? e.message : String(e) };
    }
  }

  async function userTxns(userId, limit = 100) {
    const q = await txnsCol(userId).orderBy("createdAt", "desc").limit(Number(limit || 100)).get();
    return q.docs.map((d) => d.data());
  }

  // ====== PLAYS ======
  async function addPlayRow(row) {
    if (!row) return { ok: false, msg: "Row missing" };
    if (!row.userId) return { ok: false, msg: "userId missing" };

    const userId = String(row.userId);
    const doc = playsCol(userId).doc();
    row.id = row.id || doc.id;
    row.createdAt = row.createdAt || nowISO();

    await doc.set(row);
    return { ok: true, id: doc.id };
  }

  async function playsForUser(userId, limit = 30) {
    const q = await playsCol(userId).orderBy("createdAt", "desc").limit(Number(limit || 30)).get();
    return q.docs.map((d) => d.data());
  }

  // =====================================================
  // ✅ ADMIN LISTING + ADMIN ACTIONS (MISSING IN YOUR app.js)
  // =====================================================

  // ✅ Used by admin.html tables
  async function listUsers() {
    const snap = await db().collection("users").get();
    const arr = [];
    snap.forEach((doc) => arr.push({ id: doc.id, ...doc.data() }));
    return arr;
  }
  // alias
  async function listAllUsers() { return await listUsers(); }

  // ✅ Clear bet history (users/{id}/plays)
  async function clearClientHistory(userId, resetWallet) {
    userId = String(userId || "").trim();
    if (!userId) return { ok: false, msg: "User missing" };

    try {
      const pSnap = await playsCol(userId).get();
      if (!pSnap.empty) {
        const batch = db().batch();
        pSnap.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }

      if (resetWallet) {
        await userRef(userId).update({ points: 0, updatedAt: nowISO() });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e && e.message ? e.message : String(e) };
    }
  }

  // ✅ Reset passwordHash
  async function adminResetClientPassword(userId, newPass, adminId) {
    userId = String(userId || "").trim();
    newPass = String(newPass || "");
    if (!userId) return { ok: false, msg: "User missing" };
    if (newPass.length < 4) return { ok: false, msg: "Password min 4 chars" };

    // optional admin validation
    if (adminId) {
      const a = await getUserById(String(adminId));
      if (!a || a.role !== "admin") return { ok: false, msg: "Unauthorized" };
    }

    try {
      const passwordHash = await sha256(newPass);
      await userRef(userId).update({ passwordHash, updatedAt: nowISO() });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e && e.message ? e.message : String(e) };
    }
  }

  // ✅ Delete user + plays + txns
  async function deleteClient(userId, adminId) {
    userId = String(userId || "").trim();
    if (!userId) return { ok: false, msg: "User missing" };

    // optional admin validation
    if (adminId) {
      const a = await getUserById(String(adminId));
      if (!a || a.role !== "admin") return { ok: false, msg: "Unauthorized" };
    }

    try {
      // delete plays
      const pSnap = await playsCol(userId).get();
      if (!pSnap.empty) {
        const batch = db().batch();
        pSnap.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }

      // delete txns
      const tSnap = await txnsCol(userId).get();
      if (!tSnap.empty) {
        const batch2 = db().batch();
        tSnap.forEach((d) => batch2.delete(d.ref));
        await batch2.commit();
      }

      await userRef(userId).delete();
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: e && e.message ? e.message : String(e) };
    }
  }

  // =====================================================
  // GAME RESULTS ENGINE (IST 30s Period Store)
  // =====================================================
  const GAME_CFG = { cycleSec: 30, resultsCol: "game_results_v1" };

  function resultsRef(period) { return db().collection(GAME_CFG.resultsCol).doc(String(period)); }
  function resultsColRef() { return db().collection(GAME_CFG.resultsCol); }

  function istNow() {
    const now = new Date();
    const utcMs = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utcMs + (5.5 * 3600000));
  }
  function ymdIST(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  }

  function startOfISTDayMoment(dIst) {
    const y = dIst.getFullYear(), m = dIst.getMonth(), day = dIst.getDate();
    const utcMidnight = new Date(Date.UTC(y, m, day, 0, 0, 0));
    return new Date(utcMidnight.getTime() - (5.5 * 3600000));
  }

  function secondsSinceISTMidnight() {
    const nowIst = istNow();
    const istMidnightMoment = startOfISTDayMoment(nowIst);
    const diffSec = Math.floor((Date.now() - istMidnightMoment.getTime()) / 1000);
    return Math.max(0, diffSec);
  }

  function cycleIndexNow() {
    const sec = secondsSinceISTMidnight();
    return Math.floor(sec / GAME_CFG.cycleSec) + 1; // 1..2880
  }

  function makePeriodByIndex(dateYmd, idx) {
    return `${dateYmd}-${String(idx).padStart(4, "0")}`;
  }

  function currentPeriodIST() {
    const d = istNow();
    return makePeriodByIndex(ymdIST(d), cycleIndexNow());
  }

  function periodByOffset(offset30Steps) {
    const d = istNow();
    const dateYmd = ymdIST(d);
    const idx = Math.max(1, cycleIndexNow() + Number(offset30Steps || 0));
    return makePeriodByIndex(dateYmd, idx);
  }

  function nextPeriodsIST(count) {
    const d = istNow();
    const dateYmd = ymdIST(d);
    const base = cycleIndexNow();
    const arr = [];
    for (let i = 0; i < count; i++) arr.push(makePeriodByIndex(dateYmd, base + i));
    return arr;
  }

  async function autoResultForPeriod(period) {
    const hex = await sha256(String(period));
    const n = parseInt(hex.slice(0, 8), 16) % 10;
    const resultColor = (n === 0 || n === 5) ? "Violet" : (n === 1 || n === 3 || n === 7 || n === 9) ? "Green" : "Red";
    const resultBigSmall = (n >= 5) ? "Big" : "Small";
    return { resultNumber: n, resultColor, resultBigSmall };
  }

  async function ensureResultExists(period) {
    const ref = resultsRef(period);
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return;
      const r = await autoResultForPeriod(period);
      tx.set(ref, { period, ...r, createdAt: nowISO(), source: "auto_v1" });
    });
    const after = await ref.get();
    return after.exists ? after.data() : null;
  }

  function listenLastNResults(n, onChange) {
    return resultsColRef()
      .orderBy("period", "desc")
      .limit(Number(n || 10))
      .onSnapshot((snap) => {
        const rows = snap.docs.map((d) => d.data());
        if (typeof onChange === "function") onChange(rows);
      });
  }

  // ====== EXPOSE GLOBALS ======
  window.fmtDate = fmtDate;
  window.sha256 = sha256;

  window.currentUser = currentUser;
  window.currentUserAsync = currentUserAsync;

  window.requireLoginAsync = requireLoginAsync;
  window.requireAdminAsync = requireAdminAsync;

  window.loginSecure = loginSecure;
  window.registerUserSecure = registerUserSecure;
  window.adminCreateClient = adminCreateClient;

  window.adjustPoints = adjustPoints;
  window.userTxns = userTxns;

  window.addPlayRow = addPlayRow;
  window.playsForUser = playsForUser;

  // ✅ NEW exports
  window.listUsers = listUsers;
  window.listAllUsers = listAllUsers;
  window.getUserByIdFS = getUserByIdFS;
  window.clearClientHistory = clearClientHistory;
  window.adminResetClientPassword = adminResetClientPassword;
  window.deleteClient = deleteClient;

  window.logout = logout;

  window.GAME = {
    cfg: GAME_CFG,
    currentPeriodIST,
    periodByOffset,
    nextPeriodsIST,
    secondsSinceISTMidnight,
    ensureResultExists,
    listenLastNResults
  };
})();
