/* =====================================================
   FIREBASE CONFIG  (अपना config paste करो)
===================================================== */
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "wingo-app-f68dd.firebaseapp.com",
  projectId: "wingo-app-f68dd",
  storageBucket: "wingo-app-f68dd.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();

// ✅ Secondary app (admin client create ke time) - admin logout nahi hota
const secondaryApp = firebase.initializeApp(firebaseConfig, "Secondary");
const secondaryAuth = secondaryApp.auth();

/* =====================================================
   CONFIG / DEFAULT ADMIN
   - Admin ko Firebase Console -> Authentication -> Add user se banana best
   - Email: admin@jyra.app   Password: Jay@1803
===================================================== */
const DEFAULT_ADMIN = {
  email: "admin@jyra.app",
  password: "Jay@1803",
  name: "Admin",
  phone: "9316740061",
};

/* =====================================================
   HELPERS
===================================================== */
function nowISO() { return new Date().toISOString(); }
function uid(prefix = "X") { return prefix + Math.random().toString(36).slice(2, 10).toUpperCase(); }
function $(id) { return document.getElementById(id); }

function clientEmail(clientId) {
  return String(clientId || "").trim().toLowerCase() + "@jyra.app";
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString("en-IN"); }
  catch { return String(iso || "-"); }
}

/* =====================================================
   GLOBAL CACHE (sync style functions ke liye)
===================================================== */
let CURRENT_PROFILE = null;      // {uid, role, clientId, name, phone, points...}
let AUTH_READY = false;

function currentUser() {
  return CURRENT_PROFILE;
}

/* =====================================================
   AUTH STATE LISTENER
   - login ke baad profile Firestore se load hota hai
===================================================== */
auth.onAuthStateChanged(async (user) => {
  AUTH_READY = true;
  if (!user) {
    CURRENT_PROFILE = null;
    return;
  }

  const ref = db.collection("users").doc(user.uid);
  const snap = await ref.get();

  // ✅ agar profile missing hai:
  // (1) Admin user ho (admin@jyra.app) to admin profile auto create
  // (2) warna login.html par bhej do (profile required)
  if (!snap.exists) {
    if ((user.email || "").toLowerCase() === DEFAULT_ADMIN.email.toLowerCase()) {
      const adminProfile = {
        uid: user.uid,
        role: "admin",
        clientId: "ADMIN1",
        name: DEFAULT_ADMIN.name,
        phone: DEFAULT_ADMIN.phone,
        points: 0,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      };
      // NOTE: is write ke liye rules me allow chahiye (neeche rules diya hai)
      await ref.set(adminProfile, { merge: true });
      CURRENT_PROFILE = adminProfile;
      return;
    } else {
      // profile nahi hai -> safe logout
      await auth.signOut();
      CURRENT_PROFILE = null;
      return;
    }
  }

  CURRENT_PROFILE = snap.data();
});

/* =====================================================
   SESSION / LOGOUT
===================================================== */
function logout() {
  auth.signOut().then(() => {
    window.location.replace("login.html");
  });
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
   LOGIN (ClientId + Password)
   - clientId ko email me convert karke login
===================================================== */
async function loginSecure({ phoneOrId, password }) {
  const clientId = String(phoneOrId || "").trim();
  if (!clientId || !password) return { ok: false, msg: "Client ID & password required" };

  const email = clientEmail(clientId);

  try {
    const cred = await auth.signInWithEmailAndPassword(email, String(password));
    const uid = cred.user.uid;

    // profile load hone do
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) {
      await auth.signOut();
      return { ok: false, msg: "Profile missing. Admin se bolo user create kare." };
    }

    return { ok: true, user: snap.data() };
  } catch (e) {
    return { ok: false, msg: e.message || "Login failed" };
  }
}

