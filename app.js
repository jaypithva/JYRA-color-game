/* app.js - Firestore Users + Plays + Txns (passwordHash supported) */
(function(){
  "use strict";

  const CFG = {
    SESSION_KEY: "club_session_v2",
    USERS_COL: "users",
    PLAYS_SUBCOL: "plays",
    TXNS_SUBCOL: "txns"
  };

  // ---- Firebase init (expects window.firebaseConfig in page)
  if (!window.firebaseConfig) throw new Error("firebaseConfig missing");
  if (!firebase.apps.length) firebase.initializeApp(window.firebaseConfig);
  const db = firebase.firestore();

  // ---- Helpers
  window.fmtDate = function(x){
    try{
      if(!x) return "-";
      if (typeof x === "string") return x;
      if (x.seconds) return new Date(x.seconds*1000).toLocaleString("en-IN");
      if (x.toDate) return x.toDate().toLocaleString("en-IN");
      return new Date(x).toLocaleString("en-IN");
    }catch(e){ return "-"; }
  };

  function readSession(){
    try{ return JSON.parse(localStorage.getItem(CFG.SESSION_KEY)||"null"); }
    catch(e){ return null; }
  }
  function clearSession(){ localStorage.removeItem(CFG.SESSION_KEY); }

  window.logout = function(){
    clearSession();
    location.replace("login.html");
  };

  async function sha256hex(text){
    const enc = new TextEncoder().encode(String(text||""));
    const buf = await crypto.subtle.digest("SHA-256", enc);
    const arr = Array.from(new Uint8Array(buf));
    return arr.map(b => b.toString(16).padStart(2,"0")).join("");
  }

  // ---- Firestore API
  window.getUserByIdFS = async function(id){
    id = String(id||"");
    if(!id) return null;
    const snap = await db.collection(CFG.USERS_COL).doc(id).get();
    if(!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
  };

  window.listUsers = async function(){
    const snap = await db.collection(CFG.USERS_COL).get();
    const out = [];
    snap.forEach(d => out.push({ id: d.id, ...d.data() }));
    return out;
  };
  // alias (old admin pages)
  window.listAllUsers = window.listUsers;

  window.requireAdminAsync = async function(){
    const sess = readSession();
    if(!sess || !sess.clientId){
      location.replace("login.html");
      return null;
    }
    const u = await window.getUserByIdFS(sess.clientId);
    if(!u || u.role !== "admin"){
      clearSession();
      location.replace("login.html");
      return null;
    }
    return u;
  };

  window.playsForUser = async function(clientId, limit){
    clientId = String(clientId||"");
    limit = Number(limit||30);
    const ref = db.collection(CFG.USERS_COL).doc(clientId)
      .collection(CFG.PLAYS_SUBCOL)
      .orderBy("createdAt","desc")
      .limit(limit);

    const snap = await ref.get();
    const rows = [];
    snap.forEach(d => rows.push({ id:d.id, ...d.data() }));
    return rows;
  };

  window.updateAdminProfile = async function(adminId, newName, newPass){
    adminId = String(adminId||"");
    if(!adminId) return { ok:false, msg:"Admin missing." };

    const upd = {};
    if(newName && String(newName).trim()) upd.name = String(newName).trim();

    if(newPass && String(newPass).trim()){
      const pw = String(newPass).trim();
      if(pw.length < 4) return { ok:false, msg:"Password min 4 chars." };
      upd.passwordHash = await sha256hex(pw);
    }

    if(Object.keys(upd).length === 0) return { ok:false, msg:"Nothing to update." };

    upd.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection(CFG.USERS_COL).doc(adminId).update(upd);
    return { ok:true };
  };

  function genClientId(){
    return "C" + Math.floor(10000 + Math.random()*90000);
  }

  window.adminCreateClient = async function(payload, adminId){
    const name = (payload && payload.name ? String(payload.name).trim() : "");
    const phone= (payload && payload.phone ? String(payload.phone).trim() : "");
    const pass = (payload && payload.password ? String(payload.password).trim() : "");

    if(!name) return { ok:false, msg:"Enter client name." };
    if(!/^\d{10}$/.test(phone)) return { ok:false, msg:"Phone must be 10 digits." };
    if(pass.length < 4) return { ok:false, msg:"Password min 4 chars." };

    const dup = await db.collection(CFG.USERS_COL).where("phone","==",phone).limit(1).get();
    if(!dup.empty) return { ok:false, msg:"Phone already exists." };

    let clientId = genClientId();
    for(let i=0;i<10;i++){
      const ex = await db.collection(CFG.USERS_COL).doc(clientId).get();
      if(!ex.exists) break;
      clientId = genClientId();
    }

    const now = firebase.firestore.FieldValue.serverTimestamp();
    const doc = {
      clientId,
      role: "user",
      name,
      phone,
      points: 0,
      passwordHash: await sha256hex(pass),
      createdAt: now,
      updatedAt: now,
      createdBy: adminId || null
    };

    await db.collection(CFG.USERS_COL).doc(clientId).set(doc);
    return { ok:true, user: doc };
  };

  window.adjustPoints = async function(clientId, delta, reason, adminId){
    clientId = String(clientId||"");
    delta = Number(delta||0);
    if(!clientId) return { ok:false, msg:"Client missing." };
    if(!delta) return { ok:false, msg:"Amount invalid." };

    const uref = db.collection(CFG.USERS_COL).doc(clientId);
    let newPoints = 0;

    await db.runTransaction(async (tx)=>{
      const snap = await tx.get(uref);
      if(!snap.exists) throw new Error("Client not found");
      const cur = Number(snap.data().points||0);
      newPoints = cur + delta;
      if(newPoints < 0) newPoints = 0;
      tx.update(uref, { points: newPoints, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });

    // log txns
    try{
      await db.collection(CFG.USERS_COL).doc(clientId).collection(CFG.TXNS_SUBCOL).add({
        delta,
        reason: reason || "",
        adminId: adminId || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }catch(e){}

    return { ok:true, points: newPoints };
  };

  window.adminResetClientPassword = async function(clientId, newPass, adminId){
    clientId = String(clientId||"");
    newPass = String(newPass||"").trim();
    if(!clientId) return { ok:false, msg:"Client missing." };
    if(newPass.length < 4) return { ok:false, msg:"Password min 4 chars." };

    await db.collection(CFG.USERS_COL).doc(clientId).update({
      passwordHash: await sha256hex(newPass),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedBy: adminId || null
    });
    return { ok:true };
  };

  window.clearClientHistory = async function(clientId, resetWallet){
    clientId = String(clientId||"");
    resetWallet = !!resetWallet;
    if(!clientId) return { ok:false, msg:"Client missing." };

    const playsRef = db.collection(CFG.USERS_COL).doc(clientId).collection(CFG.PLAYS_SUBCOL);
    const snap = await playsRef.get();
    if(!snap.empty){
      const batch = db.batch();
      snap.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }

    if(resetWallet){
      await db.collection(CFG.USERS_COL).doc(clientId).update({
        points: 0,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
    return { ok:true };
  };

  window.deleteClient = async function(clientId, adminId){
    clientId = String(clientId||"");
    if(!clientId) return { ok:false, msg:"Client missing." };

    await window.clearClientHistory(clientId, false);

    // delete txns
    try{
      const txSnap = await db.collection(CFG.USERS_COL).doc(clientId).collection(CFG.TXNS_SUBCOL).get();
      if(!txSnap.empty){
        const batch = db.batch();
        txSnap.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }catch(e){}

    await db.collection(CFG.USERS_COL).doc(clientId).delete();
    return { ok:true };
  };

})();
