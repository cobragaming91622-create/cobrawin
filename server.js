const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'cobra123';
const MONGODB_URI = process.env.MONGODB_URI || '';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

let dbCollection = null;
let saveQueue = Promise.resolve();

app.use(express.json());
if (fs.existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
}
app.use(express.static(__dirname));

function resolveHtmlFile(filename) {
    const publicPath = path.join(PUBLIC_DIR, filename);
    if (fs.existsSync(publicPath)) return publicPath;
    return path.join(__dirname, filename);
}

app.get('/', (req, res) => {
    res.sendFile(resolveHtmlFile('index.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(resolveHtmlFile('admin.html'));
});

const WINGO_MODES = {
    '30s': { duration: 30, basePeriod: 2026112110050824 },
    '1m':  { duration: 60, basePeriod: 2026112120050101 },
    '3m':  { duration: 180, basePeriod: 2026112130050101 },
    '5m':  { duration: 300, basePeriod: 2026112150050101 }
};

function defaultNextResults() {
    return { '30s': null, '1m': null, '3m': null, '5m': null };
}

function normalizeUser(u) {
    const rawPhone = u?.phone ?? u?.mobile ?? u?.phoneNumber ?? u?.number ?? '';
    return {
        id: String(u?.id ?? ''),
        phone: String(rawPhone).trim(),
        password: String(u?.password ?? ''),
        balance: Number(Number(u?.balance ?? 0).toFixed(2)),
        blocked: Boolean(u?.blocked)
    };
}

function normalizeState(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const mergedNext = Object.assign(defaultNextResults(), src.nextWinGoResults || {});
    if (src.nextWinGoResult !== undefined && src.nextWinGoResult !== null && mergedNext['30s'] === null) {
        mergedNext['30s'] = src.nextWinGoResult;
    }
    return {
        users: Array.isArray(src.users) ? src.users.map(normalizeUser) : [],
        deposits: Array.isArray(src.deposits) ? src.deposits : [],
        withdrawals: Array.isArray(src.withdrawals) ? src.withdrawals : [],
        nextWinGoResults: mergedNext
    };
}

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        const initial = normalizeState({
            users: [
                { id: '2789365', phone: '9999999999', password: '123', balance: 395.61, blocked: false }
            ],
            deposits: [],
            withdrawals: [],
            nextWinGoResults: defaultNextResults()
        });
        fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
        return initial;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        return normalizeState(parsed);
    } catch (e) {
        return normalizeState({});
    }
}

function saveData(dbObj) {
    const snapshot = normalizeState(dbObj);
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(snapshot, null, 2));
    } catch (err) {
        console.error('Local file write error:', err);
    }

    if (dbCollection) {
        saveQueue = saveQueue
            .then(() =>
                dbCollection.updateOne(
                    { _id: 'cobrawin_state' },
                    { $set: { state: snapshot, updatedAt: new Date() } },
                    { upsert: true }
                )
            )
            .catch((err) => console.error('Mongo save error:', err));
    }
}

let db = loadData();

// Har mode ('30s', '1m', '3m', '5m') ki alag state
const gameState = {};
Object.keys(WINGO_MODES).forEach((mode) => {
    const base = BigInt(WINGO_MODES[mode].basePeriod);
    gameState[mode] = {
        timeLeft: WINGO_MODES[mode].duration,
        periodId: base.toString(),
        activeBets: [],
        history: [
            { periodId: (base - 1n).toString(), number: 5, bigSmall: 'Big', color: 'Green' },
            { periodId: (base - 2n).toString(), number: 7, bigSmall: 'Big', color: 'Green' },
            { periodId: (base - 3n).toString(), number: 4, bigSmall: 'Small', color: 'Red' },
            { periodId: (base - 4n).toString(), number: 5, bigSmall: 'Big', color: 'Violet' },
            { periodId: (base - 5n).toString(), number: 7, bigSmall: 'Big', color: 'Green' }
        ]
    };
});

function mapWingoModeKey(rawMode) {
    const key = String(rawMode || '').trim().toLowerCase();
    if (key === '30sec' || key === '30s') return '30s';
    if (key === '1min' || key === '1m') return '1m';
    if (key === '3min' || key === '3m') return '3m';
    if (key === '5min' || key === '5m') return '5m';
    return rawMode;
}

app.get('/api/wingo/state', (req, res) => {
    const rawMode = req.query.mode;
    const mappedMode = mapWingoModeKey(rawMode);

    if (mappedMode && gameState[mappedMode]) {
        return res.json({
            [rawMode]: gameState[mappedMode],
            [mappedMode]: gameState[mappedMode]
        });
    }

    return res.json(gameState);
});

