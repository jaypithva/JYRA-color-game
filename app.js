/* =====================================================
   Firebase + Cross-device DB (Auth + Firestore)
   - Free Spark plan compatible
   - Admin creates clients
   - Client can login any device
===================================================== */

/* ========= CONFIG ========= */
const DEFAULT_ADMIN = {
  id: "ADMIN1",
  role: "admin",
  name: "Admin",
  phone: "9316740061",
  email: "admin@wingo.local",     // ✅ you will create this user in Firebase Auth once
  password: "Jay@1803"
};

function nowISO() { return new Date().toISOString(); }
function uid(p = "U") { return p + Math.random().toString(36).slice(2, 9).toUpperCase(); }
function safeNum(n) { n = Number(n); return Number.isFinite(n) ? n : 0; }
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString("en-IN"); } catch (e) { return String(iso || "-"); }
}

/* ========= SHA-256 ========= */
async function sha256(text) {
  const enc = new TextEncoder().encode(String(text));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ========= Firebase init (Compat SDK) ========= */
function ensureFirebase() {
  if (typeof firebase === "undefined") throw new Error("Firebase SDK not loaded");
  if (!window.firebaseConfig) throw new Error("window.firebaseConfig missing");

  if (!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);

  const auth = firebase.auth();
  const db = firebase.firestore();

  // Keep login across refresh
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

  return { auth, db };
}

/* ========= Collections ========= */
function usersCol(db) { return db.collection("users"); }
function txnsCol(db) { return db.collection("txns"); }
function playsCol(db) { return db.collection("plays"); }

/* ========= Session cache (fast sync access for UI) ========= */
const SESSION_USER_KEY = "club_session_user_v2";

function setCachedUser(userObj) {
  sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(userObj || null));
}
function getCachedUser() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_USER_KEY)); } catch (e) { return null; }
}
function clearCachedUser() {
  sessionStorage.removeItem(SESSION_USER_KEY);
}

/* ========= Current User Helpers ========= */
async function fetchProfileByUid(uid) {
  const { db } = ensureFirebase();
  const snap = await usersCol(db).where("authUid", "==", uid).limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

function currentUser() {
  return getCachedUser();
}

async function requireLoginAsync() {
  const u = currentUser();
  if (u) return u;
  window.location.replace("login.html");
  return null;
}

async function requireAdminAsync() {
  const u = await requireLoginAsync();
  if (!u || u.role !== "admin") {
    window.location.replace("login.html");
    return null;
  }
  return u;
}

async function logout() {
  try {
    const { auth } = ensureFirebase();
    await auth.signOut();
  } catch (e) {}
  clearCachedUser();
  window.location.replace("login.html");
}

/* ========= Auth State Listener ========= */
async function startAuthListener() {
  const { auth } = ensureFirebase();

  auth.onAuthStateChanged(async (fbUser) => {
    if (!fbUser) {
      clearCachedUser();
      return;
    }
    const prof = await fetchProfileByUid(fbUser.uid);
    if (prof) setCachedUser(prof);
  });
}

/* ========= Resolve input -> email ========= */
async function resolveEmailFromPhoneOrId(phoneOrId) {
  const { db } = ensureFirebase();
  const q = String(phoneOrId || "").trim();

  // admin shortcuts
  if (q === DEFAULT_ADMIN.id || q === DEFAULT_ADMIN.phone) {
    return DEFAULT_ADMIN.email;
  }

  // phone
  if (/^\d{10}$/.test(q)) {
    const snap = await usersCol(db).where("phone", "==", q).limit(1).get();
    if (snap.empty) return null;
    return snap.docs[0].data().email || null;
  }

  // clientId (doc id)
  const doc = await usersCol(db).doc(q).get();
  if (!doc.exists) return null;
  return (doc.data() && doc.data().email) ? doc.data().email : null;
}

/* ========= LOGIN ========= */
async function loginSecure({ phoneOrId, password }) {
  const { auth } = ensureFirebase();
  const email = await resolveEmailFromPhoneOrId(phoneOrId);
  if (!email) return { ok: false, msg: "User not found" };

  try {
    await auth.signInWithEmailAndPassword(email, String(password || ""));
    const prof = await fetchProfileByUid(auth.currentUser.uid);
    if (!prof) return { ok: false, msg: "Profile missing in Firestore" };
    setCachedUser(prof);
    return { ok: true, user: prof };
  } catch (e) {
    return { ok: false, msg: "Wrong password" };
  }
}

/* ========= ADMIN: Create Client (Auth user via Secondary App) ========= */
async function createClientSecureByAdmin({ name, phone, password }) {
  const admin = await requireAdminAsync();
  if (!admin) return { ok: false, msg: "Unauthorized" };

  name = String(name || "").trim();
  phone = String(phone || "").trim();
  password = String(password || "");

  if (!name || !phone || !password) return { ok: false, msg: "All fields required" };
  if (!/^\d{10}$/.test(phone)) return { ok: false, msg: "Phone must be 10 digits" };
  if (password.trim().length < 4) return { ok: false, msg: "Password minimum 4 characters" };

  const { db } = ensureFirebase();

  // phone already exists?
  const exists = await usersCol(db).where("phone", "==", phone).limit(1).get();
  if (!exists.empty) return { ok: false, msg: "Phone already exists" };

  const clientId = uid("C");
  const email = `${clientId}@wingo.local`; // internal email for login

  // Secondary app to create user without logging out admin
  let secondary;
  try {
    secondary = firebase.apps.find(a => a.name === "Secondary") || firebase.initializeApp(window.firebaseConfig, "Secondary");
  } catch (e) {
    secondary = firebase.app("Secondary");
  }

  try {
    const cred = await secondary.auth().createUserWithEmailAndPassword(email, password);
    const authUid = cred.user.uid;

    // Store profile in Firestore
    await usersCol(db).doc(clientId).set({
      role: "user",
      name,
      phone,
      email,
      authUid,
      points: 0,
      createdAt: nowISO()
    });

    // cleanup secondary session (optional)
    try { await secondary.auth().signOut(); } catch (e) {}

    return { ok: true, user: { id: clientId, role: "user", name, phone, email, authUid, points: 0 } };
  } catch (e) {
    const msg = (e && e.message) ? e.message : "Create failed";
    return { ok: false, msg };
  }
}

/* ========= POINTS + TXNS (Firestore) ========= */
async function adjustPoints(userId, delta, note, byAdminId = null) {
  const { db } = ensureFirebase();
  const d = Number(delta);
  if (!Number.isFinite(d)) return { ok: false, msg: "Invalid points" };

  const userRef = usersCol(db).doc(userId);

  try {
    const res = await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      if (!snap.exists) throw new Error("User not found");

      const u = snap.data();
      const cur = (typeof u.points === "number") ? u.points : 0;
      const next = cur + d;
      if (next < 0) throw new Error("Insufficient points");

      t.update(userRef, { points: next });

      const txnRef = txnsCol(db).doc(uid("T"));
      t.set(txnRef, {
        id: txnRef.id,
        userId,
        type: d >= 0 ? "credit" : "debit",
        amount: Math.abs(d),
        note: note || "",
        byAdminId: byAdminId || null,
        createdAt: nowISO()
      });

      return next;
    });

    // if current cached user updated, refresh
    const cu = currentUser();
    if (cu && cu.id === userId) {
      cu.points = res;
      setCachedUser(cu);
    }
    return { ok: true, points: res };
  } catch (e) {
    return { ok: false, msg: (e && e.message) ? e.message : "Update failed" };
  }
}

