/* JVBET Demo (Points-only) - Single app.js for index/admin/casino
   ES5 compatible (no ??, no optional chaining, no arrow)
*/

(function() {
    "use strict";

    // ---------------- Storage Keys ----------------
    var K_SESSION = "jvbet_session_v1";
    var K_CLIENTS = "jvbet_clients_v1";
    var K_BETS = "jvbet_bets_v1";
    var K_ROUNDS = "jvbet_rounds_v1";

    // ---------------- Default Admin ----------------
    var DEFAULT_ADMIN = {
        clientId: "ADMIN1",
        phone: "9316740061",
        password: "Jay@1803",
        role: "admin",
        name: "Admin"
    };

    // ---------------- Small helpers ----------------
    function safe(v) { return (v === null || v === undefined) ? "" : String(v); }

    function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

    function now() { return Date.now(); }

    function loadJSON(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return fallback;
            return JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    }

    function saveJSON(key, obj) {
        localStorage.setItem(key, JSON.stringify(obj));
    }

    // Safe DOM setter (prevents null crash)
    function setText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = safe(text);
    }

    // ---------------- Session ----------------
    function getSession() {
        return loadJSON(K_SESSION, null);
    }

    function setSession(sess) {
        saveJSON(K_SESSION, sess || null);
    }

    function logout() {
        setSession(null);
    }

    // ---------------- Clients ----------------
    function getClients() {
        var list = loadJSON(K_CLIENTS, []);
        // ensure admin exists
        var hasAdmin = false;
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].role === "admin") { hasAdmin = true; break; }
        }
        if (!hasAdmin) {
            list.unshift({
                clientId: DEFAULT_ADMIN.clientId,
                phone: DEFAULT_ADMIN.phone,
                password: DEFAULT_ADMIN.password,
                role: "admin",
                points: 0,
                isBlocked: false,
                name: DEFAULT_ADMIN.name
            });
            saveClients(list);
        }
        return list;
    }

    function saveClients(list) {
        saveJSON(K_CLIENTS, list || []);
    }

    function findClientById(id) {
        id = safe(id).trim();
        if (!id) return null;
        var list = getClients();
        for (var i = 0; i < list.length; i++) {
            if (safe(list[i].clientId).toLowerCase() === id.toLowerCase()) return list[i];
        }
        return null;
    }

    function findClientByPhone(phone) {
        phone = safe(phone).trim();
        if (!phone) return null;
        var list = getClients();
        for (var i = 0; i < list.length; i++) {
            if (safe(list[i].phone) === phone) return list[i];
        }
        return null;
    }

    function findClientByIdOrPhone(v) {
        v = safe(v).trim();
        if (!v) return null;
        var c = findClientById(v);
        if (c) return c;
        return findClientByPhone(v);
    }

    function updateClient(clientId, patch) {
        var list = getClients();
        for (var i = 0; i < list.length; i++) {
            if (safe(list[i].clientId).toLowerCase() === safe(clientId).toLowerCase()) {
                for (var k in patch) {
                    if (patch.hasOwnProperty(k)) list[i][k] = patch[k];
                }
                saveClients(list);
                return list[i];
            }
        }
        throw new Error("Client not found");
    }

    // ---------------- Login ----------------
    function loginAny(params) {
        var idOrPhone = safe(params.idOrPhone).trim();
        var password = safe(params.password).trim();
        if (!idOrPhone || !password) throw new Error("Enter ID/Phone and Password");

        var c = findClientByIdOrPhone(idOrPhone);
        if (!c) throw new Error("Invalid credentials");
        if (c.isBlocked) throw new Error("Account blocked");
        if (safe(c.password) !== password) throw new Error("Invalid credentials");

        setSession({ role: c.role || "client", clientId: c.clientId });
        return c.role || "client";
    }

    function requireAdmin() {
        var s = getSession();
        if (!s || s.role !== "admin") {
            location.href = "../index.html";
        }
    }

    function requireClient() {
        var s = getSession();
        if (!s || s.role !== "client") {
            location.href = "../index.html";
        }
    }

    function getMeClient() {
        var s = getSession();
        if (!s) throw new Error("No session");
        var c = findClientById(s.clientId);
        if (!c) throw new Error("Client missing");
        return c;
    }

    // ---------------- Admin Actions ----------------
    function adminCreateClient(input) {
        var s = getSession();
        if (!s || s.role !== "admin") throw new Error("Admin only");

        var clientId = safe(input.clientId).trim();
        var phone = safe(input.phone).trim();
        var password = safe(input.password).trim();
        var points = num(input.points);

        if (!clientId) throw new Error("Client ID required");
        if (!password) throw new Error("Password required");
        if (findClientById(clientId)) throw new Error("Client ID already exists");
        if (phone && findClientByPhone(phone)) throw new Error("Phone already exists");

        var list = getClients();
        var obj = {
            clientId: clientId,
            phone: phone,
            password: password,
            role: "client",
            points: points,
            isBlocked: false,
            name: safe(input.name || "")
        };
        list.push(obj);
        saveClients(list);
        return obj;
    }

    function adminCredit(clientId, amount) {
        amount = num(amount);
        if (amount <= 0) throw new Error("Enter valid amount");
        var c = findClientById(clientId);
        if (!c) throw new Error("Client not found");
        updateClient(c.clientId, { points: num(c.points) + amount });
    }

    function adminDebit(clientId, amount) {
        amount = num(amount);
        if (amount <= 0) throw new Error("Enter valid amount");
        var c = findClientById(clientId);
        if (!c) throw new Error("Client not found");
        var p = num(c.points) - amount;
        if (p < 0) p = 0;
        updateClient(c.clientId, { points: p });
    }

    function adminSetPoints(clientId, points) {
        points = num(points);
        if (points < 0) points = 0;
        var c = findClientById(clientId);
        if (!c) throw new Error("Client not found");
        updateClient(c.clientId, { points: points });
    }

    function adminToggleBlock(clientId) {
        var c = findClientById(clientId);
        if (!c) throw new Error("Client not found");
        updateClient(c.clientId, { isBlocked: !c.isBlocked });
    }

    function adminChangeClientPassword(clientId, newPass) {
        newPass = safe(newPass).trim();
        if (!newPass) throw new Error("New password required");
        var c = findClientById(clientId);
        if (!c) throw new Error("Client not found");
        updateClient(c.clientId, { password: newPass });
    }

    function adminDeleteClient(clientId) {
        var list = getClients();
        var out = [];
        var found = false;
        for (var i = 0; i < list.length; i++) {
            if (safe(list[i].clientId).toLowerCase() === safe(clientId).toLowerCase()) {
                if (list[i].role === "admin") throw new Error("Can't delete admin");
                found = true;
                continue;
            }
            out.push(list[i]);
        }
        if (!found) throw new Error("Client not found");
        saveClients(out);

        // clear bets + rounds for that client
        adminClearBetHistory(clientId);
        adminClearWalletHistory(clientId);
    }

    function adminClearWalletHistory(clientId) {
        // wallet history not separate in this demo; keeping hook for your UI
        // If you later store wallet txns, clear here.
        return true;
    }

    function adminClearBetHistory(clientId) {
        var bets = loadJSON(K_BETS, []);
        var out = [];
        for (var i = 0; i < bets.length; i++) {
            if (safe(bets[i].clientId).toLowerCase() === safe(clientId).toLowerCase()) continue;
            out.push(bets[i]);
        }
        saveJSON(K_BETS, out);
    }

    // ---------------- Bets (points only) ----------------
    function getAllBets() { return loadJSON(K_BETS, []); }

    function getClientBets(clientId) {
        var all = getAllBets();
        var out = [];
        for (var i = all.length - 1; i >= 0; i--) {
            if (safe(all[i].clientId).toLowerCase() === safe(clientId).toLowerCase()) out.push(all[i]);
        }
        return out;
    }

    function statsWinLoss(clientId) {
        var bets = getClientBets(clientId);
        var win = 0,
            loss = 0;
        for (var i = 0; i < bets.length; i++) {
            if (bets[i].result === "WIN") win++;
            else if (bets[i].result === "LOSS") loss++;
        }
        return { win: win, loss: loss, net: win - loss };
    }

    function placePendingBet(input) {
        var s = getSession();
        if (!s || s.role !== "client") throw new Error("Client only");

        var me = getMeClient();
        var stake = num(input.stake);
        if (stake <= 0) throw new Error("Enter stake");
        if (stake > num(me.points)) throw new Error("Not enough points");

        // cut stake immediately
        updateClient(me.clientId, { points: num(me.points) - stake });

        var bet = {
            betId: "B-" + now() + "-" + Math.floor(Math.random() * 9999),
            at: now(),
            clientId: me.clientId,
            game: safe(input.game),
            pick: safe(input.pick),
            stake: stake,
            roundId: safe(input.roundId),
            result: "PENDING" // will become WIN / LOSS / TIE
        };

        var all = getAllBets();
        all.push(bet);
        saveJSON(K_BETS, all);
        return bet;
    }

    function getPendingBet(clientId, game, roundId) {
        var all = getAllBets();
        for (var i = all.length - 1; i >= 0; i--) {
            var b = all[i];
            if (safe(b.clientId).toLowerCase() === safe(clientId).toLowerCase() &&
                safe(b.game) === safe(game) &&
                safe(b.roundId) === safe(roundId) &&
                b.result === "PENDING") {
                return b;
            }
        }
        return null;
    }

    function settlePendingBet(params) {
        var betId = safe(params.betId);
        var outcome = safe(params.outcome); // WIN / LOSS / TIE
        var all = getAllBets();
        var bet = null;

        for (var i = 0; i < all.length; i++) {
            if (safe(all[i].betId) === betId) { bet = all[i]; break; }
        }
        if (!bet) throw new Error("Bet not found");
        if (bet.result !== "PENDING") return bet;

        // payout rules:
        // WIN => + stake*2 (profit includes stake)
        // LOSS => no refund (already cut)
        // TIE => refund stake
        var c = findClientById(bet.clientId);
        if (!c) throw new Error("Client missing");

        if (outcome === "WIN") {
            updateClient(c.clientId, { points: num(c.points) + (num(bet.stake) * 2) });
        } else if (outcome === "TIE") {
            updateClient(c.clientId, { points: num(c.points) + num(bet.stake) });
        }

        bet.result = outcome;
        saveJSON(K_BETS, all);
        return bet;
    }

    // ---------------- Rounds / Timer (per client per game) ----------------
    function getRoundsState() { return loadJSON(K_ROUNDS, {}); }

    function saveRoundsState(st) { saveJSON(K_ROUNDS, st || {}); }

    function roundKey(clientId, game) { return safe(clientId) + "::" + safe(game); }

    function newRound(totalSec, lockRemainingSec) {
        var rid = "R-" + now() + "-" + Math.floor(Math.random() * 999999);
        return {
            roundId: rid,
            startAt: now(),
            endAt: now() + (num(totalSec) * 1000),
            totalSec: num(totalSec),
            lockRemainingSec: num(lockRemainingSec),
            betPlaced: false,
            revealed: false,
            nextStarted: false
        };
    }

    function ensureRound(clientId, game, totalSec, lockRemainingSec) {
        var st = getRoundsState();
        var k = roundKey(clientId, game);
        if (!st[k]) {
            st[k] = newRound(totalSec, lockRemainingSec);
            saveRoundsState(st);
            return st[k];
        }

        // If config changed, keep consistent (use latest)
        st[k].totalSec = num(totalSec);
        st[k].lockRemainingSec = num(lockRemainingSec);

        // If round fully finished AND next started previously, keep it.
        saveRoundsState(st);
        return st[k];
    }

    function secondsLeftRound(round) {
        if (!round) return 0;
        var left = Math.ceil((num(round.endAt) - now()) / 1000);
        return left < 0 ? 0 : left;
    }

    function isBetOpen(round) {
        // bet open only when remaining seconds > lockRemainingSec
        var left = secondsLeftRound(round);
        var lock = num(round.lockRemainingSec);
        return left > lock;
    }

    function markBetPlaced(clientId, game) {
        var st = getRoundsState();
        var k = roundKey(clientId, game);
        if (!st[k]) return;
        st[k].betPlaced = true;
        saveRoundsState(st);
    }

    function markRevealed(clientId, game) {
        var st = getRoundsState();
        var k = roundKey(clientId, game);
        if (!st[k]) return;
        st[k].revealed = true;
        saveRoundsState(st);
    }

    function markNextStarted(clientId, game) {
        var st = getRoundsState();
        var k = roundKey(clientId, game);
        if (!st[k]) return;
        st[k].nextStarted = true;
        saveRoundsState(st);
    }

    function startNextRound(clientId, game, totalSec, lockRemainingSec) {
        var st = getRoundsState();
        var k = roundKey(clientId, game);
        st[k] = newRound(totalSec, lockRemainingSec);
        saveRoundsState(st);
        return st[k];
    }

    // ---------------- Formatting ----------------
    function fmtDate(ms) {
        try { return new Date(num(ms)).toLocaleString(); } catch (e) { return String(ms); }
    }

    // ---------------- Expose to window ----------------
    window.safe = safe;
    window.getSession = getSession;
    window.setSession = setSession;
    window.logout = logout;

    window.getClients = getClients;
    window.findClientByIdOrPhone = findClientByIdOrPhone;
    window.updateClient = updateClient;

    window.loginAny = loginAny;
    window.requireAdmin = requireAdmin;
    window.requireClient = requireClient;
    window.getMeClient = getMeClient;

    window.adminCreateClient = adminCreateClient;
    window.adminCredit = adminCredit;
    window.adminDebit = adminDebit;
    window.adminSetPoints = adminSetPoints;
    window.adminToggleBlock = adminToggleBlock;
    window.adminChangeClientPassword = adminChangeClientPassword;
    window.adminDeleteClient = adminDeleteClient;
    window.adminClearWalletHistory = adminClearWalletHistory;
    window.adminClearBetHistory = adminClearBetHistory;

    window.getClientBets = getClientBets;
    window.statsWinLoss = statsWinLoss;
    window.placePendingBet = placePendingBet;
    window.getPendingBet = getPendingBet;
    window.settlePendingBet = settlePendingBet;

    window.ensureRound = ensureRound;
    window.secondsLeftRound = secondsLeftRound;
    window.isBetOpen = isBetOpen;
    window.markBetPlaced = markBetPlaced;
    window.markRevealed = markRevealed;
    window.markNextStarted = markNextStarted;
    window.startNextRound = startNextRound;
    window.fmtDate = fmtDate;

})();