function getOutcome(num) {
    const n = Number(num);
    const bigSmall = n >= 5 ? 'Big' : 'Small';
    const colors = [];
    if (n === 0) colors.push('Red', 'Violet');
    else if (n === 5) colors.push('Green', 'Violet');
    else if ([1, 3, 7, 9].includes(n)) colors.push('Green');
    else colors.push('Red');
    return { number: n, bigSmall, colors, primaryColor: colors[0] };
}

function multiplier(type, value) {
    if (type === 'number') return 9.9;
    if (type === 'size') return 1.96;
    if (type === 'color') return String(value).toLowerCase() === 'violet' ? 7.96 : 1.96;
    return 1.96;
}

function getMultiplier(type, value) {
    return multiplier(type, value);
}

function settleModeRound(mode) {
    const cfg = WINGO_MODES[mode];
    const st = gameState[mode];
    if (!cfg || !st) return;

    const finishedPeriod = String(st.periodId);
    const forced = db.nextWinGoResults[mode];
    const chosenNum =
        forced !== null && forced !== undefined && forced !== ''
            ? Number(forced)
            : Math.floor(Math.random() * 10);

    const outcome = getOutcome(chosenNum);

    const userWins = new Map();
    st.activeBets.forEach((bet) => {
        if (String(bet.periodId) !== finishedPeriod) return;
        let won = false;
        if (bet.type === 'number' && Number(bet.value) === outcome.number) won = true;
        else if (bet.type === 'size' && String(bet.value) === outcome.bigSmall) won = true;
        else if (bet.type === 'color' && outcome.colors.includes(String(bet.value))) won = true;

        const payout = won ? Number((Number(bet.amount) * getMultiplier(bet.type, bet.value)).toFixed(2)) : 0;
        const key = String(bet.userId || bet.socketId);
        const prev = userWins.get(key) || { userId: bet.userId, socketId: bet.socketId, totalWon: 0 };
        prev.totalWon = Number((prev.totalWon + payout).toFixed(2));
        userWins.set(key, prev);
    });

    st.history.unshift({
        periodId: finishedPeriod,
        number: outcome.number,
        bigSmall: outcome.bigSmall,
        color: outcome.primaryColor
    });
    if (st.history.length > 50) st.history.pop();

    let balanceChanged = false;
    userWins.forEach((entry) => {
        let updatedBalance = null;
        if (entry.userId) {
            const u = db.users.find((x) => String(x.id) === String(entry.userId));
            if (u) {
                u.balance = Number((Number(u.balance || 0) + entry.totalWon).toFixed(2));
                updatedBalance = u.balance;
                balanceChanged = true;
            }
        }
        if (entry.socketId) {
            io.to(entry.socketId).emit('roundResult', {
                mode,
                periodId: finishedPeriod,
                result: outcome,
                wonAmount: entry.totalWon,
                newBalance: updatedBalance
            });
        }
    });

    if (forced !== null && forced !== undefined) {
        db.nextWinGoResults[mode] = null;
        balanceChanged = true;
    }
    if (balanceChanged) {
        saveData(db);
    }

    st.activeBets = [];
    st.periodId = (BigInt(st.periodId) + 1n).toString();
    st.timeLeft = cfg.duration;

    io.emit('publicResult', {
        mode,
        periodId: String(st.periodId),
        result: outcome,
        history: st.history
    });
}

// Server ka ek hi master timer (har 1 second chalega)
setInterval(() => {
    Object.keys(WINGO_MODES).forEach((mode) => {
        const st = gameState[mode];
        if (st.timeLeft > 1) {
            st.timeLeft -= 1;
        } else {
            settleModeRound(mode);
        }
        io.emit('timerUpdate', {
            mode,
            timeLeft: st.timeLeft,
            periodId: String(st.periodId)
        });
    });

    io.emit('legacyTimerUpdate', {
        timeLeft: gameState['30s'].timeLeft,
        periodId: String(gameState['30s'].periodId)
    });
}, 1000);

// Auth Routes
app.post('/api/signup', (req, res) => {
    const { phone, password } = req.body || {};
    const cleanPhone = String(phone || '').trim();
    const cleanPassword = String(password || '');
    if (!cleanPhone || !cleanPassword) {
        return res.json({ success: false, message: 'Phone and password are required.' });
    }
    const exists = db.users.find((u) => String(u.phone).trim() === cleanPhone);
    if (exists) {
        return res.json({ success: false, message: 'Phone number already registered!' });
    }
    const newUser = {
        id: String(Math.floor(1000000 + Math.random() * 9000000)),
        phone: cleanPhone,
        password: cleanPassword,
        balance: 28.0,
        blocked: false
    };
    db.users.push(newUser);
    saveData(db);
    res.json({ success: true, user: newUser });
});