async function userTxns(userId) {
  const { db } = ensureFirebase();
  const snap = await txnsCol(db).where("userId", "==", userId).orderBy("createdAt", "desc").get();
  return snap.docs.map(d => d.data());
}

/* ========= PLAYS (Firestore) ========= */
async function addPlayRow(row) {
  const { db } = ensureFirebase();
  if (!row.createdAt) row.createdAt = nowISO();
  const ref = playsCol(db).doc(uid("P"));
  await ref.set({ ...row, id: ref.id });
  return { ok: true };
}

async function playsForUser(userId, limit = 30) {
  const { db } = ensureFirebase();
  const snap = await playsCol(db)
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map(d => d.data());
}

/* ========= ADMIN helpers ========= */
async function listAllClients() {
  const { db } = ensureFirebase();
  const snap = await usersCol(db).where("role", "==", "user").orderBy("createdAt", "desc").get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function findClientByIdOrPhone(q) {
  const { db } = ensureFirebase();
  q = String(q || "").trim();
  if (!q) return null;

  if (/^\d{10}$/.test(q)) {
    const s = await usersCol(db).where("phone", "==", q).limit(1).get();
    if (s.empty) return null;
    const doc = s.docs[0];
    return { id: doc.id, ...doc.data() };
  }

  const doc = await usersCol(db).doc(q).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function deleteClient(clientId) {
  const admin = await requireAdminAsync();
  if (!admin) return { ok: false, msg: "Unauthorized" };
  if (clientId === DEFAULT_ADMIN.id) return { ok: false, msg: "Cannot delete admin" };

  const { db } = ensureFirebase();
  const userDoc = await usersCol(db).doc(clientId).get();
  if (!userDoc.exists) return { ok: false, msg: "Client not found" };

  // delete Firestore docs (profile + txns + plays)
  await usersCol(db).doc(clientId).delete();

  // delete txns + plays (best effort)
  const tx = await txnsCol(db).where("userId", "==", clientId).get();
  const pl = await playsCol(db).where("userId", "==", clientId).get();

  const batch = db.batch();
  tx.docs.forEach(d => batch.delete(d.ref));
  pl.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();

  // NOTE: Auth user deletion needs Admin SDK/Functions (paid). We'll keep it.
  return { ok: true };
}

async function updateAdminProfile(adminId, name, pass) {
  const admin = await requireAdminAsync();
  if (!admin) return { ok: false, msg: "Unauthorized" };

  name = String(name || "").trim();
  pass = String(pass || "").trim();

  const { db, auth } = ensureFirebase();
  const me = currentUser();
  if (!me || me.id !== adminId) return { ok: false, msg: "Admin not found" };

  if (name) {
    await usersCol(db).doc(adminId).update({ name });
  }
  if (pass && pass.length >= 4) {
    // change auth password for currently logged in admin
    try {
      await auth.currentUser.updatePassword(pass);
    } catch (e) {
      return { ok: false, msg: "Password change requires recent login. Logout & login then try." };
    }
  }

  const refreshed = await findClientByIdOrPhone(adminId);
  if (refreshed) setCachedUser(refreshed);
  return { ok: true };
}

/* ========= Boot ========= */
try { startAuthListener(); } catch (e) {}
