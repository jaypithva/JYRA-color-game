/* =====================================================
   Firebase + Firestore Cross-Device App (NO blank pages)
   - Works with compat SDK
   - Adds SuperAdmin -> Admin Wallet -> Client system
   - Global functions: loginSecure, adjustPoints, listUsers, etc.
===================================================== */

(function () {
  "use strict";

  const SESSION_KEY = "club_session_v3";

  // ✅ Make ADMIN1 as SUPERADMIN (same phone/pass)
  const DEFAULT_SUPERADMIN = {
    clientId: "ADMIN1",
    role: "superadmin",
    name: "Super Admin",
    phone: "9316740061",
    password: "Jay@1803",
  };

  // Admin wallet rules
  const ADMIN_WALLET_REFUND_ON_DEBIT = false; // debit client -> wallet refund? (false = safer/simple)

  // ====== FIREBASE INIT ======
  function ensureFirebase() {
    if (typeof firebase === "undefined") {
      throw new Error("Firebase SDK missing. Add firebase-app-compat + firebase-firestore-compat before app.js");
    }
    if (!window.firebaseConfig) {
      throw new Error("firebaseConfig missing. Set window.firebaseConfig before app.js");
    }
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(window.firebaseConfig);
    }
    if (!firebase.firestore) {
      throw new Error("Firestore SDK missing. Add firebase-firestore-compat before app.js");
    }
    return firebase.firestore();
  }

  function db() { return ensureFirebase(); }

  // ====== HELPERS ======
  function nowISO() { return new Date().toISOString(); }
  function safeNum(n) { n = Number(n); return Number.isFinite(n) ? n : 0; }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString("en-IN"); }
    catch (e) { return String(iso || "-"); }
  }

  async function sha256(text) {
    const enc = new TextEncoder().encode(String(text));
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  function setSession(userId) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, at: nowISO() }));
  }
  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    window.__ME = null;
  }
  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ====== FIRESTORE PATHS ======
  function userRef(userId) { return db().collection("users").doc(userId); }
  function txnsCol(userId) { return userRef(userId).collection("txns"); }
  function playsCol(userId) { return userRef(userId).collection("plays"); }

  // ====== USER READS ======
  async function getUserById(userId) {
    const snap = await userRef(userId).get();
    return snap.exists ? snap.data() : null;
  }

  async function getUserByPhone(phone) {
    const q = await db().collection("users").where("phone", "==", String(phone)).limit(1).get();
    if (q.empty) return null;
    return q.docs[0].data();
  }

  async function currentUserAsync() {
    const sess = getSession();
    if (!sess || !sess.userId) return null;
    if (window.__ME && (window.__ME.clientId === sess.userId || window.__ME.id === sess.userId)) return window.__ME;

    const u = await getUserById(sess.userId);
    window.__ME = u;
    return u;
  }

  function currentUser() { return window.__ME || null; }

  function logout() {
    clearSession();
    window.location.replace("login.html");
  }

  // ====== GUARDS ======
  async function requireLoginAsync() {
    const u = await currentUserAsync();
    if (!u) {
      window.location.replace("login.html");
      return null;
    }
    return u;
  }

  // ✅ allow admin + superadmin
  async function requireAdminAsync() {
    const u = await requireLoginAsync();
    if (!u || (u.role !== "admin" && u.role !== "superadmin")) {
      window.location.replace("login.html");
      return null;
    }
    return u;
  }

  async function requireSuperAdminAsync() {
    const u = await requireLoginAsync();
    if (!u || u.role !== "superadmin") {
      return null;
    }
    return u;
  }

  // ====== BOOTSTRAP SUPERADMIN DOC ======
  async function ensureSuperAdminDoc() {
    const ref = userRef(DEFAULT_SUPERADMIN.clientId);
    const snap = await ref.get();
    if (snap.exists) {
      // If old ADMIN1 existed as admin, upgrade to superadmin (one-time)
      const d = snap.data() || {};
      if (d.role !== "superadmin") {
        await ref.update({ role: "superadmin", updatedAt: nowISO() });
      }
      return;
    }

    const passwordHash = await sha256(DEFAULT_SUPERADMIN.password);
    await ref.set({
      clientId: DEFAULT_SUPERADMIN.clientId,
      role: DEFAULT_SUPERADMIN.role,
      name: DEFAULT_SUPERADMIN.name,
      phone: DEFAULT_SUPERADMIN.phone,
      points: 0,
      passwordHash,
      // superadmin wallet not used
      adminWallet: 0,
      adminUsed: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
  }

  // ====== AUTH ======
  async function loginSecure({ phoneOrId, password }) {
    await ensureSuperAdminDoc();

    const key = String(phoneOrId || "").trim();
    if (!key) return { ok: false, msg: "Enter phone or Client ID" };

    let user = null;

    // Try by ID
    const byId = await getUserById(key);
    if (byId) user = byId;

    // Try phone
    if (!user) user = await getUserByPhone(key);

    if (!user) return { ok: false, msg: "User not found" };
    if (!user.passwordHash) return { ok: false, msg: "Password not set for this profile" };

    const hash = await sha256(password || "");
    if (hash !== user.passwordHash) return { ok: false, msg: "Wrong password" };

    setSession(user.clientId || user.id);
    window.__ME = user;
    return { ok: true, user };
  }

  // ====== CREATE USER HELPERS ======
  function newClientId(prefix) {
    return String(prefix || "C") + Math.floor(10000 + Math.random() * 90000);
  }

  async function createUserAsRole({ role, name, phone, password }, actorId) {
    await ensureSuperAdminDoc();

    role = String(role || "user").toLowerCase();
    name = String(name || "").trim();
    phone = String(phone || "").trim();
    password = String(password || "");

    if (!name || !phone || !password) return { ok: false, msg: "All fields required" };
    if (!/^\d{10}$/.test(phone)) return { ok: false, msg: "Phone must be 10 digits" };
    if (password.trim().length < 4) return { ok: false, msg: "Password min 4 chars" };

    // role check
    if (role !== "user" && role !== "admin") return { ok: false, msg: "Invalid role" };

    // actor check
    const actor = await getUserById(actorId);
    if (!actor) return { ok: false, msg: "Unauthorized" };

    // ✅ only superadmin can create admin
    if (role === "admin" && actor.role !== "superadmin") {
      return { ok: false, msg: "Only Super Admin can create Admin" };
    }

    // phone duplicate check
    const q = await db().collection("users").where("phone", "==", phone).limit(1).get();
    if (!q.empty) return { ok: false, msg: "Phone already exists" };

    // generate id
    const prefix = (role === "admin") ? "A" : "C";
    let clientId = newClientId(prefix);

    // ensure no collision (rare)
    for (let i = 0; i < 5; i++) {
      const snap = await userRef(clientId).get();
      if (!snap.exists) break;
      clientId = newClientId(prefix);
    }

    const exists = await userRef(clientId).get();
    if (exists.exists) return { ok: false, msg: "Try again (ID collision)" };

    const passwordHash = await sha256(password);

    const user = {
      clientId,
      role: role,
      name,
      phone,
      points: 0,
      passwordHash,
      // ✅ admin wallet fields (only meaningful for admin)
      adminWallet: role === "admin" ? 0 : 0,
      adminUsed: role === "admin" ? 0 : 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };

    await userRef(clientId).set(user);

    // small txn record
    await txnsCol(clientId).doc().set({
      id: "",
      userId: clientId,
      type: "credit",
      amount: 0,
      note: (role === "admin") ? "Admin created" : "Client created",
      byAdminId: actorId || null,
      createdAt: nowISO(),
    });

    return { ok: true, user };
  }

  // alias used by admin.html (client create)
  async function adminCreateClient({ name, phone, password }, adminId) {
    return await createUserAsRole({ role: "user", name, phone, password }, adminId);
  }

  // superadmin create admin
  async function superAdminCreateAdmin({ name, phone, password }, superId) {
    return await createUserAsRole({ role: "admin", name, phone, password }, superId);
  }

  // ====== ADMIN WALLET TOPUP (superadmin only) ======
  async function superAdminGiveAdminWallet(adminId, amount, superId, note = "Admin Wallet Topup") {
    adminId = String(adminId || "").trim();
    const amt = Number(amount);

    if (!adminId) return { ok: false, msg: "Admin missing" };
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, msg: "Invalid amount" };

    const su = await getUserById(superId);
    if (!su || su.role !== "superadmin") return { ok: false, msg: "Only Super Admin can topup" };

    const aref = userRef(adminId);

    try {
      const res = await db().runTransaction(async (tx) => {
        const aSnap = await tx.get(aref);
        if (!aSnap.exists) throw new Error("Admin not found");

        const a = aSnap.data();
        if (!a || a.role !== "admin") throw new Error("Selected user is not Admin");

        const curWallet = safeNum(a.adminWallet);
        const nextWallet = curWallet + amt;

        tx.update(aref, { adminWallet: nextWallet, updatedAt: nowISO() });

        const tdoc = txnsCol(adminId).doc();
        tx.set(tdoc, {
          id: tdoc.id,
          userId: adminId,
          type: "credit",
          amount: amt,
          note: note,
          byAdminId: superId,
          createdAt: nowISO(),
          kind: "ADMIN_WALLET"
        });

        return nextWallet;
      });

      return { ok: true, adminWallet: res };
    } catch (e) {
      return { ok: false, msg: e?.message || String(e) };
    }
  }

  // ====== POINTS + TXNS ======
  // ✅ NEW: If actor is ADMIN (not superadmin) and credits CLIENT, consume admin wallet
  async function adjustPoints(userId, delta, note, byAdminId = null) {
    userId = String(userId || "").trim();
    const d = Number(delta);
    if (!userId) return { ok: false, msg: "User missing" };
    if (!Number.isFinite(d)) return { ok: false, msg: "Invalid points" };

    const targetRef = userRef(userId);

    try {
      const result = await db().runTransaction(async (tx) => {
        const targetSnap = await tx.get(targetRef);
        if (!targetSnap.exists) throw new Error("User not found");

        const target = targetSnap.data() || {};
        const targetRole = String(target.role || "");

        // actor (admin/superadmin)
        let actor = null;
        let actorRole = "";
        let actorRef = null;

        if (byAdminId) {
          actorRef = userRef(String(byAdminId));
          const actorSnap = await tx.get(actorRef);
          actor = actorSnap.exists ? (actorSnap.data() || null) : null;
          actorRole = actor ? String(actor.role || "") : "";
        }

        // wallet check only for: actor=admin, target=user, delta>0
        if (byAdminId && actor && actorRole === "admin" && targetRole === "user" && d > 0) {
          const wallet = safeNum(actor.adminWallet);
          const used = safeNum(actor.adminUsed);
          const remaining = wallet - used;

          if (d > remaining) {
            throw new Error(`Admin wallet insufficient. Remaining: ${remaining}`);
          }

          tx.update(actorRef, { adminUsed: used + d, updatedAt: nowISO() });
        }

        // optional refund on debit (if enabled)
        if (ADMIN_WALLET_REFUND_ON_DEBIT && byAdminId && actor && actorRole === "admin" && targetRole === "user" && d < 0) {
          const wallet = safeNum(actor.adminWallet);
          const used = safeNum(actor.adminUsed);
          const refund = Math.min(Math.abs(d), used);
          tx.update(actorRef, { adminUsed: Math.max(0, used - refund), updatedAt: nowISO() });
        }

        // apply to target points
        const cur = safeNum(target.points);
        const next = cur + d;
        if (next < 0) throw new Error("Insufficient points");

        tx.update(targetRef, { points: next, updatedAt: nowISO() });

        // txn record to target
        const tdoc = txnsCol(userId).doc();
        tx.set(tdoc, {
          id: tdoc.id,
          userId,
          type: d >= 0 ? "credit" : "debit",
          amount: Math.abs(d),
          note: note || "",
          byAdminId: byAdminId || null,
          createdAt: nowISO(),
          kind: "POINTS"
        });

        return next;
      });

      // refresh cache if same user
      const me = window.__ME;
      if (me && (me.clientId === userId || me.id === userId)) {
        window.__ME = await getUserById(userId);
      }
      if (me && byAdminId && (me.clientId === byAdminId || me.id === byAdminId)) {
        window.__ME = await getUserById(byAdminId);
      }

      return { ok: true, points: result };
    } catch (e) {
      return { ok: false, msg: e?.message || String(e) };
    }
  }

  async function userTxns(userId, limit = 100) {
    const q = await txnsCol(userId).orderBy("createdAt", "desc").limit(Number(limit || 100)).get();
    return q.docs.map((d) => d.data());
  }

  // ====== PLAYS ======
  async function addPlayRow(row) {
    if (!row) return { ok: false, msg: "Row missing" };
    if (!row.userId) return { ok: false, msg: "userId missing" };

    const uid = String(row.userId);
    const doc = playsCol(uid).doc();
    row.id = row.id || doc.id;
    row.createdAt = row.createdAt || nowISO();

    await doc.set(row);
    return { ok: true, id: doc.id };
  }

  async function playsForUser(userId, limit = 30) {
    const q = await playsCol(userId).orderBy("createdAt", "desc").limit(Number(limit || 30)).get();
    return q.docs.map((d) => d.data());
  }

  // ====== ADMIN OPS ======
  async function adminResetClientPassword(clientId, newPass, adminId) {
    const a = await getUserById(adminId);
    if (!a || (a.role !== "admin" && a.role !== "superadmin")) return { ok: false, msg: "Unauthorized" };

    newPass = String(newPass || "").trim();
    if (newPass.length < 4) return { ok: false, msg: "New password minimum 4 characters" };

    const ref = userRef(clientId);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, msg: "Client not found" };

    const passwordHash = await sha256(newPass);
    await ref.update({ passwordHash, updatedAt: nowISO() });
    return { ok: true };
  }

  async function updateAdminProfile(adminId, name, pass) {
    const a = await getUserById(adminId);
    if (!a || (a.role !== "admin" && a.role !== "superadmin")) return { ok: false, msg: "Admin not found" };

    const patch = { updatedAt: nowISO() };
    if (name && String(name).trim()) patch.name = String(name).trim();
    if (pass && String(pass).trim().length >= 4) patch.passwordHash = await sha256(String(pass).trim());

    await userRef(adminId).update(patch);
    window.__ME = await getUserById(adminId);
    return { ok: true };
  }

  async function deleteClient(clientId, adminId) {
    const a = await getUserById(adminId);
    if (!a || (a.role !== "admin" && a.role !== "superadmin")) return { ok: false, msg: "Unauthorized" };
    if (clientId === DEFAULT_SUPERADMIN.clientId) return { ok: false, msg: "Cannot delete Super Admin" };

    const txSnap = await txnsCol(clientId).get();
    const plSnap = await playsCol(clientId).get();
    const batch = db().batch();

    txSnap.docs.forEach((d) => batch.delete(d.ref));
    plSnap.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(userRef(clientId));
    await batch.commit();

    return { ok: true };
  }

  async function clearClientHistory(clientId, resetWallet = false) {
    const txSnap = await txnsCol(clientId).get();
    const plSnap = await playsCol(clientId).get();
    const batch = db().batch();

    txSnap.docs.forEach((d) => batch.delete(d.ref));
    plSnap.docs.forEach((d) => batch.delete(d.ref));

    if (resetWallet) batch.update(userRef(clientId), { points: 0, updatedAt: nowISO() });

    await batch.commit();
    if (window.__ME && window.__ME.clientId === clientId) {
      window.__ME = await getUserById(clientId);
    }
    return { ok: true };
  }

  async function listAllUsers() {
    const q = await db().collection("users").orderBy("createdAt", "desc").get();
    return q.docs.map((d) => d.data());
  }

  // Aliases used in your html
  async function listUsers() { return await listAllUsers(); }
  async function getUserByIdFS(userId) { return await getUserById(userId); }

  // ====== Expose GLOBALS ======
  window.fmtDate = fmtDate;
  window.sha256 = sha256;

  window.currentUser = currentUser;
  window.currentUserAsync = currentUserAsync;

  window.requireLoginAsync = requireLoginAsync;
  window.requireAdminAsync = requireAdminAsync;
  window.requireSuperAdminAsync = requireSuperAdminAsync;

  window.loginSecure = loginSecure;

  window.adjustPoints = adjustPoints;
  window.userTxns = userTxns;

  window.addPlayRow = addPlayRow;
  window.playsForUser = playsForUser;

  window.adminResetClientPassword = adminResetClientPassword;
  window.updateAdminProfile = updateAdminProfile;
  window.deleteClient = deleteClient;
  window.clearClientHistory = clearClientHistory;

  window.logout = logout;

  window.listAllUsers = listAllUsers;
  window.listUsers = listUsers;
  window.getUserByIdFS = getUserByIdFS;

  // New SuperAdmin/Admin creation + wallet
  window.createUserAsRole = createUserAsRole;
  window.adminCreateClient = adminCreateClient;
  window.superAdminCreateAdmin = superAdminCreateAdmin;
  window.superAdminGiveAdminWallet = superAdminGiveAdminWallet;

})();