app.post('/api/login', (req, res) => {
    const { phone, password } = req.body || {};
    const cleanPhone = String(phone || '').trim();
    const cleanPassword = String(password || '');
    const user = db.users.find((u) => String(u.phone).trim() === cleanPhone && u.password === cleanPassword);
    if (!user) {
        return res.json({ success: false, message: 'Invalid phone or password!' });
    }
    if (user.blocked) {
        return res.json({ success: false, message: 'Account is suspended. Contact support.' });
    }
    res.json({ success: true, user });
});

// Admin Middleware
function checkAdmin(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (key !== ADMIN_SECRET) {
        return res.status(401).json({ success: false, message: 'Unauthorized admin key' });
    }
    next();
}

app.get('/api/admin/overview', checkAdmin, (req, res) => {
    const safeUsers = db.users.map((u) => {
        const norm = normalizeUser(u);
        return {
            id: norm.id,
            phone: norm.phone || '—',
            balance: norm.balance,
            blocked: norm.blocked
        };
    });

    const totalBalance = safeUsers.reduce((sum, u) => sum + Number(u.balance || 0), 0);
    const modesSummary = {};
    Object.keys(WINGO_MODES).forEach((m) => {
        modesSummary[m] = {
            periodId: String(gameState[m].periodId),
            timeLeft: gameState[m].timeLeft,
            forcedNumber: db.nextWinGoResults[m],
            activeBetsCount: gameState[m].activeBets.length,
            lastResult: gameState[m].history[0] || null
        };
    });

    res.json({
        success: true,
        stats: {
            totalUsers: safeUsers.length,
            totalBalance: Number(totalBalance.toFixed(2)),
            pendingDeposits: db.deposits.filter((d) => d.status === 'Pending').length,
            pendingWithdrawals: db.withdrawals.filter((w) => w.status === 'Pending').length
        },
        modes: modesSummary,
        users: safeUsers,
        deposits: db.deposits,
        withdrawals: db.withdrawals
    });
});

app.post('/api/admin/set-result', checkAdmin, (req, res) => {
    const { mode, number } = req.body || {};
    const targetMode = WINGO_MODES[mode] ? mode : '30s';

    if (number === null || number === '' || number === undefined) {
        db.nextWinGoResults[targetMode] = null;
    } else {
        const n = Number(number);
        if (Number.isNaN(n) || n < 0 || n > 9) {
            return res.json({ success: false, message: 'Result must be between 0 and 9' });
        }
        db.nextWinGoResults[targetMode] = n;
    }
    saveData(db);
    io.emit('adminResultUpdated', {
        mode: targetMode,
        nextWinGoResult: db.nextWinGoResults[targetMode],
        nextWinGoResults: db.nextWinGoResults
    });
    res.json({
        success: true,
        mode: targetMode,
        nextWinGoResult: db.nextWinGoResults[targetMode]
    });
});

app.post('/api/admin/adjust-balance', checkAdmin, (req, res) => {
    const { userId, amount } = req.body || {};
    const delta = Number(amount);
    const lookup = String(userId || '').trim();
    const user = db.users.find((u) => String(u.id) === lookup || String(u.phone).trim() === lookup);
    if (!user || Number.isNaN(delta)) {
        return res.json({ success: false, message: 'User not found or invalid amount' });
    }
    user.balance = Math.max(0, Number((Number(user.balance || 0) + delta).toFixed(2)));
    saveData(db);
    io.to(String(user.id)).emit('balanceUpdate', user.balance);
    res.json({ success: true, user });
});

app.post('/api/admin/toggle-block', checkAdmin, (req, res) => {
    const { userId } = req.body || {};
    const user = db.users.find((u) => String(u.id) === String(userId));
    if (!user) return res.json({ success: false, message: 'User not found' });
    user.blocked = !user.blocked;
    saveData(db);
    res.json({ success: true, user });
});

app.post('/api/deposit-request', (req, res) => {
    const { userId, phone, amount, method, utr } = req.body || {};
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.json({ success: false, message: 'Invalid amount' });
    const reqItem = {
        id: 'DEP' + Date.now(),
        userId: userId || 'guest',
        phone: String(phone || '').trim() || 'N/A',
        amount: amt,
        method: method || 'UPI QR',
        utr: utr || 'N/A',
        status: 'Pending',
        time: new Date().toLocaleString()
    };
    db.deposits.unshift(reqItem);
    saveData(db);
    res.json({ success: true, deposit: reqItem });
});

