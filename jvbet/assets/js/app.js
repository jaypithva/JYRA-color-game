// jvbet/assets/js/app.js
import { db } from "./firebase-init.js";
import {
  doc, getDoc,
  collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const K_SESSION = "jvbet_session_v1";

export function getSession(){
  try { return JSON.parse(localStorage.getItem(K_SESSION) || "null"); }
  catch(e){ return null; }
}

export function setSession(sess){
  localStorage.setItem(K_SESSION, JSON.stringify(sess || null));
}

export function logout(){
  setSession(null);
}

// ---- helpers
function isPhone(v){
  return /^[0-9]{8,15}$/.test(String(v || "").trim());
}

async function sha256Hex(text){
  const enc = new TextEncoder().encode(String(text));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---- MAIN LOGIN (ClientID/Phone + Password)
export async function doLogin(idOrPhone, password){
  const x = String(idOrPhone || "").trim();
  const pass = String(password || "");

  if(!x || !pass) throw new Error("Enter ID/Phone and Password");

  // 1) Try as ClientID doc: users/{CLIENTID}
  let userDoc = null;

  const refById = doc(db, "users", x);
  const snapById = await getDoc(refById);
  if(snapById.exists()){
    userDoc = { id: snapById.id, ...snapById.data() };
  }

  // 2) If not found and input is phone => query by phone
  if(!userDoc && isPhone(x)){
    const q = query(collection(db, "users"), where("phone", "==", x), limit(1));
    const qs = await getDocs(q);
    if(!qs.empty){
      const d = qs.docs[0];
      userDoc = { id: d.id, ...d.data() };
    }
  }

  if(!userDoc) throw new Error("Invalid credentials");

  if(userDoc.isBlocked === true) throw new Error("Account blocked");

  // Password check:
  // Prefer passwordHash (sha256 hex) else fallback to password
  if(userDoc.passwordHash){
    const typedHash = await sha256Hex(pass);
    if(String(userDoc.passwordHash).toLowerCase() !== typedHash.toLowerCase()){
      throw new Error("Invalid credentials");
    }
  } else if(userDoc.password){
    if(String(userDoc.password) !== pass) throw new Error("Invalid credentials");
  } else {
    throw new Error("Password not set in Firestore user");
  }

  const role = userDoc.role || "client";
  const clientId = userDoc.clientId || userDoc.id;

  const session = {
    role,
    clientId,
    uid: userDoc.uid || null,
    at: Date.now()
  };

  setSession(session);
  return session;
}
