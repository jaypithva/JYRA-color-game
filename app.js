/* =====================================================
   CONFIG
===================================================== */
const DB_KEY = "club_db_v1";
const SESSION_KEY = "club_session_v1";
const PLAY_KEY = "club_play_history_v1";

// ✅ Your fixed admin credentials
const DEFAULT_ADMIN = {
    id: "ADMIN1",
    role: "admin",
    name: "Admin",
    phone: "9316740061",
    password: "Jay@1803"
};

/* =====================================================
   HELPERS
===================================================== */
function nowISO() { return new Date().toISOString(); }

function uid(p = "U") {
    return p + Math.random().toString(36).slice(2, 9).toUpperCase();
}

function $(id) { return document.getElementById(id); }

function safeJSONParse(raw, fallback) {
    try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function safeNum(n) {
    n = Number(n);
    return Number.isFinite(n) ? n : 0;
}

// ✅ robust time parser (date filter ko 100% stable banata hai)
function toTimeSafe(anyDate) {
    if (!anyDate) return 0;
    const t = new Date(anyDate).getTime();
    return Number.isFinite(t) ? t : 0;
}

function fmtDate(iso) {
    try { return new Date(iso).toLocaleString("en-IN"); } catch (e) { return String(iso || "-"); }
}

// YYYY-MM-DD string to start-of-day Date
function dateInputToStart(ymd) {
    if (!ymd) return null;
    const parts = String(ymd).split("-");
    if (parts.length !== 3) return null;
    const y = Number(parts[0]),
        m = Number(parts[1]) - 1,
        d = Number(parts[2]);
    const dt = new Date(y, m, d, 0, 0, 0, 0);
    return Number.isFinite(dt.getTime()) ? dt : null;
}

// end-of-day timestamp
function endOfDayTime(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
}

function inRangeISO(iso, fromDateObj, toDateObj) {
    const t = toTimeSafe(iso);
    if (!fromDateObj && !toDateObj) return true;
    if (fromDateObj && t < fromDateObj.getTime()) return false;
    if (toDateObj && t > endOfDayTime(toDateObj)) return false;
    return true;
}

/* =====================================================
   SECURITY (HASH)
===================================================== */
async function sha256(text) {
    const enc = new TextEncoder().encode(String(text));
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
}

/* =====================================================
   DATABASE
===================================================== */
function loadDB() {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) {
        const db = safeJSONParse(raw, null);
        if (db && Array.isArray(db.users) && Array.isArray(db.txns)) return db;
    }

    // first time init
    const db = { users: [], txns: [] };

    db.users.push({
        id: DEFAULT_ADMIN.id,
        role: DEFAULT_ADMIN.role,
        name: DEFAULT_ADMIN.name,
        phone: DEFAULT_ADMIN.phone,
        passwordHash: null, // set on first login
        points: 0,
        createdAt: nowISO()
    });

    localStorage.setItem(DB_KEY, JSON.stringify(db));
    return db;
}

function saveDB(db) {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function getUserById(userId) {
    const db = loadDB();
    return db.users.find(u => u.id === userId) || null;
}

/* =====================================================
   SESSION
===================================================== */
function setSession(userId) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, at: nowISO() }));
}

function clearSession() {
    localStorage.removeItem(SESSION_KEY);
}

function getSession() {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? safeJSONParse(raw, null) : null;
}

function currentUser() {
    const sess = getSession();
    if (!sess || !sess.userId) return null;
    const db = loadDB();
    return db.users.find(u => u.id === sess.userId) || null;
}