app.post('/api/admin/deposit-action', checkAdmin, (req, res) => {
    const { id, action } = req.body || {};
    const item = db.deposits.find((d) => d.id === id);
    if (!item || item.status !== 'Pending') {
        return res.json({ success: false, message: 'Request not found or already processed' });
    }
    if (action === 'approve') {
        item.status = 'Approved';
        const user = db.users.find(
            (u) => String(u.id) === String(item.userId) || String(u.phone).trim() === String(item.phone).trim()
        );
        if (user) {
            user.balance = Number((Number(user.balance || 0) + Number(item.amount)).toFixed(2));
            io.to(String(user.id)).emit('balanceUpdate', user.balance);
        }
    } else {
        item.status = 'Rejected';
    }
    saveData(db);
    res.json({ success: true, deposit: item });
});

// Socket.io Real-time Events
io.on('connection', (socket) => {
    let boundUserId = null;

    socket.on('loginUser', (userId) => {
        boundUserId = userId;
        if (userId) socket.join(String(userId));
        socket.emit('init', {
            periodId: String(gameState['30s'].periodId),
            timeLeft: gameState['30s'].timeLeft,
            history: gameState['30s'].history,
            modes: {
                '30s': { periodId: String(gameState['30s'].periodId), timeLeft: gameState['30s'].timeLeft, history: gameState['30s'].history },
                '1m':  { periodId: String(gameState['1m'].periodId),  timeLeft: gameState['1m'].timeLeft,  history: gameState['1m'].history },
                '3m':  { periodId: String(gameState['3m'].periodId),  timeLeft: gameState['3m'].timeLeft,  history: gameState['3m'].history },
                '5m':  { periodId: String(gameState['5m'].periodId),  timeLeft: gameState['5m'].timeLeft,  history: gameState['5m'].history }
            }
        });
    });

    socket.on('placeBet', (betData) => {
        const mode = WINGO_MODES[betData && betData.mode] ? betData.mode : '30s';
        const st = gameState[mode];
        if (st.timeLeft <= 5) {
            return socket.emit('betError', `Betting closed for ${mode} period!`);
        }
        const amt = Number(betData && betData.amount);
        if (!amt || amt < 1) {
            return socket.emit('betError', 'Invalid bet amount!');
        }
        const uid = (betData && betData.userId) || boundUserId;
        if (uid) {
            const user = db.users.find((u) => String(u.id) === String(uid));
            if (user) {
                if (Number(user.balance || 0) < amt) {
                    return socket.emit('betError', 'Insufficient balance!');
                }
                user.balance = Number((Number(user.balance) - amt).toFixed(2));
                saveData(db);
                socket.emit('balanceUpdate', user.balance);
            }
        }
        st.activeBets.push({
            socketId: socket.id,
            userId: uid,
            mode,
            type: betData.type,
            value: betData.value,
            amount: amt,
            periodId: String((betData && betData.periodId) || st.periodId)
        });
    });

    socket.on('submitWithdrawRequest', (wdData) => {
        const amt = Number(wdData && wdData.amount);
        if (!amt || amt < 100) return;
        const item = {
            id: 'WD' + Date.now(),
            userId: (wdData && wdData.userId) || boundUserId || 'guest',
            phone: String((wdData && wdData.phone) || '').trim() || 'N/A',
            amount: amt,
            method: (wdData && wdData.method) || 'UPI',
            details: (wdData && wdData.details) || '',
            status: 'Pending',
            time: new Date().toLocaleString()
        };
        db.withdrawals.unshift(item);
        saveData(db);
    });
});

async function initStorageAndStart() {
    if (MONGODB_URI) {
        try {
            const client = new MongoClient(MONGODB_URI);
            await client.connect();
            const mongoDb = client.db('cobrawin');
            dbCollection = mongoDb.collection('app_state');

            const doc = await dbCollection.findOne({ _id: 'cobrawin_state' });
            if (doc && doc.state) {
                const loadedState = normalizeState(doc.state);
                Object.assign(db, loadedState);
                fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
            } else {
                saveData(db);
            }
            console.log('Connected to MongoDB Atlas');
        } catch (err) {
            console.error('MongoDB connection error, falling back to data.json:', err);
        }
    }

    server.listen(PORT, () => {
        console.log(`Cobra Win Server running on http://localhost:${PORT}`);
        console.log(`Admin Panel URL: http://localhost:${PORT}/admin.html`);
    });
}

initStorageAndStart();