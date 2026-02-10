/* =====================================================
   CONFIG
===================================================== */
const SESSION_KEY = "club_session_v1";

const COL_USERS = "users";
const COL_TXNS  = "txns";
const COL_PLAYS = "plays";

// ✅ Your fixed admin credentials
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
function getDb() {
  if (window.db && window.firebase && window.firebase.firestore) return window.db;
  return null;
}

async function ensureAdminInFirestore() {
  const db = getDb();
  if (!db) throw new Error("Firestore not ready");

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
   SESSION (store full user for no-blank pages)
===================================================== */
function setSession(userObj) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    userId: userObj.id,
    user: userObj,
    at: nowISO()
  }));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function currentUser() {
  const sess = getSession();
  if (!sess || !sess.userId) return null;
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
   DATABASE
===================================================== */
async function getUserById(userId) {
  const db = getDb();
  await ensureAdminInFirestore();
  const snap = await db.collection(COL_USERS).doc(String(userId)).get();
  return snap.exists ? snap.data() : null;
}

async function findUserByPhoneOrId(phoneOrId) {
  const db = getDb();
  await ensureAdminInFirestore();

  const key = String(phoneOrId || "").trim();
  if (!key) return null;

  // Try ID as doc first
  const byId = await db.collection(COL_USERS).doc(key).get();
  if (byId.exists) return byId.data();

  // Else try phone
  const q = await db.collection(COL_USERS).where("phone", "==", key).limit(1).get();
  if (!q.empty) return q.docs[0].data();

  return null;
}

async function listClients() {
  const db = getDb();
  await ensureAdminInFirestore();

  const q = await db.collection(COL_USERS).where("role", "==", "user").orderBy("createdAt", "desc").limit(500).get();
  return q.docs.map(d => d.data());
}

/* =====================================================
   AUTH
===================================================== */
async function loginSecure({ phoneOrId, password }) {
  const user = await findUserByPhoneOrId(phoneOrId);
  if (!user) return { ok: false, msg: "User not found" };

  // Admin hash safety
  if (user.role === "admin" && !user.passwordHash) {
    const db = getDb();
    const adminHash = await sha256(DEFAULT_ADMIN.password);
    await db.collection(COL_USERS).doc(user.id).set({ passwordHash: adminHash }, { merge: true });
    user.passwordHash = adminHash;
  }

  const hash = await sha256(password);
  if (user.passwordHash !== hash) return { ok: false, msg: "Wrong password" };

  setSession(user);
  return { ok: true, user };
}

async function registerUserSecure({ name, phone, password }) {
  const db = getDb();
  await ensureAdminInFirestore();

  if (!name || !phone || !password) return { ok: false, msg: "All fields required" };
  if (!/^\d{10}$/.test(String(phone))) return { ok: false, msg: "Phone must be 10 digits" };

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
   POINTS + TRANSACTIONS (Atomic)
===================================================== */
async function adjustPoints(userId, delta, note, byAdminId = null) {
  const db = getDb();
  await ensureAdminInFirestore();

  const d = Number(delta);
  if (!Number.isFinite(d)) return { ok: false, msg: "Invalid points" };

  const userRef = db.collection(COL_USERS).doc(String(userId));
  const txnRef  = db.collection(COL_TXNS).doc(uid("T"));

  try {
    const newPoints = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("User not found");

      const u = snap.data();
      const cur = (typeof u.points === "number") ? u.points : 0;
      const next = cur + d;
      if (next < 0) throw new Error("Insufficient points");

      tx.update(userRef, { points: next });

      tx.set(txnRef, {
        id: txnRef.id,
        userId: String(userId),
        type: d >= 0 ? "credit" : "debit",
        amount: Math.abs(d),
        note: note || "",
        byAdminId: byAdminId || null,
        createdAt: nowISO()
      });

      return next;
    });

    // Update cached session if same user
    const sess = getSession();
    if (sess && sess.userId === userId) {
      const fresh = await getUserById(userId);
      if (fresh) setSession(fresh);
    }

    return { ok: true, points: newPoints };
  } catch (e) {
    return { ok: false, msg: e?.message || "Update failed" };
  }
}

