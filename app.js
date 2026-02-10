/* =====================================================
   CONFIG
===================================================== */
const DB_KEY = "club_db_v1";              // fallback local (optional)
const SESSION_KEY = "club_session_v1";
const PLAY_KEY = "club_play_history_v1";  // fallback local (optional)

const COL_USERS = "users";
const COL_TXNS  = "txns";
const COL_PLAYS = "plays";

// ✅ Fixed Admin
const DEFAULT_ADMIN = {
  id: "ADMIN1",
  role: "admin",
  name: "Admin",
  phone: "9316740061",
  password: "Jay@1803"
};

/* =====================================================
   HELPERS
===================================================== */
function nowISO() { return new Date().toISOString(); }

function uid(p = "U") {
  return p + Math.random().toString(36).slice(2, 9).toUpperCase();
}

function safeJSONParse(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function safeNum(n) {
  n = Number(n);
  return Number.isFinite(n) ? n : 0;
}

function toTimeSafe(anyDate) {
  if (!anyDate) return 0;
  const t = new Date(anyDate).getTime();
  return Number.isFinite(t) ? t : 0;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString("en-IN"); }
  catch { return String(iso || "-"); }
}

function dateInputToStart(ymd) {
  if (!ymd) return null;
  const parts = String(ymd).split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]), m = Number(parts[1]) - 1, d = Number(parts[2]);
  const dt = new Date(y, m, d, 0, 0, 0, 0);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function endOfDayTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

function inRangeISO(iso, fromDateObj, toDateObj) {
  const t = toTimeSafe(iso);
  if (!fromDateObj && !toDateObj) return true;
  if (fromDateObj && t < fromDateObj.getTime()) return false;
  if (toDateObj && t > endOfDayTime(toDateObj)) return false;
  return true;
}

/* =====================================================
   SECURITY (HASH)
===================================================== */
async function sha256(text) {
  const enc = new TextEncoder().encode(String(text));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* =====================================================
   FIREBASE GUARD
===================================================== */
function hasFirebase() {
  return typeof window !== "undefined" && window.db && window.firebase && window.firebase.firestore;
}

function getDb() {
  return hasFirebase() ? window.db : null;
}

function FieldValue() {
  // compat FieldValue
  return window.firebase.firestore.FieldValue;
}

async function ensureAdminInFirestore() {
  const db = getDb();
  if (!db) return;

  const ref = db.collection(COL_USERS).doc(DEFAULT_ADMIN.id);
  const snap = await ref.get();
  if (snap.exists) return;

  const passwordHash = await sha256(DEFAULT_ADMIN.password);
  await ref.set({
    id: DEFAULT_ADMIN.id,
    role: "admin",
    name: DEFAULT_ADMIN.name,
    phone: DEFAULT_ADMIN.phone,
    passwordHash,
    points: 0,
    createdAt: nowISO()
  }, { merge: true });
}

/* =====================================================
   SESSION (Cross-device login ke liye)
===================================================== */
function setSession(userObj) {
  // cache full user for sync currentUser()
  localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: userObj.id, user: userObj, at: nowISO() }));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? safeJSONParse(raw, null) : null;
}

function currentUser() {
  const sess = getSession();
  if (!sess || !sess.userId) return null;
  // ✅ sync user from cache (pages blank nahi honge)
  return sess.user || null;
}

async function refreshCurrentUser() {
  const sess = getSession();
  if (!sess || !sess.userId) return null;
  const u = await getUserById(sess.userId);
  if (u) setSession(u);
  return u || null;
}

function logout() {
  clearSession();
  window.location.replace("login.html");
}

/* =====================================================
   LOCAL FALLBACK DB (optional)
   (Agar firebase missing ho, page crash na ho)
===================================================== */
function loadDB_local() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) {
    const db = safeJSONParse(raw, null);
    if (db && Array.isArray(db.users) && Array.isArray(db.txns)) return db;
  }
  const db = { users: [], txns: [] };
  db.users.push({
    id: DEFAULT_ADMIN.id,
    role: DEFAULT_ADMIN.role,
    name: DEFAULT_ADMIN.name,
    phone: DEFAULT_ADMIN.phone,
    passwordHash: null,
    points: 0,
    createdAt: nowISO()
  });
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  return db;
}
function saveDB_local(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }

