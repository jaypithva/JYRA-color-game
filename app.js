/* =====================================================
   JYRA APP.JS – SAFE REMAKE
   ✔ Old functions preserved
   ✔ SuperAdmin → Admin → Client added
   ✔ No UI / HTML break
===================================================== */

(function () {
  "use strict";

  const SESSION_KEY = "club_session_final";

  /* ================= FIREBASE ================= */
  function ensureFirebase() {
    if (typeof firebase === "undefined") {
      throw new Error("Firebase SDK missing");
    }
    if (!firebase.apps.length) {
      firebase.initializeApp(window.firebaseConfig);
    }
    return firebase.firestore();
  }
  const db = () => ensureFirebase();

  /* ================= HELPERS ================= */
  const nowISO = () => new Date().toISOString();
  const safeNum = (n) => (Number.isFinite(+n) ? +n : 0);

  async function sha256(text) {
    const buf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(String(text))
    );
    return [...new Uint8Array(buf)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /* ================= SESSION ================= */
  function setSession(userId) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId }));
  }
  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    window.__ME = null;
  }
  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }

  /* ================= PATHS ================= */
  const usersCol = () => db().collection("users");
  const userRef = (id) => usersCol().doc(id);
  const txnsCol = (id) => userRef(id).collection("txns");
  const playsCol = (id) => userRef(id).collection("plays");

  /* ================= CURRENT USER ================= */
  async function currentUserAsync() {
    const sess = getSession();
    if (!sess) return null;
    if (window.__ME && window.__ME.clientId === sess.userId) return window.__ME;

    const snap = await userRef(sess.userId).get();
    if (!snap.exists) return null;
    window.__ME = snap.data();
    return window.__ME;
  }
  const currentUser = () => window.__ME || null;

  function logout() {
    clearSession();
    location.replace("login.html");
  }

  /* ================= AUTH (OLD SAFE) ================= */
  async function loginSecure({ phoneOrId, password }) {
    const key = String(phoneOrId || "").trim();
    if (!key) return { ok: false, msg: "Enter ID / phone" };

    let snap = await userRef(key).get();
    if (!snap.exists) {
      const q = await usersCol().where("phone", "==", key).limit(1).get();
      if (q.empty) return { ok: false, msg: "User not found" };
      snap = q.docs[0];
    }

    const user = snap.data();
    if ((await sha256(password)) !== user.passwordHash)
      return { ok: false, msg: "Wrong password" };

    setSession(user.clientId);
    window.__ME = user;
    return { ok: true, user };
  }

  async function registerUserSecure({ name, phone, password }) {
    if (!name || !phone || !password)
      return { ok: false, msg: "All fields required" };

    const q = await usersCol().where("phone", "==", phone).limit(1).get();
    if (!q.empty) return { ok: false, msg: "Phone exists" };

    const clientId = "C" + Math.floor(10000 + Math.random() * 90000);
    const user = {
      clientId,
      role: "user",
      name,
      phone,
      points: 0,
      passwordHash: await sha256(password),
      createdAt: nowISO(),
    };

    await userRef(clientId).set(user);
    return { ok: true, user };
  }

  /* ================= SUPER ADMIN ================= */
  async function superCreateAdmin(data, superId) {
    const s = await userRef(superId).get();
    if (!s.exists || s.data().role !== "superadmin")
      return { ok: false, msg: "Unauthorized" };

    const ref = userRef(data.clientId);
    if ((await ref.get()).exists)
      return { ok: false, msg: "Admin exists" };

    await ref.set({
      clientId: data.clientId,
      role: "admin",
      name: data.name,
      phone: data.phone,
      adminPoints: 0,
      passwordHash: await sha256(data.password),
      createdBy: superId,
      createdAt: nowISO(),
    });

    return { ok: true };
  }

  async function superAddAdminPoints(adminId, pts, superId) {
    const s = await userRef(superId).get();
    if (!s.exists || s.data().role !== "superadmin")
      return { ok: false, msg: "Unauthorized" };

    const ref = userRef(adminId);
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, msg: "Admin not found" };

    await ref.update({
      adminPoints: safeNum(snap.data().adminPoints) + safeNum(pts),
    });

    return { ok: true };
  }

  /* ================= ADMIN ================= */
  async function adminCreateClient(data, adminId) {
    const a = await userRef(adminId).get();
    if (!a.exists || a.data().role !== "admin")
      return { ok: false, msg: "Unauthorized" };

    return registerUserSecure(data);
  }

  async function adminUsePoints(adminId, cost) {
    return db().runTransaction(async (tx) => {
      const ref = userRef(adminId);
      const snap = await tx.get(ref);
      const pts = safeNum(snap.data().adminPoints);
      if (pts < cost) throw "Not enough admin points";
      tx.update(ref, { adminPoints: pts - cost });
    });
  }

  /* ================= OLD FUNCTIONS (UNCHANGED) ================= */
  async function adjustPoints(userId, delta, note, byAdminId = null) {
    const ref = userRef(userId);
    return db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw "User not found";

      const cur = safeNum(snap.data().points);
      const next = cur + safeNum(delta);
      if (next < 0) throw "Insufficient points";

      tx.update(ref, { points: next });
      tx.set(txnsCol(userId).doc(), {
        userId,
        amount: Math.abs(delta),
        type: delta >= 0 ? "credit" : "debit",
        note: note || "",
        byAdminId,
        createdAt: nowISO(),
      });
      return next;
    });
  }

  async function addPlayRow(row) {
    const doc = playsCol(row.userId).doc();
    row.id = doc.id;
    row.createdAt = nowISO();
    await doc.set(row);
    return { ok: true };
  }

  async function playsForUser(userId, limit = 30) {
    const q = await playsCol(userId)
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    return q.docs.map((d) => d.data());
  }

  async function listAllUsers() {
    const q = await usersCol().orderBy("createdAt", "desc").get();
    return q.docs.map((d) => d.data());
  }

  /* ================= EXPORT GLOBALS ================= */
  window.sha256 = sha256;

  window.loginSecure = loginSecure;
  window.registerUserSecure = registerUserSecure;

  window.currentUser = currentUser;
  window.currentUserAsync = currentUserAsync;
  window.logout = logout;

  window.superCreateAdmin = superCreateAdmin;
  window.superAddAdminPoints = superAddAdminPoints;

  window.adminCreateClient = adminCreateClient;
  window.adminUsePoints = adminUsePoints;

  window.adjustPoints = adjustPoints;
  window.addPlayRow = addPlayRow;
  window.playsForUser = playsForUser;
  window.listAllUsers = listAllUsers;
})();