async function userTxns(userId) {
  const db = getDb();
  await ensureAdminInFirestore();

  const q = await db.collection(COL_TXNS)
    .where("userId", "==", String(userId))
    .orderBy("createdAt", "desc")
    .limit(500)
    .get();

  return q.docs.map(d => d.data());
}

/* =====================================================
   PLAY HISTORY
===================================================== */
async function addPlayRow(row) {
  const db = getDb();
  await ensureAdminInFirestore();

  if (!row.createdAt) row.createdAt = nowISO();
  if (!row.id) row.id = uid("P");

  await db.collection(COL_PLAYS).doc(String(row.id)).set(row, { merge: true });
  return { ok: true };
}

async function playsForUser(userId) {
  const db = getDb();
  await ensureAdminInFirestore();

  const q = await db.collection(COL_PLAYS)
    .where("userId", "==", String(userId))
    .orderBy("createdAt", "desc")
    .limit(30)
    .get();

  return q.docs.map(d => d.data());
}

/* =====================================================
   ADMIN FUNCTIONS
===================================================== */
async function adminResetClientPassword(clientId, newPass, adminId) {
  const db = getDb();
  await ensureAdminInFirestore();

  const admin = currentUser();
  if (!admin || admin.id !== adminId || admin.role !== "admin") return { ok: false, msg: "Unauthorized" };

  const np = String(newPass || "").trim();
  if (np.length < 4) return { ok: false, msg: "New password minimum 4 characters" };

  const ref = db.collection(COL_USERS).doc(String(clientId));
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, msg: "Client not found" };

  const u = snap.data();
  if (u.role !== "user") return { ok: false, msg: "Client not found" };

  await ref.set({ passwordHash: await sha256(np) }, { merge: true });
  return { ok: true };
}

async function updateAdminProfile(adminId, name, pass) {
  const db = getDb();
  await ensureAdminInFirestore();

  const admin = currentUser();
  if (!admin || admin.id !== adminId || admin.role !== "admin") return { ok: false, msg: "Unauthorized" };

  const patch = {};
  if (name && String(name).trim()) patch.name = String(name).trim();
  if (pass && String(pass).trim().length >= 4) patch.passwordHash = await sha256(String(pass).trim());

  if (!Object.keys(patch).length) return { ok: false, msg: "Nothing to update" };

  await db.collection(COL_USERS).doc(String(adminId)).set(patch, { merge: true });
  await refreshCurrentUser();
  return { ok: true };
}

async function deleteClient(clientId, adminId) {
  const db = getDb();
  await ensureAdminInFirestore();

  const admin = currentUser();
  if (!admin || admin.id !== adminId || admin.role !== "admin") return { ok: false, msg: "Unauthorized" };
  if (clientId === DEFAULT_ADMIN.id) return { ok: false, msg: "Cannot delete admin" };

  await db.collection(COL_USERS).doc(String(clientId)).delete();

  // best-effort deletes (limits)
  const txq = await db.collection(COL_TXNS).where("userId", "==", String(clientId)).limit(300).get();
  const b1 = db.batch();
  txq.docs.forEach(doc => b1.delete(doc.ref));
  await b1.commit();

  const pq = await db.collection(COL_PLAYS).where("userId", "==", String(clientId)).limit(300).get();
  const b2 = db.batch();
  pq.docs.forEach(doc => b2.delete(doc.ref));
  await b2.commit();

  return { ok: true };
}

async function clearClientHistory(userId, resetWallet = false) {
  const db = getDb();
  await ensureAdminInFirestore();

  const userRef = db.collection(COL_USERS).doc(String(userId));
  const snap = await userRef.get();
  if (!snap.exists) return { ok: false, msg: "User not found" };

  const txq = await db.collection(COL_TXNS).where("userId", "==", String(userId)).limit(300).get();
  const b1 = db.batch();
  txq.docs.forEach(d => b1.delete(d.ref));
  await b1.commit();

  const pq = await db.collection(COL_PLAYS).where("userId", "==", String(userId)).limit(300).get();
  const b2 = db.batch();
  pq.docs.forEach(d => b2.delete(d.ref));
  await b2.commit();

  if (resetWallet) await userRef.set({ points: 0 }, { merge: true });

  const fresh = await getUserById(userId);
  return { ok: true, points: fresh?.points || 0 };
}