/* =====================================================
   DATABASE (Firestore preferred)
===================================================== */
async function getUserById(userId) {
  const db = getDb();
  if (!db) {
    const ldb = loadDB_local();
    return (ldb.users || []).find(u => u.id === userId) || null;
  }
  await ensureAdminInFirestore();
  const snap = await db.collection(COL_USERS).doc(String(userId)).get();
  return snap.exists ? snap.data() : null;
}

async function findUserByPhoneOrId(phoneOrId) {
  const db = getDb();
  const key = String(phoneOrId || "").trim();
  if (!key) return null;

  if (!db) {
    const ldb = loadDB_local();
    return (ldb.users || []).find(u => u.phone === key || u.id === key) || null;
  }

  await ensureAdminInFirestore();

  // 1) try direct doc by id
  const byId = await db.collection(COL_USERS).doc(key).get();
  if (byId.exists) return byId.data();

  // 2) else try phone query
  const q = await db.collection(COL_USERS).where("phone", "==", key).limit(1).get();
  if (!q.empty) return q.docs[0].data();

  return null;
}

/* =====================================================
   GUARDS
===================================================== */
function requireLogin() {
  const u = currentUser();
  if (!u) {
    window.location.replace("login.html");
    return null;
  }
  return u;
}

function requireAdmin() {
  const u = requireLogin();
  if (!u || u.role !== "admin") {
    window.location.replace("login.html");
    return null;
  }
  return u;
}

/* =====================================================
   AUTH (Cross-device)
===================================================== */
async function loginSecure({ phoneOrId, password }) {
  const user = await findUserByPhoneOrId(phoneOrId);
  if (!user) return { ok: false, msg: "User not found" };

  // Ensure admin hash exists (if old admin doc missing hash)
  if (user.role === "admin" && !user.passwordHash) {
    const db = getDb();
    if (db) {
      const adminHash = await sha256(DEFAULT_ADMIN.password);
      await db.collection(COL_USERS).doc(user.id).set({ passwordHash: adminHash }, { merge: true });
      user.passwordHash = adminHash;
    } else {
      // local fallback
      const ldb = loadDB_local();
      const a = (ldb.users || []).find(u => u.id === user.id);
      if (a && !a.passwordHash) {
        a.passwordHash = await sha256(DEFAULT_ADMIN.password);
        saveDB_local(ldb);
        user.passwordHash = a.passwordHash;
      }
    }
  }

  const hash = await sha256(password);
  if (user.passwordHash !== hash) return { ok: false, msg: "Wrong password" };

  setSession(user);
  return { ok: true, user };
}

// ✅ Admin uses this to create client (Firestore)
async function registerUserSecure({ name, phone, password }) {
  const db = getDb();

  if (!name || !phone || !password) return { ok: false, msg: "All fields required" };
  if (!/^\d{10}$/.test(String(phone))) return { ok: false, msg: "Phone must be 10 digits" };

  if (!db) {
    // local fallback
    const ldb = loadDB_local();
    if (ldb.users.some(u => u.phone === phone)) return { ok: false, msg: "Phone already exists" };
    const user = {
      id: uid("C"),
      role: "user",
      name: String(name).trim(),
      phone: String(phone).trim(),
      passwordHash: await sha256(password),
      points: 0,
      createdAt: nowISO()
    };
    ldb.users.push(user);
    saveDB_local(ldb);
    return { ok: true, user };
  }

  await ensureAdminInFirestore();

  // check phone unique
  const q = await db.collection(COL_USERS).where("phone", "==", String(phone).trim()).limit(1).get();
  if (!q.empty) return { ok: false, msg: "Phone already exists" };

  const user = {
    id: uid("C"),
    role: "user",
    name: String(name).trim(),
    phone: String(phone).trim(),
    passwordHash: await sha256(password),
    points: 0,
    createdAt: nowISO()
  };

  await db.collection(COL_USERS).doc(user.id).set(user);
  return { ok: true, user };
}