function logout() {
    clearSession();
    window.location.replace("login.html");
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
   AUTH
===================================================== */
async function loginSecure({ phoneOrId, password }) {
    const db = loadDB();

    const user = db.users.find(u => u.phone === phoneOrId || u.id === phoneOrId);
    if (!user) return { ok: false, msg: "User not found" };

    // ✅ Ensure admin hash exists (first-time setup)
    if (user.role === "admin" && !user.passwordHash) {
        user.passwordHash = await sha256(DEFAULT_ADMIN.password);
        saveDB(db);
    }

    const hash = await sha256(password);
    if (user.passwordHash !== hash) return { ok: false, msg: "Wrong password" };

    setSession(user.id);
    return { ok: true, user };
}

async function registerUserSecure({ name, phone, password }) {
    const db = loadDB();

    if (!name || !phone || !password) return { ok: false, msg: "All fields required" };
    if (!/^\d{10}$/.test(phone)) return { ok: false, msg: "Phone must be 10 digits" };
    if (db.users.some(u => u.phone === phone)) return { ok: false, msg: "Phone already exists" };

    const user = {
        id: uid("C"),
        role: "user",
        name: String(name).trim(),
        phone: String(phone).trim(),
        passwordHash: await sha256(password),
        points: 0,
        createdAt: nowISO()
    };

    db.users.push(user);
    saveDB(db);
    return { ok: true, user };
}

/* =====================================================
   POINTS + TRANSACTIONS
===================================================== */
function adjustPoints(userId, delta, note, byAdminId = null) {
    const db = loadDB();
    const u = db.users.find(x => x.id === userId);
    if (!u) return { ok: false, msg: "User not found" };

    const cur = (typeof u.points === "number") ? u.points : 0;
    const d = Number(delta);
    if (!Number.isFinite(d)) return { ok: false, msg: "Invalid points" };

    const next = cur + d;
    if (next < 0) return { ok: false, msg: "Insufficient points" };

    u.points = next;

    db.txns.unshift({
        id: uid("T"),
        userId,
        type: d >= 0 ? "credit" : "debit",
        amount: Math.abs(d),
        note: note || "",
        byAdminId: byAdminId || null, // ✅ always store null or admin id
        createdAt: nowISO()
    });

    saveDB(db);
    return { ok: true, points: u.points };
}

function userTxns(userId) {
    const db = loadDB();
    const rows = db.txns || [];
    return rows.filter(t => t.userId === userId);
}

/* ✅ Total Admin Credit (sirf admin entries) */
function totalAdminCredit(userId, fromDateObj = null, toDateObj = null) {
    const tx = userTxns(userId);
    let sum = 0;
    tx.forEach(t => {
        if (!t.byAdminId) return; // ✅ only admin
        if (t.type !== "credit") return;
        if (!inRangeISO(t.createdAt, fromDateObj, toDateObj)) return;
        sum += safeNum(t.amount);
    });
    return sum;
}

/* ✅ Total Points from Txns (credit - debit) */
function totalPointsFromTxns(userId, fromDateObj = null, toDateObj = null) {
    const tx = userTxns(userId);
    let total = 0;
    tx.forEach(t => {
        if (!inRangeISO(t.createdAt, fromDateObj, toDateObj)) return;
        const amt = safeNum(t.amount);
        if (t.type === "credit") total += amt;
        if (t.type === "debit") total -= amt;
    });
    return total;
}

/* =====================================================
   PLAY HISTORY
===================================================== */
function loadPlays() {
    const raw = localStorage.getItem(PLAY_KEY);
    return raw ? safeJSONParse(raw, []) : [];
}

function savePlays(rows) {
    localStorage.setItem(PLAY_KEY, JSON.stringify(rows || []));
}

function addPlayRow(row) {
    // ✅ ensure createdAt always valid
    if (!row.createdAt) row.createdAt = nowISO();
    const rows = loadPlays();
    rows.unshift(row);
    savePlays(rows);
}

function playsForUser(userId) {
    return loadPlays().filter(r => r.userId === userId);
}

/* ✅ Total Win/Loss Amount (only betAmount sum) */
function totalWinLoss(userId, fromDateObj = null, toDateObj = null) {
    const plays = playsForUser(userId);
    let win = 0,
        loss = 0;

    plays.forEach(p => {
        if (!inRangeISO(p.createdAt, fromDateObj, toDateObj)) return;
        const betAmt = safeNum(p.betAmount || p.playPoints || 0);
        const isWin = String(p.result || "").toUpperCase() === "WIN";
        if (isWin) win += betAmt;
        else loss += betAmt;
    });

    return { win, loss };
}

/* =====================================================
   ADMIN FUNCTIONS
===================================================== */
async function adminResetClientPassword(clientId, newPass, adminId) {
    const db = loadDB();
    const admin = db.users.find(u => u.id === adminId && u.role === "admin");
    if (!admin) return { ok: false, msg: "Unauthorized" };

    const user = db.users.find(u => u.id === clientId && u.role === "user");
    if (!user) return { ok: false, msg: "Client not found" };

    if (!newPass || String(newPass).trim().length < 4) {
        return { ok: false, msg: "New password minimum 4 characters" };
    }

    user.passwordHash = await sha256(String(newPass).trim());
    saveDB(db);
    return { ok: true };
}

async function updateAdminProfile(adminId, name, pass) {
    const db = loadDB();
    const a = db.users.find(u => u.id === adminId && u.role === "admin");
    if (!a) return { ok: false, msg: "Admin not found" };

    if (name && String(name).trim()) a.name = String(name).trim();
    if (pass && String(pass).trim().length >= 4) a.passwordHash = await sha256(String(pass).trim());

    saveDB(db);
    return { ok: true };
}

function deleteClient(clientId, adminId) {
    const db = loadDB();
    const admin = db.users.find(u => u.id === adminId && u.role === "admin");
    if (!admin) return { ok: false, msg: "Unauthorized" };

    if (clientId === DEFAULT_ADMIN.id) return { ok: false, msg: "Cannot delete admin" };

    db.users = db.users.filter(u => u.id !== clientId);
    db.txns = db.txns.filter(t => t.userId !== clientId);
    saveDB(db);

    const plays = loadPlays().filter(p => p.userId !== clientId);
    savePlays(plays);

    return { ok: true };
}

/* ✅ Clear/Reset helpers (Admin page ke liye) */
function clearClientHistory(userId, resetWallet = false) {
    const db = loadDB();
    const u = db.users.find(x => x.id === userId);
    if (!u) return { ok: false, msg: "User not found" };

    db.txns = (db.txns || []).filter(t => t.userId !== userId);
    saveDB(db);

    const plays = loadPlays().filter(p => p.userId !== userId);
    savePlays(plays);

    if (resetWallet) {
        u.points = 0;
        saveDB(db);
    }

    return { ok: true, points: u.points };
}

/* =====================================================
   OPTIONAL: CLIENT LEDGER (Admin + Game)
===================================================== */
function getClientLedger(userId) {
    const db = loadDB();

    // Admin txns
    const tx = (db.txns || [])
        .filter(t => t.userId === userId)
        .map(t => ({
            kind: "ADMIN",
            createdAt: t.createdAt,
            period: "-",
            label: (t.type === "credit" ? "Admin Credit" : "Admin Debit") + (t.note ? (" • " + t.note) : ""),
            amount: (t.type === "credit" ? +safeNum(t.amount) : -safeNum(t.amount)),
            result: "-",
            bonus: 0,
            byAdminId: t.byAdminId || null
        }));

    // Game plays (entry -betAmount, win reward +2x betAmount)
    const plays = playsForUser(userId);
    const game = (plays || []).slice(0, 30).flatMap(p => {
        const betAmt = safeNum(p.betAmount || 0);
        const win = String(p.result || "").toUpperCase() === "WIN";

        const entry = {
            kind: "GAME",
            createdAt: p.createdAt,
            period: p.period || "-",
            label: "Bet Entry • " + (p.betLabel || "-") + " • " + (p.modeLabel || "-"),
            amount: -betAmt,
            result: win ? "WIN" : "LOSE",
            bonus: -betAmt
        };

        if (!win) return [entry];

        const reward = {
            kind: "GAME",
            createdAt: p.createdAt,
            period: p.period || "-",
            label: "Win Reward (2x) • " + (p.betLabel || "-"),
            amount: +(betAmt * 2),
            result: "WIN",
            bonus: +(betAmt * 2)
        };

        return [entry, reward];
    });

    return tx.concat(game).sort((a, b) => toTimeSafe(b.createdAt) - toTimeSafe(a.createdAt));
}
/* =====================================================
   BACKUP / RESTORE
===================================================== */
function exportBackupJSON() {
    const db = loadDB();
    const plays = loadPlays();
    const backup = {
        version: 1,
        exportedAt: nowISO(),
        db,
        plays
    };
    return JSON.stringify(backup, null, 2);
}

function importBackupJSON(jsonText) {
    try {
        const data = JSON.parse(jsonText);
        if (!data || !data.db || !Array.isArray(data.db.users) || !Array.isArray(data.db.txns)) {
            return { ok: false, msg: "Invalid backup format" };
        }
        // plays optional but recommended
        if (!Array.isArray(data.plays)) data.plays = [];

        localStorage.setItem(DB_KEY, JSON.stringify(data.db));
        localStorage.setItem(PLAY_KEY, JSON.stringify(data.plays));

        return { ok: true };
    } catch (e) {
        return { ok: false, msg: "JSON parse error" };
    }
}

/* =====================================================
   UNDO LAST ADMIN TXN
   - only reverses latest txn made by admin (byAdminId)
===================================================== */
function undoLastAdminTxn(adminId) {
    const db = loadDB();
    const admin = db.users.find(u => u.id === adminId && u.role === "admin");
    if (!admin) return { ok: false, msg: "Unauthorized" };

    const txns = db.txns || [];
    const last = txns.find(t => t.byAdminId === adminId);
    if (!last) return { ok: false, msg: "No admin action to undo" };

    const user = db.users.find(u => u.id === last.userId && u.role === "user");
    if (!user) return { ok: false, msg: "Client not found" };

    const amt = Number(last.amount || 0);
    if (!Number.isFinite(amt) || amt <= 0) return { ok: false, msg: "Invalid txn amount" };

    // reverse delta
    const delta = (last.type === "credit") ? -amt : +amt;

    // wallet check (if reversing credit, wallet must have enough)
    const cur = (typeof user.points === "number") ? user.points : 0;
    const next = cur + delta;
    if (next < 0) return { ok: false, msg: "Cannot undo: wallet insufficient" };

    user.points = next;

    // remove that txn (first matched)
    const idx = txns.indexOf(last);
    if (idx >= 0) txns.splice(idx, 1);
    db.txns = txns;

    saveDB(db);
    return { ok: true, points: user.points };
}