import { auth, db } from "./firebase-init.js";

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

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
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const K_SESSION = "jvbet_session_v2";
let _session = null;
let _me = null;

function safe(v){ return (v===null||v===undefined) ? "" : String(v); }
function num(v){ var n=Number(v); return isFinite(n) ? n : 0; }

export function getSession(){
  if (_session) return _session;
  try{
    var raw = localStorage.getItem(K_SESSION);
    _session = raw ? JSON.parse(raw) : null;
  }catch(e){ _session = null; }
  return _session;
}

export function setSession(s){
  _session = s || null;
  localStorage.setItem(K_SESSION, JSON.stringify(_session));
}

export async function logout(){
  try{ await signOut(auth); }catch(e){}
  _me = null;
  setSession(null);
}

function userRef(clientId){
  return doc(db, "users", safe(clientId).trim());
}

async function getUserByUID(uid){
  const qy = query(collection(db,"users"), where("uid","==",uid), limit(1));
  const snap = await getDocs(qy);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

export async function getMeClient(){
  if (_me) return _me;

  const s = getSession();
  if (s && s.clientId){
    const d = await getDoc(userRef(s.clientId));
    if (d.exists()){
      _me = { clientId: d.id, ...d.data() };
      return _me;
    }
  }

  const u = auth.currentUser;
  if (!u) throw new Error("No session. Please login.");

  const me = await getUserByUID(u.uid);
  if (!me) throw new Error("Profile missing in Firestore (users).");

  _me = { clientId: me.id, ...me };
  setSession({ clientId:_me.clientId, role:_me.role||"client", uid:u.uid });
  return _me;
}

export async function doLogin(email, password){
  email = safe(email).trim();
  password = safe(password);

  if (!email || !password) throw new Error("Enter Email & Password");

  const cred = await signInWithEmailAndPassword(auth, email, password);
  const u = cred.user;

  const me = await getUserByUID(u.uid);
  if (!me) throw new Error("Your Firestore profile missing (users).");

  _me = { clientId: me.id, ...me };
  if (_me.isBlocked) throw new Error("Account blocked");

  setSession({ clientId:_me.clientId, role:_me.role||"client", uid:u.uid });
  return getSession();
}

export async function requireAdmin(){
  const me = await getMeClient();
  if ((me.role||"").toLowerCase() !== "admin"){
    location.href = "../index.html";
    throw new Error("Admin only");
  }
  return true;
}

export async function requireClient(){
  const me = await getMeClient();
  if ((me.role||"").toLowerCase() === "admin"){
    location.href = "../index.html";
    throw new Error("Client only");
  }
  return true;
}

/* ---------- Admin: clients list + create + points ---------- */
export async function getClients(){
  await requireAdmin();
  const qy = query(collection(db,"users"), orderBy("createdAt","desc"));
  const snap = await getDocs(qy);
  const out = [];
  snap.forEach((d)=>{
    const data = d.data();
    if (data.deleted) return;
    out.push({ clientId:d.id, ...data });
  });
  return out;
}

export async function adminCreateClient(input){
  await requireAdmin();

  const clientId = safe(input.clientId).trim();
  const phone = safe(input.phone).trim();
  const name = safe(input.name).trim();
  const points = num(input.points);
  const password = safe(input.password).trim();

  if (!clientId) throw new Error("Client ID required");
  if (!password) throw new Error("Password required");

  const ex = await getDoc(userRef(clientId));
  if (ex.exists()) throw new Error("Client ID already exists");

  if (phone){
    const qy = query(collection(db,"users"), where("phone","==",phone), limit(1));
    const snap = await getDocs(qy);
    if (!snap.empty) throw new Error("Phone already exists");
  }

  await setDoc(userRef(clientId), {
    clientId, phone, name,
    role:"client",
    points: points,
    isBlocked:false,
    passwordPlain: password,   // demo only
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });

  return { clientId, phone, name, points };
}

export async function adminCredit(clientId, amount){
  await requireAdmin();
  amount = num(amount);
  if (amount<=0) throw new Error("Enter valid amount");

  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");

  const cur = num(d.data().points);
  await updateDoc(ref, { points: cur + amount, updatedAt: serverTimestamp() });
}

export async function adminDebit(clientId, amount){
  await requireAdmin();
  amount = num(amount);
  if (amount<=0) throw new Error("Enter valid amount");

  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");

  const cur = num(d.data().points);
  await updateDoc(ref, { points: Math.max(0, cur - amount), updatedAt: serverTimestamp() });
}

export async function adminToggleBlock(clientId){
  await requireAdmin();
  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");

  await updateDoc(ref, { isBlocked: !d.data().isBlocked, updatedAt: serverTimestamp() });
}

export async function adminChangeClientPassword(clientId, newPass){
  await requireAdmin();
  newPass = safe(newPass).trim();
  if (!newPass) throw new Error("New password required");

  const ref = userRef(clientId);
  const d = await getDoc(ref);
  if (!d.exists()) throw new Error("Client not found");

  await updateDoc(ref, { passwordPlain: newPass, updatedAt: serverTimestamp() });
}

/* ---------- Optional: auth state keep ---------- */
onAuthStateChanged(auth, async (u)=>{
  if (!u){
    _me = null;
    setSession(null);
    return;
  }
  try{
    const me = await getUserByUID(u.uid);
    if (me){
      _me = { clientId: me.id, ...me };
      setSession({ clientId:_me.clientId, role:_me.role||"client", uid:u.uid });
    }
  }catch(e){}
});