/* =====================================================
   ADMIN: CREATE CLIENT (सबसे जरूरी)
   - Admin panel se call hoga
   - Secondary Auth se user create (admin logout nahi hoga)
   - Fir admin Firestore me users/{uid} profile create karega
===================================================== */
async function registerUserSecure({ name, phone, password, clientId }) {
  const admin = requireAdmin();
  if (!admin) return { ok: false, msg: "Unauthorized" };

  name = String(name || "").trim();
  phone = String(phone || "").trim();
  password = String(password || "").trim();
  clientId = String(clientId || "").trim().toLowerCase();

  if (!name || !phone || !password || !clientId) return { ok: false, msg: "All fields required" };
  if (!/^\d{10}$/.test(phone)) return { ok: false, msg: "Phone must be 10 digits" };
  if (password.length < 4) return { ok: false, msg: "Password min 4 characters" };

  const email = clientEmail(clientId);

  try {
    // 1) Create auth user (secondary app)
    const cred = await secondaryAuth.createUserWithEmailAndPassword(email, password);
    const uidNew = cred.user.uid;

    // 2) Create Firestore profile (admin as primary auth)
    const profile = {
      uid: uidNew,
      role: "user",
      clientId: clientId,
      name,
      phone,
      points: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };

    await db.collection("users").doc(uidNew).set(profile, { merge: true });

    // 3) secondary user signout (clean)
    await secondaryAuth.signOut();

    return { ok: true, user: profile };
  } catch (e) {
    try { await secondaryAuth.signOut(); } catch {}
    return { ok: false, msg: e.message || "Create client failed" };
  }
}

/* =====================================================
   ADMIN: RESET CLIENT PASSWORD
   - Secondary auth me direct reset nahi hota (secure way: email reset)
   - Simple: Firebase reset email bhejo
===================================================== */
async function adminResetClientPassword(clientId, adminId) {
  const admin = requireAdmin();
  if (!admin) return { ok: false, msg: "Unauthorized" };
  if (admin.uid !== adminId && admin.clientId !== adminId) {
    // ignore mismatch, admin is already verified
  }

  const email = clientEmail(clientId);

  try {
    await auth.sendPasswordResetEmail(email);
    return { ok: true, msg: "Reset email sent to: " + email };
  } catch (e) {
    return { ok: false, msg: e.message || "Reset failed" };
  }
}

/* =====================================================
   ADMIN: POINTS + TXNS (Secure)
===================================================== */
async function adjustPoints(userId, delta, note, byAdminId = null) {
  const admin = requireAdmin();
  if (!admin) return { ok: false, msg: "Unauthorized" };

  const d = Number(delta);
  if (!Number.isFinite(d)) return { ok: false, msg: "Invalid points" };

  const userRef = db.collection("users").doc(userId);
  const txnRef = db.collection("txns").doc(uid("T"));

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("User not found");

      const u = snap.data();
      const cur = Number(u.points || 0);
      const next = cur + d;
      if (next < 0) throw new Error("Insufficient points");

      tx.update(userRef, { points: next, updatedAt: nowISO() });

      tx.set(txnRef, {
        id: txnRef.id,
        userId,
        type: d >= 0 ? "credit" : "debit",
        amount: Math.abs(d),
        note: note || "",
        byAdminId: admin.clientId || admin.uid,
        createdAt: nowISO(),
      });
    });

    const after = await userRef.get();
    return { ok: true, points: after.data().points };
  } catch (e) {
    return { ok: false, msg: e.message || "Points update failed" };
  }
}

async function userTxns(userId) {
  const q = await db.collection("txns")
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(200)
    .get();
  return q.docs.map(d => d.data());
}

/* =====================================================
   PLAY HISTORY (Firestore)
   - game/admin dono use kar sakte
===================================================== */
async function addPlayRow(row) {
  const id = row.id || uid("P");
  row.id = id;
  if (!row.createdAt) row.createdAt = nowISO();
  await db.collection("plays").doc(id).set(row, { merge: true });
}

async function playsForUser(userId) {
  const q = await db.collection("plays")
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(30)
    .get();
  return q.docs.map(d => d.data());
}

/* =====================================================
   BETS (Client submit; admin resolve)
===================================================== */
async function createBet({ uid, clientId, betType, betValue, betLabel, betAmount, period, modeSec }) {
  const id = uid ? ("B" + Math.random().toString(36).slice(2, 10).toUpperCase()) : uid("B");
  await db.collection("bets").doc(id).set({
    id,
    uid,
    clientId,
    betType,
    betValue,
    betLabel,
    betAmount: Number(betAmount || 0),
    period,
    modeSec,
    modeLabel: modeSec === 60 ? "1 Min" : "3 Min",
    status: "PENDING",
    createdAt: nowISO(),
  }, { merge: true });

  return { ok: true, id };
}
