/* =====================================================
   FIREBASE + CROSS-DEVICE (Spark/Free)
   - Admin creates clients
   - Client logs in from any device using: Phone OR ClientId + Password
===================================================== */

/* ===== Firebase Config ===== */
const firebaseConfig = {
  apiKey: "AIzaSyBZFAk80TlzESxnFNlG0uonVyLj3bQ3PRo",
  authDomain: "wingo-app-f68dd.firebaseapp.com",
  projectId: "wingo-app-f68dd",
  storageBucket: "wingo-app-f68dd.firebasestorage.app",
  messagingSenderId: "533037771285",
  appId: "1:533037771285:web:d72372f86108a8379dbc1c",
  measurementId: "G-RJ1XX4FX3W"
};

let FB_APP = null;
let AUTH = null;
let DB = null;

function initFirebaseOnce() {
  if (FB_APP) return;
  if (!window.firebase) throw new Error("Firebase SDK not loaded");
  FB_APP = firebase.initializeApp(firebaseConfig);
  AUTH = firebase.auth();
  DB = firebase.firestore();
}

/* ===== Helpers ===== */
function nowISO() { return new Date().toISOString(); }
function safeNum(n) { n = Number(n); return Number.isFinite(n) ? n : 0; }
function fmtDate(iso) { try { return new Date(iso).toLocaleString("en-IN"); } catch { return String(iso||"-"); } }
function uid(prefix="C") {
  return prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
}
function isPhone(x){ return /^\d{10}$/.test(String(x||"").trim()); }
function isClientId(x){ return /^C[A-Z0-9]{3,}$/i.test(String(x||"").trim()); }

/* ===== Session cache ===== */
let _PROFILE_CACHE = null;

async function getMyProfile(force=false){
  initFirebaseOnce();
  const u = AUTH.currentUser;
  if (!u) return null;
  if (_PROFILE_CACHE && !force) return _PROFILE_CACHE;

  const snap = await DB.collection("users").doc(u.uid).get();
  if (!snap.exists) return null;
  _PROFILE_CACHE = { uid: u.uid, ...snap.data() };
  return _PROFILE_CACHE;
}

async function requireLogin(){
  initFirebaseOnce();
  const u = AUTH.currentUser;
  if (!u) { window.location.replace("login.html"); return null; }
  const p = await getMyProfile(true);
  if (!p) { window.location.replace("login.html"); return null; }
  return p;
}

async function requireAdmin(){
  const p = await requireLogin();
  if (!p) return null;
  if (p.role !== "admin") { window.location.replace("game.html"); return null; }
  return p;
}

async function logout(){
  initFirebaseOnce();
  _PROFILE_CACHE = null;
  await AUTH.signOut();
  window.location.replace("login.html");
}

/* =====================================================
   AUTH (Cross-device)
   Login by: Phone OR ClientId OR Email
===================================================== */

async function resolveEmailByIdentifier(identifier){
  initFirebaseOnce();
  const id = String(identifier||"").trim();

  // if user typed email directly
  if (id.includes("@")) return id;

  // if ClientId -> fixed email pattern
  if (isClientId(id)) {
    return `${id.toLowerCase()}@jyra.app`;
  }

  // if Phone -> look up user doc by phone and use authEmail
  if (isPhone(id)) {
    const q = await DB.collection("users").where("phone", "==", id).limit(1).get();
    if (q.empty) return null;
    const data = q.docs[0].data();
    return data.authEmail || null;
  }

  return null;
}

async function loginSecure({ phoneOrId, password }){
  initFirebaseOnce();
  const email = await resolveEmailByIdentifier(phoneOrId);
  if (!email) return { ok:false, msg:"User not found (phone/client id not registered)" };

  try{
    const cred = await AUTH.signInWithEmailAndPassword(email, String(password||""));
    _PROFILE_CACHE = null;

    const prof = await getMyProfile(true);
    if (!prof) {
      await AUTH.signOut();
      return { ok:false, msg:"Profile missing in Firestore (admin ko profile create karna hoga)" };
    }

    return { ok:true, user: prof };
  }catch(e){
    const m = (e && e.message) ? e.message : String(e);
    return { ok:false, msg: m.replace("Firebase: ", "") };
  }
}

/* =====================================================
   ADMIN: CREATE CLIENT (without logging out admin)
   Uses secondary Firebase app auth instance
===================================================== */

async function adminCreateClient({ name, phone, password }){
  initFirebaseOnce();

  if (!name || !phone || !password) return { ok:false, msg:"All fields required" };
  if (!isPhone(phone)) return { ok:false, msg:"Phone must be 10 digits" };
  if (String(password).trim().length < 4) return { ok:false, msg:"Password min 4 characters" };

  const admin = await getMyProfile(true);
  if (!admin || admin.role !== "admin") return { ok:false, msg:"Unauthorized" };

  // check phone unique
  const phoneChk = await DB.collection("users").where("phone","==",String(phone)).limit(1).get();
  if (!phoneChk.empty) return { ok:false, msg:"Phone already exists" };

  // create clientId and authEmail
  const clientId = uid("C");
  const authEmail = `${clientId.toLowerCase()}@jyra.app`;

  // secondary app to create auth user without switching admin session
  const secName = "secondary_" + Date.now();
  const secApp = firebase.initializeApp(firebaseConfig, secName);
  const secAuth = secApp.auth();

  try{
    const cred = await secAuth.createUserWithEmailAndPassword(authEmail, String(password));
    const userUid = cred.user.uid;

    await DB.collection("users").doc(userUid).set({
      role: "user",
      name: String(name).trim(),
      phone: String(phone).trim(),
      clientId,
      authEmail,
      points: 0,
      createdAt: nowISO()
    });

    // cleanup
    await secAuth.signOut();
    await secApp.delete();

    return { ok:true, clientId, authEmail, uid: userUid };
  }catch(e){
    try { await secAuth.signOut(); await secApp.delete(); } catch {}
    const m = (e && e.message) ? e.message : String(e);
    return { ok:false, msg: m.replace("Firebase: ", "") };
  }
}