/* =====================================================
   POINTS + TRANSACTIONS (Firestore Transaction)
===================================================== */
async function adjustPoints(userId, delta, note, byAdminId = null) {
  const db = getDb();

  const d = Number(delta);
  if (!Number.isFinite(d)) return { ok: false, msg: "Invalid points" };

  if (!db) {
    // local fallback (old behavior)
    const ldb = loadDB_local();
    const u = (ldb.users || []).find(x => x.id === userId);
    if (!u) return { ok: false, msg: "User not found" };

    const cur = (typeof u.points === "number") ? u.points : 0;
    const next = cur + d;
    if (next < 0) return { ok: false, msg: "Insufficient points" };
    u.points = next;

    ldb.txns.unshift({
      id: uid("T"),
      userId,
      type: d >= 0 ? "credit" : "debit",
      amount: Math.abs(d),
      note: note || "",
      byAdminId: byAdminId || null,
      createdAt: nowISO()
    });
    saveDB_local(ldb);

    // update session cache if same user
    const sess = getSession();
    if (sess && sess.userId === userId) setSession(u);

    return { ok: true, points: u.points };
  }

  await ensureAdminInFirestore();

  const userRef = db.collection(COL_USERS).doc(String(userId));
  const txRef = db.collection(COL_TXNS).doc(uid("T"));

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("User not found");

      const u = snap.data();
      const cur = (typeof u.points === "number") ? u.points : 0;
      const next = cur + d;
      if (next < 0) throw new Error("Insufficient points");

      tx.update(userRef, { points: next });

      tx.set(txRef, {
        id: txRef.id,
        userId: String(userId),
        type: d >= 0 ? "credit" : "debit",
        amount: Math.abs(d),
        note: note || "",
        byAdminId: byAdminId || null,
        createdAt: nowISO()
      });

      return next;
    });

    // update session cache if same user
    const sess = getSession();
    if (sess && sess.userId === userId) {
      const fresh = await getUserById(userId);
      if (fresh) setSession(fresh);
    }

    return { ok: true, points: result };
  } catch (e) {
    return { ok: false, msg: (e && e.message) ? e.message : "Update failed" };
  }
}

async function userTxns(userId) {
  const db = getDb();
  if (!db) {
    const ldb = loadDB_local();
    return (ldb.txns || []).filter(t => t.userId === userId);
  }

  const q = await db.collection(COL_TXNS)
    .where("userId", "==", String(userId))
    .orderBy("createdAt", "desc")
    .limit(500)
    .get();

  return q.docs.map(d => d.data());
}

/* =====================================================
   PLAY HISTORY (Firestore)
===================================================== */
function loadPlays_local() {
  const raw = localStorage.getItem(PLAY_KEY);
  return raw ? safeJSONParse(raw, []) : [];
}
function savePlays_local(rows) { localStorage.setItem(PLAY_KEY, JSON.stringify(rows || [])); }

async function addPlayRow(row) {
  if (!row.createdAt) row.createdAt = nowISO();

  const db = getDb();
  if (!db) {
    const rows = loadPlays_local();
    rows.unshift(row);
    savePlays_local(rows);
    return { ok: true };
  }

  const id = row.id || uid("P");
  row.id = id;

  await db.collection(COL_PLAYS).doc(id).set(row, { merge: true });
  return { ok: true };
}

async function playsForUser(userId) {
  const db = getDb();
  if (!db) return loadPlays_local().filter(r => r.userId === userId);

  const q = await db.collection(COL_PLAYS)
    .where("userId", "==", String(userId))
    .orderBy("createdAt", "desc")
    .limit(30)
    .get();

  return q.docs.map(d => d.data());
}

/* =====================================================
   ADMIN FUNCTIONS (Firestore)
===================================================== */
async function adminResetClientPassword(clientId, newPass, adminId) {
  const db = getDb();
  if (!newPass || String(newPass).trim().length < 4) return { ok: false, msg: "New password minimum 4 characters" };

  // verify admin (session)
  const admin = currentUser();
  if (!admin || admin.id !== adminId || admin.role !== "admin") return { ok: false, msg: "Unauthorized" };

  if (!db) {
    const ldb = loadDB_local();
    const user = (ldb.users || []).find(u => u.id === clientId && u.role === "user");
    if (!user) return { ok: false, msg: "Client not found" };
    user.passwordHash = await sha256(String(newPass).trim());
    saveDB_local(ldb);
    return { ok: true };
  }

  const ref = db.collection(COL_USERS).doc(String(clientId));
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, msg: "Client not found" };

  const u = snap.data();
  if (u.role !== "user") return { ok: false, msg: "Client not found" };

  await ref.set({ passwordHash: await sha256(String(newPass).trim()) }, { merge: true });
  return { ok: true };
}

