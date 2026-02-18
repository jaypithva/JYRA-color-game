/* JVBET - Firebase Version (Firestore + Auth)
   - users collection: users/{clientId}  (example: users/ADMIN1)
   - bets collection: bets/{autoId}
   - Works on all devices (cloud sync)
*/

import { auth, db } from "./firebase-init.js";

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  limit,
  serverTimestamp,
  orderBy
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* -------------------- SESSION (local quick cache) -------------------- */
const K_SESSION = "jvbet_session_v2";
let _session = null;
let _me = null; // cached profile from Firestore

function safe(v) { return (v === null || v === undefined) ? "" : String(v); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export function getSession() {
  if (_session) return _session;
  try {
    const raw = localStorage.getItem(K_SESSION);
    _session = raw ? JSON.parse(raw) : null;
  } catch (e) {
    _session = null;
  }
  return _session;
}

export function setSession(s) {
  _session = s || null;
  localStorage.setItem(K_SESSION, JSON.stringify(_session));
}

export async function logout() {
  try { await signOut(auth); } catch(e) {}
  _me = null;
  setSession(null);
}

/* -------------------- FIRESTORE USERS -------------------- */
// users/{clientId}
function userRef(clientId) {
  return doc(db, "users", safe(clientId).trim());
}

async function getUserByUID(uid) {
  // query users where uid == currentUser.uid
  const q = query(collection(db, "users"), where("uid", "==", uid), limit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

export async function getMeClient() {
  // cached
  if (_me) return _me;

  const s = getSession();
  if (s && s.clientId) {
    const d = await getDoc(userRef(s.clientId));
    if (d.exists()) {
      _me = { clientId: d.id, ...d.data() };
      return _me;
    }
  }

  const u = auth.currentUser;
  if (!u) throw new Error("No session. Please login.");

  const me = await getUserByUID(u.uid);
  if (!me) throw new Error("Profile not found in Firestore (users).");

  _me = { clientId: me.id, ...me };

  // store session
  setSession({ clientId: _me.clientId, role: _me.role || "client", uid: u.uid });
  return _me;
}

/* -------------------- LOGIN -------------------- */
// Firebase Auth Login (Email/Password)
export async function doLogin(email, password) {
  email = safe(email).trim();
  password = safe(password);

  if (!email || !password) throw new Error("Enter Email & Password");

  const cred = await signInWithEmailAndPassword(auth, email, password);

  const u = cred.user;
  const me = await getUserByUID(u.uid);
  if (!me) throw new Error("Your user profile is missing in Firestore (users).");

  _me = { clientId: me.id, ...me };
  setSession({ clientId: _me.clientId, role: _me.role || "client", uid: u.uid });

  if (_me.isBlocked) throw new Error("Account blocked");
  return getSession();
}

/* -------------------- GUARDS -------------------- */
export async function requireAdmin() {
  const me = await getMeClient();
  if ((me.role || "").toLowerCase() !== "admin") {
    location.href = "../index.html";
    throw new Error("Admin only");
  }
  return true;
}

export async function requireClient() {
  const me = await getMeClient();
  if ((me.role || "").toLowerCase() === "admin") {
    location.href = "../index.html";
    throw new Error("Client only");
  }
  return true;
}

/* -------------------- ADMIN ACTIONS (Firestore) -------------------- */
export async function adminCreateClient(input) {
  await requireAdmin();

  const clientId = safe(input.clientId).trim();
  const phone = safe(input.phone).trim();
  const name = safe(input.name).trim();
  const points = num(input.points);
  const password = safe(input.password).trim(); // demo: store plain OR hash (see note)

  if (!clientId) throw new Error("Client ID required");
  if (!password) throw new Error("Password required");

  // check exists
  const ex = await getDoc(userRef(clientId));
  if (ex.exists()) throw new Error("Client ID already exists");

  // check phone exists
  if (phone) {
    const q = query(collection(db, "users"), where("phone", "==", phone), limit(1));
    const snap = await getDocs(q);
    if (!snap.empty) throw new Error("Phone already exists");
  }

  // NOTE: Auth user create yaha frontend se safe nahi (admin logout ho jayega)
  // Isliye yaha Firestore profile create kar rahe hai.
  // Login ko Email/Pass chahiye to Cloud Function / Admin SDK chahiye.

  await setDoc(userRef(clientId), {
    clientId,
    phone,
    name,
    role: "client",
    points,
    isBlocked: false,
    passwordPlain: password, // ✅ demo only (later: passwordHash)
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return { clientId, phone, name, points };
}

export async function adminCredit(clientId, amount) {
  await requireAdmin();
  amount = num(amount);
  if (amount <= 0) throw new Error("Enter valid amount");

  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");
  const cur = num(d.data().points);

  await updateDoc(ref, {
    points: cur + amount,
    updatedAt: serverTimestamp()
  });
}

export async function adminDebit(clientId, amount) {
  await requireAdmin();
  amount = num(amount);
  if (amount <= 0) throw new Error("Enter valid amount");

  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");
  const cur = num(d.data().points);

  await updateDoc(ref, {
    points: Math.max(0, cur - amount),
    updatedAt: serverTimestamp()
  });
}

export async function adminToggleBlock(clientId) {
  await requireAdmin();
  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");

  await updateDoc(ref, {
    isBlocked: !d.data().isBlocked,
    updatedAt: serverTimestamp()
  });
}

export async function adminChangeClientPassword(clientId, newPass) {
  await requireAdmin();
  newPass = safe(newPass).trim();
  if (!newPass) throw new Error("New password required");

  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");

  await updateDoc(ref, {
    passwordPlain: newPass, // demo
    updatedAt: serverTimestamp()
  });
}

export async function adminDeleteClient(clientId) {
  await requireAdmin();
  if (safe(clientId).toUpperCase() === "ADMIN1") throw new Error("Admin delete not allowed");

  // Firestore delete requires deleteDoc import; easiest: mark deleted
  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");

  await updateDoc(ref, {
    deleted: true,
    updatedAt: serverTimestamp()
  });
}

/* -------------------- CLIENTS LIST (Admin Table) -------------------- */
export async function getClients() {
  await requireAdmin();
  const qy = query(collection(db, "users"), orderBy("createdAt", "desc"));
  const snap = await getDocs(qy);
  const out = [];
  snap.forEach((docu) => {
    const data = docu.data();
    if (data.deleted) return;
    out.push({ clientId: docu.id, ...data });
  });
  return out;
}

/* -------------------- BETS (Firestore) -------------------- */
export async function placePendingBet(input) {
  const me = await getMeClient();
  if (me.isBlocked) throw new Error("Account blocked");

  const stake = num(input.stake);
  if (stake <= 0) throw new Error("Enter stake");
  if (stake > num(me.points)) throw new Error("Not enough points");

  // 1) cut points in Firestore
  await updateDoc(userRef(me.clientId), {
    points: num(me.points) - stake,
    updatedAt: serverTimestamp()
  });

  // refresh cache
  _me = { ...me, points: num(me.points) - stake };

  // 2) add bet doc
  const bet = {
    at: Date.now(),
    clientId: me.clientId,
    game: safe(input.game),
    pick: safe(input.pick),
    stake,
    roundId: safe(input.roundId),
    result: "PENDING"
  };

  const ref = await addDoc(collection(db, "bets"), bet);
  return { ...bet, betId: ref.id };
}

export async function getClientBets(clientId) {
  clientId = safe(clientId).trim();
  const qy = query(
    collection(db, "bets"),
    where("clientId", "==", clientId),
    orderBy("at", "desc"),
    limit(200)
  );
  const snap = await getDocs(qy);
  const out = [];
  snap.forEach((d) => out.push({ betId: d.id, ...d.data() }));
  return out;
}

export async function statsWinLoss(clientId) {
  const bets = await getClientBets(clientId);
  let win = 0, loss = 0;
  for (let i = 0; i < bets.length; i++) {
    if (bets[i].result === "WIN") win++;
    else if (bets[i].result === "LOSS") loss++;
  }
  return { win, loss, net: win - loss };
}

export async function settlePendingBet(params) {
  const me = await getMeClient(); // just to ensure logged in
  const betId = safe(params.betId);
  const outcome = safe(params.outcome); // WIN/LOSS/TIE

  if (!betId) throw new Error("BetId missing");

  // For simplicity: read bet, then update points, then update bet result
  const betDoc = doc(db, "bets", betId);
  const d = await getDoc(betDoc);
  if (!d.exists()) throw new Error("Bet not found");

  const bet = d.data();
  if (bet.result !== "PENDING") return { betId, ...bet };

  const clientId = bet.clientId;
  const stake = num(bet.stake);

  // payout
  const uref = userRef(clientId);
  const ud = await getDoc(uref);
  if (!ud.exists()) throw new Error("Client missing");

  const curPts = num(ud.data().points);

  let newPts = curPts;
  if (outcome === "WIN") newPts = curPts + (stake * 2);
  else if (outcome === "TIE") newPts = curPts + stake;

  await updateDoc(uref, { points: newPts, updatedAt: serverTimestamp() });
  await updateDoc(betDoc, { result: outcome });

  // refresh cache if this is my own bet
  if (safe(me.clientId) === safe(clientId)) _me = { ...me, points: newPts };

  return { betId, ...bet, result: outcome };
}

/* -------------------- TIMER / ROUNDS --------------------
   NOTE: rounds ko Firestore me mat tick karo (200ms calls heavy ho jayenge)
   Timer local hi rahega. Bets/Points Firestore se sync honge.
*/
export function fmtDate(ms) {
  try { return new Date(num(ms)).toLocaleString(); } catch (e) { return String(ms); }
}

/* -------------------- Auth listener (optional) -------------------- */
onAuthStateChanged(auth, async (u) => {
  if (!u) {
    _me = null;
    setSession(null);
    return;
  }
  try {
    const me = await getUserByUID(u.uid);
    if (me) {
      _me = { clientId: me.id, ...me };
      setSession({ clientId: _me.clientId, role: _me.role || "client", uid: u.uid });
    }
  } catch (e) {
    // ignore
  }
});