/* =====================================================
   ADMIN: SEARCH / UPDATE POINTS / RESET PASS
===================================================== */

async function findClientByPhoneOrId(q){
  initFirebaseOnce();
  q = String(q||"").trim();

  if (isClientId(q)) {
    const email = `${q.toLowerCase()}@jyra.app`;
    const snap = await DB.collection("users").where("authEmail","==",email).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { uid: d.id, ...d.data() };
  }

  if (isPhone(q)) {
    const snap = await DB.collection("users").where("phone","==",q).limit(1).get();
    if (snap.empty) return null;
    const d = snap.docs[0];
    return { uid: d.id, ...d.data() };
  }

  return null;
}

async function adminAdjustPoints(userUid, delta, note){
  initFirebaseOnce();
  const admin = await getMyProfile(true);
  if (!admin || admin.role !== "admin") return { ok:false, msg:"Unauthorized" };

  const d = Number(delta);
  if (!Number.isFinite(d) || d === 0) return { ok:false, msg:"Invalid points" };

  const userRef = DB.collection("users").doc(userUid);

  try{
    let newPoints = 0;

    await DB.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error("User not found");
      const cur = safeNum(snap.data().points);
      const next = cur + d;
      if (next < 0) throw new Error("Insufficient points");
      newPoints = next;
      tx.update(userRef, { points: next });
    });

    await DB.collection("txns").add({
      userUid,
      type: d >= 0 ? "credit" : "debit",
      amount: Math.abs(d),
      note: String(note||""),
      byAdminUid: admin.uid,
      createdAt: nowISO()
    });

    return { ok:true, points: newPoints };
  }catch(e){
    return { ok:false, msg: (e && e.message) ? e.message : String(e) };
  }
}

async function adminResetClientPasswordByClientId(clientIdOrPhone, newPass){
  initFirebaseOnce();
  const admin = await getMyProfile(true);
  if (!admin || admin.role !== "admin") return { ok:false, msg:"Unauthorized" };
  if (!newPass || String(newPass).trim().length < 4) return { ok:false, msg:"New password min 4 chars" };

  const client = await findClientByPhoneOrId(clientIdOrPhone);
  if (!client) return { ok:false, msg:"Client not found" };

  const secName = "secondary_" + Date.now();
  const secApp = firebase.initializeApp(firebaseConfig, secName);
  const secAuth = secApp.auth();

  try{
    // need to sign in as the user to change password (client SDK limitation)
    // workaround: admin must know user email (we have authEmail) and use "send password reset email"
    // But for custom domain emails like @jyra.app, email still works for reset link.
    await AUTH.sendPasswordResetEmail(client.authEmail);

    await secAuth.signOut();
    await secApp.delete();

    return { ok:true, msg:"Password reset email sent to: " + client.authEmail };
  }catch(e){
    try { await secAuth.signOut(); await secApp.delete(); } catch {}
    return { ok:false, msg: (e && e.message) ? e.message : String(e) };
  }
}

/* =====================================================
   GAME: BET / PLAYS
===================================================== */

async function getMyPoints(){
  const p = await getMyProfile(true);
  return p ? safeNum(p.points) : 0;
}

async function deductMyPoints(amount, note){
  initFirebaseOnce();
  const p = await getMyProfile(true);
  if (!p) return { ok:false, msg:"Not logged in" };

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok:false, msg:"Invalid amount" };

  const userRef = DB.collection("users").doc(p.uid);
  try{
    let after = 0;
    await DB.runTransaction(async (tx)=>{
      const snap = await tx.get(userRef);
      const cur = safeNum(snap.data().points);
      const next = cur - amt;
      if (next < 0) throw new Error("Insufficient points");
      after = next;
      tx.update(userRef, { points: next });
    });
    _PROFILE_CACHE = null;
    return { ok:true, after };
  }catch(e){
    return { ok:false, msg: (e && e.message) ? e.message : String(e) };
  }
}

async function addMyPoints(amount, note){
  initFirebaseOnce();
  const p = await getMyProfile(true);
  if (!p) return { ok:false, msg:"Not logged in" };

  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok:false, msg:"Invalid amount" };

  const userRef = DB.collection("users").doc(p.uid);
  try{
    let after = 0;
    await DB.runTransaction(async (tx)=>{
      const snap = await tx.get(userRef);
      const cur = safeNum(snap.data().points);
      const next = cur + amt;
      after = next;
      tx.update(userRef, { points: next });
    });
    _PROFILE_CACHE = null;
    return { ok:true, after };
  }catch(e){
    return { ok:false, msg: (e && e.message) ? e.message : String(e) };
  }
}

async function addPlayRow(row){
  initFirebaseOnce();
  const p = await getMyProfile(true);
  if (!p) return { ok:false, msg:"Not logged in" };

  const doc = {
    ...row,
    userUid: p.uid,
    createdAt: row.createdAt || nowISO()
  };
  await DB.collection("plays").add(doc);
  return { ok:true };
}

async function playsForMe(limit=30){
  initFirebaseOnce();
  const p = await getMyProfile(true);
  if (!p) return [];
  const q = await DB.collection("plays")
    .where("userUid","==",p.uid)
    .orderBy("createdAt","desc")
    .limit(limit)
    .get();
  return q.docs.map(d=>({ id:d.id, ...d.data() }));
}
