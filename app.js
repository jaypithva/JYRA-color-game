/* =====================================================
   JYRA APP.JS – FINAL STABLE VERSION
   ✔ Admin / SuperAdmin / Client
   ✔ Old functions preserved
   ✔ requireAdminAsync FIXED
===================================================== */

(function(){
"use strict";

const SESSION_KEY = "jyra_session_v1";

/* ========= FIREBASE ========= */
function ensureFirebase(){
  if(typeof firebase==="undefined") throw "Firebase missing";
  if(!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);
  return firebase.firestore();
}
const db = ()=>ensureFirebase();

/* ========= HELPERS ========= */
const nowISO = ()=>new Date().toISOString();
const safeNum = n => Number.isFinite(+n)? +n : 0;

async function sha256(txt){
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(txt)));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

/* ========= SESSION ========= */
function setSession(id){
  localStorage.setItem(SESSION_KEY, JSON.stringify({id}));
}
function getSession(){
  try{ return JSON.parse(localStorage.getItem(SESSION_KEY)); }
  catch{ return null; }
}
function clearSession(){
  localStorage.removeItem(SESSION_KEY);
  window.__ME=null;
}

/* ========= PATHS ========= */
const users = ()=>db().collection("users");
const userRef = id=>users().doc(id);
const txnsCol = id=>userRef(id).collection("txns");
const playsCol = id=>userRef(id).collection("plays");

/* ========= CURRENT USER ========= */
async function currentUserAsync(){
  const s=getSession();
  if(!s) return null;
  if(window.__ME && window.__ME.clientId===s.id) return window.__ME;
  const snap=await userRef(s.id).get();
  if(!snap.exists) return null;
  window.__ME=snap.data();
  return window.__ME;
}
function currentUser(){ return window.__ME||null; }

function logout(){
  clearSession();
  location.replace("login.html");
}

/* ========= GUARDS ========= */
async function requireLoginAsync(){
  const u=await currentUserAsync();
  if(!u){ location.replace("login.html"); return null; }
  return u;
}
async function requireAdminAsync(){
  const u=await requireLoginAsync();
  if(!u || (u.role!=="admin" && u.role!=="superadmin")){
    location.replace("login.html");
    return null;
  }
  return u;
}

/* ========= AUTH ========= */
async function loginSecure({phoneOrId,password}){
  const key=String(phoneOrId||"").trim();
  if(!key) return {ok:false,msg:"Enter ID/Phone"};

  let snap=await userRef(key).get();
  if(!snap.exists){
    const q=await users().where("phone","==",key).limit(1).get();
    if(q.empty) return {ok:false,msg:"User not found"};
    snap=q.docs[0];
  }
  const u=snap.data();
  if(await sha256(password)!==u.passwordHash)
    return {ok:false,msg:"Wrong password"};

  setSession(u.clientId);
  window.__ME=u;
  return {ok:true,user:u};
}

/* ========= REGISTER CLIENT ========= */
async function registerUserSecure({name,phone,password}){
  if(!name||!phone||!password) return {ok:false,msg:"All fields required"};
  const q=await users().where("phone","==",phone).limit(1).get();
  if(!q.empty) return {ok:false,msg:"Phone exists"};

  const id="C"+Math.floor(10000+Math.random()*90000);
  const u={
    clientId:id, role:"user", name, phone,
    points:0,
    passwordHash:await sha256(password),
    createdAt:nowISO()
  };
  await userRef(id).set(u);
  return {ok:true,user:u};
}

/* ========= SUPER ADMIN ========= */
async function superCreateAdmin(data, superId){
  const s=await userRef(superId).get();
  if(!s.exists || s.data().role!=="superadmin")
    return {ok:false,msg:"Unauthorized"};

  if((await userRef(data.clientId).get()).exists)
    return {ok:false,msg:"Admin exists"};

  await userRef(data.clientId).set({
    clientId:data.clientId,
    role:"admin",
    name:data.name,
    phone:data.phone,
    adminPoints:0,
    passwordHash:await sha256(data.password),
    createdBy:superId,
    createdAt:nowISO()
  });
  return {ok:true};
}

async function superAddAdminPoints(adminId,pts,superId){
  const s=await userRef(superId).get();
  if(!s.exists || s.data().role!=="superadmin")
    return {ok:false,msg:"Unauthorized"};

  const ref=userRef(adminId);
  const a=await ref.get();
  if(!a.exists) return {ok:false,msg:"Admin not found"};

  await ref.update({adminPoints:safeNum(a.data().adminPoints)+safeNum(pts)});
  return {ok:true};
}

/* ========= ADMIN ========= */
async function adminCreateClient(data,adminId){
  const a=await userRef(adminId).get();
  if(!a.exists||a.data().role!=="admin")
    return {ok:false,msg:"Unauthorized"};
  return registerUserSecure(data);
}

async function adminUsePoints(adminId,cost){
  return db().runTransaction(async tx=>{
    const r=userRef(adminId);
    const s=await tx.get(r);
    const pts=safeNum(s.data().adminPoints);
    if(pts<cost) throw "Not enough admin points";
    tx.update(r,{adminPoints:pts-cost});
  });
}

/* ========= WALLET / GAME ========= */
async function adjustPoints(userId,delta,note,byAdminId){
  return db().runTransaction(async tx=>{
    const r=userRef(userId);
    const s=await tx.get(r);
    if(!s.exists) throw "User missing";
    const cur=safeNum(s.data().points);
    const next=cur+safeNum(delta);
    if(next<0) throw "Insufficient points";

    tx.update(r,{points:next});
    tx.set(txnsCol(userId).doc(),{
      userId,amount:Math.abs(delta),
      type:delta>=0?"credit":"debit",
      note:note||"",
      byAdminId:byAdminId||null,
      createdAt:nowISO()
    });
    return next;
  });
}

async function addPlayRow(row){
  const d=playsCol(row.userId).doc();
  row.id=d.id; row.createdAt=nowISO();
  await d.set(row);
  return {ok:true};
}
async function playsForUser(id,limit=30){
  const q=await playsCol(id).orderBy("createdAt","desc").limit(limit).get();
  return q.docs.map(d=>d.data());
}

async function listAllUsers(){
  const q=await users().orderBy("createdAt","desc").get();
  return q.docs.map(d=>d.data());
}

/* ========= EXPORT ========= */
window.sha256=sha256;
window.loginSecure=loginSecure;
window.registerUserSecure=registerUserSecure;

window.currentUser=currentUser;
window.currentUserAsync=currentUserAsync;
window.requireLoginAsync=requireLoginAsync;
window.requireAdminAsync=requireAdminAsync;
window.logout=logout;

window.superCreateAdmin=superCreateAdmin;
window.superAddAdminPoints=superAddAdminPoints;

window.adminCreateClient=adminCreateClient;
window.adminUsePoints=adminUsePoints;

window.adjustPoints=adjustPoints;
window.addPlayRow=addPlayRow;
window.playsForUser=playsForUser;
window.listAllUsers=listAllUsers;

})();
