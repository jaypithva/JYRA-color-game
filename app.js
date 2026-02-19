/* =====================================================
   Firebase + Firestore Cross-Device App (NO blank pages)
   - Works with compat SDK
   - Global functions: loginSecure, registerUserSecure, adjustPoints, playsForUser, etc.
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

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString("en-IN"); }
    catch (e) { return String(iso || "-"); }
  }

  async function sha256(text) {
    const enc = new TextEncoder().encode(String(text));
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  function setSession(userId) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, at: nowISO() }));
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    window.__ME = null;
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
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

  // ====== ADMIN CREATE CLIENT (alias used by admin.html) ======
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

  // ====== ADMIN OPS ======
  async function adminResetClientPassword(clientId, newPass, adminId) {
    const a = await getUserById(adminId);
    if (!a || a.role !== "admin") return { ok: false, msg: "Unauthorized" };

    newPass = String(newPass || "").trim();
    if (newPass.length < 4) return { ok: false, msg: "New password minimum 4 characters" };

    const ref = userRef(clientId);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, msg: "Client not found" };

    const passwordHash = await sha256(newPass);
    await ref.update({ passwordHash, updatedAt: nowISO() });
    return { ok: true };
  }

  async function updateAdminProfile(adminId, name, pass) {
    const a = await getUserById(adminId);
    if (!a || a.role !== "admin") return { ok: false, msg: "Admin not found" };

    const patch = { updatedAt: nowISO() };
    if (name && String(name).trim()) patch.name = String(name).trim();
    if (pass && String(pass).trim().length >= 4) patch.passwordHash = await sha256(String(pass).trim());

    await userRef(adminId).update(patch);
    window.__ME = await getUserById(adminId);
    return { ok: true };
  }

  async function deleteClient(clientId, adminId) {
    const a = await getUserById(adminId);
    if (!a || a.role !== "admin") return { ok: false, msg: "Unauthorized" };
    if (clientId === DEFAULT_ADMIN.clientId) return { ok: false, msg: "Cannot delete admin" };

    const txSnap = await txnsCol(clientId).get();
    const plSnap = await playsCol(clientId).get();
    const batch = db().batch();

    txSnap.docs.forEach((d) => batch.delete(d.ref));
    plSnap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(userRef(clientId));
    await batch.commit();

    return { ok: true };
  }

  async function clearClientHistory(clientId, resetWallet = false, adminId = null) {
    // optional admin check (if provided)
    if (adminId) {
      const a = await getUserById(adminId);
      if (!a || a.role !== "admin") return { ok: false, msg: "Unauthorized" };
    }

    const txSnap = await txnsCol(clientId).get();
    const plSnap = await playsCol(clientId).get();
    const batch = db().batch();

    txSnap.docs.forEach((d) => batch.delete(d.ref));
    plSnap.docs.forEach((d) => batch.delete(d.ref));

    if (resetWallet) batch.update(userRef(clientId), { points: 0, updatedAt: nowISO() });

    await batch.commit();

    if (window.__ME && window.__ME.clientId === clientId) {
      window.__ME = await getUserById(clientId);
    }

    return { ok: true };
  }

  async function listAllUsers() {
    const q = await db().collection("users").orderBy("createdAt", "desc").get();
    return q.docs.map((d) => d.data());
  }

  // ====== ALIASES (for your admin.html older calls) ======
  async function listUsers() { return await listAllUsers(); }
  async function getUserByIdFS(userId) { return await getUserById(userId); }
  // =====================================================
  // GAME ENGINE (IST 30s Period + Results + Last-5)
  // - Clock-driven (works even if site was closed)
  // - Stores results in Firestore so everyone sees same last 5
  // =====================================================

  const GAME_CFG = {
    cycleSec: 30,
    resultsCol: "game_results_v1", // NEW collection
    colors: ["GREEN", "RED", "VIOLET"], // aapke game ke hisaab se change ho sakta hai
  };

  function resultsRef(period) {
    return db().collection(GAME_CFG.resultsCol).doc(String(period));
  }
  function resultsColRef() {
    return db().collection(GAME_CFG.resultsCol);
  }

  // ---- IST helpers (no external libs) ----
  function istNow() {
    // IST = UTC + 5:30
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

  function startOfISTDay(d) {
    // Create IST midnight timestamp in real UTC ms
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    // This date is in IST "calendar", but JS Date is UTC-based internally.
    // We'll compute IST midnight by taking UTC midnight and subtracting 5:30 offset.
    const istMidnightLocal = new Date(Date.UTC(y, m, day, 0, 0, 0));
    // Convert "IST calendar midnight" to actual moment in UTC by subtracting IST offset
    return new Date(istMidnightLocal.getTime() - (5.5 * 3600000));
  }

  function secondsSinceISTMidnight() {
    const nowIst = istNow();
    const istMidnightMoment = startOfISTDay(nowIst); // moment of IST midnight
    const nowUtcMs = Date.now();
    const diffSec = Math.floor((nowUtcMs - istMidnightMoment.getTime()) / 1000);
    return Math.max(0, diffSec);
  }

  function periodIndexNow() {
    const sec = secondsSinceISTMidnight();
    return Math.floor(sec / GAME_CFG.cycleSec) + 1; // 1..2880
  }

  function makePeriodByIndex(dateYmd, idx) {
    return `${dateYmd}-${String(idx).padStart(4, "0")}`;
  }

  function currentPeriodIST() {
    const dateYmd = ymdIST(istNow());
    return makePeriodByIndex(dateYmd, periodIndexNow());
  }

  function nextPeriodsIST(count = 3) {
    const nowIst = istNow();
    const dateYmd = ymdIST(nowIst);
    const base = periodIndexNow();
    const arr = [];
    for (let i = 0; i < count; i++) {
      arr.push(makePeriodByIndex(dateYmd, base + i));
    }
    return arr;
  }

  function remainingSecondsInCycle() {
    const sec = secondsSinceISTMidnight();
    const into = sec % GAME_CFG.cycleSec;
    return GAME_CFG.cycleSec - into;
  }

  // ---- Deterministic result generator (phase-1) ----
  async function autoResultForPeriod(period) {
    // stable across devices (no secret). For higher security later use server secret seed.
    const hex = await sha256(String(period));
    const n = parseInt(hex.slice(0, 8), 16);
    const color = GAME_CFG.colors[n % GAME_CFG.colors.length];
    return color;
  }

  async function ensureResultExists(period) {
    const ref = resultsRef(period);

    // Use transaction to avoid duplicates when multiple users open at same time
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return;

      const color = await autoResultForPeriod(period);
      tx.set(ref, {
        period,
        color,
        createdAt: nowISO(),
        source: "auto_v1",
      });
    });

    const after = await ref.get();
    return after.exists ? after.data() : null;
  }

  async function backfillLastNResults(n = 5) {
    // Create missing docs for last N periods including current
    const nowIst = istNow();
    const dateYmd = ymdIST(nowIst);
    const curIdx = periodIndexNow();

    const periods = [];
    for (let i = n - 1; i >= 0; i--) {
      const idx = curIdx - i;
      if (idx >= 1) periods.push(makePeriodByIndex(dateYmd, idx));
    }

    // Ensure each exists
    for (const p of periods) {
      await ensureResultExists(p);
    }

    return periods;
  }

  async function fetchLastNResults(n = 5) {
    const q = await resultsColRef()
      .orderBy("period", "desc")
      .limit(Number(n || 5))
      .get();
    return q.docs.map((d) => d.data());
  }

  function listenLastNResults(n = 5, onChange) {
    return resultsColRef()
      .orderBy("period", "desc")
      .limit(Number(n || 5))
      .onSnapshot((snap) => {
        const rows = snap.docs.map((d) => d.data());
        if (typeof onChange === "function") onChange(rows);
      });
  }

  // ---- Expose game helpers globally for game.html ----
  window.GAME = {
    cfg: GAME_CFG,
    currentPeriodIST,
    nextPeriodsIST,
    remainingSecondsInCycle,
    backfillLastNResults,
    fetchLastNResults,
    listenLastNResults,
    ensureResultExists,
  };

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

  window.adminResetClientPassword = adminResetClientPassword;
  window.updateAdminProfile = updateAdminProfile;
  window.deleteClient = deleteClient;
  window.clearClientHistory = clearClientHistory;

  window.logout = logout;

  window.listAllUsers = listAllUsers;
  window.listUsers = listUsers;
  window.getUserByIdFS = getUserByIdFS;

})();