async function updateAdminProfile(adminId, name, pass) {
  const db = getDb();
  const admin = currentUser();
  if (!admin || admin.id !== adminId || admin.role !== "admin") return { ok: false, msg: "Unauthorized" };

  const patch = {};
  if (name && String(name).trim()) patch.name = String(name).trim();
  if (pass && String(pass).trim().length >= 4) patch.passwordHash = await sha256(String(pass).trim());

  if (!Object.keys(patch).length) return { ok: false, msg: "Nothing to update" };

  if (!db) {
    const ldb = loadDB_local();
    const a = (ldb.users || []).find(u => u.id === adminId && u.role === "admin");
    if (!a) return { ok: false, msg: "Admin not found" };
    if (patch.name) a.name = patch.name;
    if (patch.passwordHash) a.passwordHash = patch.passwordHash;
    saveDB_local(ldb);
    setSession(a);
    return { ok: true };
  }

  await db.collection(COL_USERS).doc(String(adminId)).set(patch, { merge: true });
  await refreshCurrentUser();
  return { ok: true };
}

async function deleteClient(clientId, adminId) {
  const db = getDb();
  const admin = currentUser();
  if (!admin || admin.id !== adminId || admin.role !== "admin") return { ok: false, msg: "Unauthorized" };
  if (clientId === DEFAULT_ADMIN.id) return { ok: false, msg: "Cannot delete admin" };

  if (!db) {
    const ldb = loadDB_local();
    ldb.users = (ldb.users || []).filter(u => u.id !== clientId);
    ldb.txns = (ldb.txns || []).filter(t => t.userId !== clientId);
    saveDB_local(ldb);
    const plays = loadPlays_local().filter(p => p.userId !== clientId);
    savePlays_local(plays);
    return { ok: true };
  }

  // delete user
  await db.collection(COL_USERS).doc(String(clientId)).delete();

  // txns delete (best-effort)
  const txq = await db.collection(COL_TXNS).where("userId", "==", String(clientId)).limit(200).get();
  const batch1 = db.batch();
  txq.docs.forEach(doc => batch1.delete(doc.ref));
  await batch1.commit();

  // plays delete (best-effort)
  const pq = await db.collection(COL_PLAYS).where("userId", "==", String(clientId)).limit(200).get();
  const batch2 = db.batch();
  pq.docs.forEach(doc => batch2.delete(doc.ref));
  await batch2.commit();

  return { ok: true };
}

async function clearClientHistory(userId, resetWallet = false) {
  const db = getDb();
  if (!db) {
    // local
    const ldb = loadDB_local();
    const u = (ldb.users || []).find(x => x.id === userId);
    if (!u) return { ok: false, msg: "User not found" };
    ldb.txns = (ldb.txns || []).filter(t => t.userId !== userId);
    saveDB_local(ldb);
    const plays = loadPlays_local().filter(p => p.userId !== userId);
    savePlays_local(plays);
    if (resetWallet) { u.points = 0; saveDB_local(ldb); }
    return { ok: true, points: u.points };
  }

  const userRef = db.collection(COL_USERS).doc(String(userId));
  const snap = await userRef.get();
  if (!snap.exists) return { ok: false, msg: "User not found" };

  // delete txns (best-effort)
  const txq = await db.collection(COL_TXNS).where("userId", "==", String(userId)).limit(300).get();
  const b1 = db.batch();
  txq.docs.forEach(d => b1.delete(d.ref));
  await b1.commit();

  // delete plays (best-effort)
  const pq = await db.collection(COL_PLAYS).where("userId", "==", String(userId)).limit(300).get();
  const b2 = db.batch();
  pq.docs.forEach(d => b2.delete(d.ref));
  await b2.commit();

  if (resetWallet) await userRef.set({ points: 0 }, { merge: true });

  const fresh = await getUserById(userId);
  return { ok: true, points: fresh && typeof fresh.points === "number" ? fresh.points : 0 };
}

/* =====================================================
   NOTE:
   - totalAdminCredit / totalWinLoss etc aapke admin.html me
     ab async queries se calculate honge.
===================================================== */
