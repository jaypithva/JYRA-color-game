/*********************************************************
 * admin-app.js — FULL WORKING ADMIN LOGIC
 * Firebase Firestore (compat)
 *********************************************************/

if (!firebase.apps.length) {
  firebase.initializeApp(window.firebaseConfig);
}
const db = firebase.firestore();

/* ================== HELPERS ================== */

function nowISO() {
  return new Date().toISOString();
}

function sha256(str) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(str))
    .then(buf => Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0")).join(""));
}

function fmtDate(v) {
  if (!v) return "-";
  try {
    if (v.toDate) return v.toDate().toLocaleString();
    return new Date(v).toLocaleString();
  } catch {
    return "-";
  }
}

/* ================== AUTH CHECK ================== */

async function requireAdminAsync() {
  const raw = localStorage.getItem("ADMIN_SESSION");
  if (!raw) {
    alert("Admin login required");
    location.href = "login.html";
    return null;
  }
  const admin = JSON.parse(raw);
  if (admin.role !== "admin") {
    alert("Unauthorized");
    location.href = "login.html";
    return null;
  }
  return admin;
}

function logout() {
  localStorage.removeItem("ADMIN_SESSION");
  location.href = "login.html";
}

/* ================== USERS ================== */

async function listUsers() {
  const snap = await db.collection("users").get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function getUserByIdFS(uid) {
  const d = await db.collection("users").doc(uid).get();
  return d.exists ? { id: d.id, ...d.data() } : null;
}

/* ================== ADMIN ================== */

async function updateAdminProfile(uid, name, pass) {
  const upd = {};
  if (name) upd.name = name;
  if (pass && pass.length >= 4) upd.passwordHash = await sha256(pass);
  if (!Object.keys(upd).length) return { ok: false, msg: "Nothing to update" };
  upd.updatedAt = nowISO();
  await db.collection("users").doc(uid).update(upd);
  return { ok: true };
}

/* ================== CLIENT CREATE ================== */

async function adminCreateClient({ name, phone, password }, adminId) {
  if (!name || !phone || !password)
    return { ok: false, msg: "All fields required" };
  if (password.length < 4)
    return { ok: false, msg: "Password min 4 chars" };

  const clientId = "C" + Math.floor(10000 + Math.random() * 90000);
  const hash = await sha256(password);

  await db.collection("users").doc(clientId).set({
    clientId,
    name,
    phone,
    passwordHash: hash,
    role: "user",
    points: 0,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    createdBy: adminId
  });

  return { ok: true, user: { id: clientId } };
}

/* ================== WALLET ================== */

async function adjustPoints(uid, delta, reason, adminId) {
  const ref = db.collection("users").doc(uid);

  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw "User not found";

    const before = snap.data().points || 0;
    const after = before + delta;
    if (after < 0) throw "Insufficient balance";

    tx.update(ref, { points: after, updatedAt: nowISO() });

    tx.set(ref.collection("txns").doc(), {
      before,
      after,
      delta,
      reason,
      by: adminId,
      createdAt: nowISO()
    });

    return { ok: true, points: after };
  });
}

/* ================== PASSWORD RESET ================== */

async function adminResetClientPassword(uid, pass, adminId) {
  if (!pass || pass.length < 4)
    return { ok: false, msg: "Min 4 chars" };

  const hash = await sha256(pass);
  await db.collection("users").doc(uid).update({
    passwordHash: hash,
    updatedAt: nowISO(),
    resetBy: adminId
  });
  return { ok: true };
}

/* ================== HISTORY ================== */

async function playsForUser(uid, limit = 30) {
  const snap = await db.collection("users")
    .doc(uid)
    .collection("plays")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snap.docs.map(d => d.data());
}

async function clearClientHistory(uid, resetWallet, adminId) {
  const ref = db.collection("users").doc(uid);
  const plays = await ref.collection("plays").get();
  const batch = db.batch();

  plays.forEach(d => batch.delete(d.ref));
  if (resetWallet) batch.update(ref, { points: 0 });

  await batch.commit();
  return { ok: true };
}

/* ================== DELETE CLIENT ================== */

async function deleteClient(uid, adminId) {
  const ref = db.collection("users").doc(uid);

  const sub = ["plays", "txns"];
  for (const c of sub) {
    const snap = await ref.collection(c).get();
    const batch = db.batch();
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  await ref.delete();
  return { ok: true };
}
