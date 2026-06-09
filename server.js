const express = require('express');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== БАЗА ДАННЫХ ====================
const db = new sqlite3.Database('dadton.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE,
        name TEXT,
        avatar TEXT,
        username TEXT,
        stars INTEGER DEFAULT 0,
        turnover INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        referrer_id TEXT,
        wallet_address TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS rocket_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        multiplier REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_finance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE,
        deposited INTEGER DEFAULT 0,
        withdrawn INTEGER DEFAULT 0,
        admin_added INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS withdraw_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        name TEXT,
        amount INTEGER,
        asset TEXT,
        wallet TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS referrals_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id TEXT,
        referred_id TEXT,
        amount INTEGER,
        earned INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS pending_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        amount REAL,
        asset TEXT,
        stars_amount INTEGER,
        tx_hash TEXT,
        wallet_address TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

console.log('✅ База данных готова');

// ==================== КОНСТАНТЫ ====================
const ADMIN_ID = '1631627984';
const ADMIN_WALLET = 'UQCEA1RKJ0eAZ_kvpN7tzhrCIh94XBw9ROSeQbaHPXOEOPRP';
const BOT_TOKEN = '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const RATES = { TON: 100, USDT: 50 };
const MAX_BET = 5000;
const MIN_BET = 10;

// ==================== УВЕДОМЛЕНИЯ ====================
async function notifyAdmin(message) {
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: ADMIN_ID,
            text: message,
            parse_mode: 'HTML'
        });
    } catch(e) { console.log('Notify error:', e); }
}

async function notifyUser(telegram_id, message) {
    try {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
            chat_id: telegram_id,
            text: message,
            parse_mode: 'HTML'
        });
    } catch(e) { console.log('Notify user error:', e); }
}

// ==================== ОСНОВНЫЕ МАРШРУТЫ ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/tonconnect-manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tonconnect-manifest.json'));
});

app.get('/ping', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ==================== ПОЛЬЗОВАТЕЛИ ====================
app.post('/api/register', (req, res) => {
    const { telegram_id, name, username, referrer_id } = req.body;
    
    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        if (!row) {
            db.run(`INSERT INTO users (telegram_id, name, username, stars, referrer_id) VALUES (?, ?, ?, 0, ?)`, 
                [telegram_id, name, username, referrer_id]);
            
            if (referrer_id) {
                notifyUser(referrer_id, `🎉 Новый реферал! ${name} зарегистрировался по вашей ссылке`);
            }
            res.json({ success: true, stars: 0 });
        } else {
            res.json({ success: true, stars: row.stars, wallet_address: row.wallet_address });
        }
    });
});

app.post('/api/get-balance', (req, res) => {
    const { telegram_id } = req.body;
    db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        res.json({ stars: row?.stars || 0 });
    });
});

// ==================== TON CONNECT ====================
let activePayloads = new Map();

function generatePayload() {
    return crypto.randomBytes(32).toString('hex');
}

setInterval(() => {
    const now = Date.now();
    for (const [payload, timestamp] of activePayloads.entries()) {
        if (now - timestamp > 5 * 60 * 1000) activePayloads.delete(payload);
    }
}, 60 * 1000);

app.get('/api/generate-payload', (req, res) => {
    const payload = generatePayload();
    activePayloads.set(payload, Date.now());
    res.json({ payload });
});

app.post('/api/verify-proof', async (req, res) => {
    try {
        const { address, proof, telegram_id } = req.body;
        
        if (!activePayloads.has(proof.payload)) {
            return res.status(400).json({ success: false, error: 'Invalid payload' });
        }
        
        activePayloads.delete(proof.payload);
        
        if (proof.signature && proof.signature.length > 0) {
            db.run(`UPDATE users SET wallet_address = ? WHERE telegram_id = ?`, [address, telegram_id]);
            console.log(`✅ Кошелёк ${address} привязан к ${telegram_id}`);
            return res.json({ success: true, address });
        }
        
        res.status(401).json({ success: false, error: 'Invalid signature' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/get-wallet', (req, res) => {
    const { telegram_id } = req.body;
    db.get(`SELECT wallet_address FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        res.json({ success: true, wallet_address: row?.wallet_address || null });
    });
});

app.post('/api/disconnect-wallet', (req, res) => {
    const { telegram_id } = req.body;
    db.run(`UPDATE users SET wallet_address = NULL WHERE telegram_id = ?`, [telegram_id], (err) => {
        if (err) {
            res.json({ success: false, error: err.message });
        } else {
            console.log(`🔓 Кошелёк отвязан у пользователя ${telegram_id}`);
            res.json({ success: true });
        }
    });
});

// ==================== КРИПТО-ПОПОЛНЕНИЕ ====================
app.post('/api/create-crypto-invoice', async (req, res) => {
    try {
        const { telegram_id, asset, amount, wallet_address } = req.body;
        
        db.get(`SELECT wallet_address FROM users WHERE telegram_id = ?`, [telegram_id], (err, user) => {
            if (err || !user || user.wallet_address !== wallet_address) {
                return res.json({ success: false, error: 'Кошелёк не привязан или не совпадает' });
            }
            
            const starsAmount = Math.floor(amount * RATES[asset]);
            const tx_hash = crypto.randomBytes(16).toString('hex');
            
            db.run(`INSERT INTO pending_payments (user_id, amount, asset, stars_amount, tx_hash, wallet_address) VALUES (?, ?, ?, ?, ?, ?)`,
                [telegram_id, amount, asset, starsAmount, tx_hash, wallet_address]);
            
            const nanoAmount = Math.floor(amount * 1e9);
            const invoiceUrl = `https://app.tonkeeper.com/transfer/${ADMIN_WALLET}?amount=${nanoAmount}&text=deposit_${tx_hash}`;
            
            res.json({ success: true, invoiceUrl, tx_hash });
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/check-payment', async (req, res) => {
    try {
        const { tx_hash } = req.body;
        
        db.get(`SELECT * FROM pending_payments WHERE tx_hash = ? AND status = 'pending'`, [tx_hash], async (err, payment) => {
            if (err || !payment) {
                return res.json({ success: false, error: 'Платёж не найден' });
            }
            
            // Для теста зачисляем сразу (в проде проверять через TON API)
            if (payment.status === 'pending') {
                db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [payment.stars_amount, payment.user_id]);
                db.run(`INSERT INTO user_finance (telegram_id, deposited, withdrawn, admin_added) VALUES (?, ?, 0, 0) ON CONFLICT(telegram_id) DO UPDATE SET deposited = deposited + ?`, 
                    [payment.user_id, payment.stars_amount, payment.stars_amount]);
                db.run(`UPDATE pending_payments SET status = 'completed' WHERE tx_hash = ?`, [tx_hash]);
                
                console.log(`✅ Зачислено ${payment.stars_amount}⭐ пользователю ${payment.user_id}`);
                notifyUser(payment.user_id, `✅ Ваш баланс пополнен на ${payment.stars_amount}⭐ через ${payment.asset}!`);
                
                res.json({ success: true, confirmed: true, stars: payment.stars_amount });
            } else {
                res.json({ success: true, confirmed: false });
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== TELEGRAM STARS ====================
app.post('/api/create-invoice', async (req, res) => {
    const { amount, initData } = req.body;
    
    let userId = 'unknown';
    try {
        const params = new URLSearchParams(initData);
        const user = JSON.parse(params.get('user') || '{}');
        userId = user.id || 'unknown';
    } catch(e) {}
    
    try {
        const response = await axios.post(`${TELEGRAM_API}/createInvoiceLink`, {
            title: "DadTon - Пополнение",
            description: `Покупка ${amount} звёзд`,
            payload: JSON.stringify({ userId, amount }),
            provider_token: "",
            currency: "XTR",
            prices: [{ label: "Звёзды", amount: parseInt(amount) }]
        });
        
        if (response.data.ok) {
            res.json({ success: true, invoiceLink: response.data.result });
        } else {
            res.json({ success: false, error: response.data.description });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/telegram', async (req, res) => {
    const { pre_checkout_query, message } = req.body;
    
    if (pre_checkout_query) {
        await axios.post(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
            pre_checkout_query_id: pre_checkout_query.id,
            ok: true
        });
        return res.sendStatus(200);
    }
    
    if (message?.successful_payment) {
        const payment = message.successful_payment;
        const payload = JSON.parse(payment.invoice_payload);
        const starsAmount = payment.total_amount;
        const userId = payload.userId;
        
        db.run(`UPDATE users SET stars = stars + ?, deposited = deposited + ? WHERE telegram_id = ?`, 
            [starsAmount, starsAmount, userId.toString()]);
        db.run(`INSERT INTO user_finance (telegram_id, deposited, withdrawn, admin_added) VALUES (?, ?, 0, 0) ON CONFLICT(telegram_id) DO UPDATE SET deposited = deposited + ?`, 
            [userId.toString(), starsAmount, starsAmount]);
        
        console.log(`✅ Пользователь ${userId} пополнил ${starsAmount}⭐ через Stars`);
        notifyUser(userId, `✅ Ваш баланс пополнен на ${starsAmount}⭐ через Telegram Stars!`);
    }
    
    res.sendStatus(200);
});

// ==================== ВЫВОД СРЕДСТВ ====================
app.post('/api/withdraw-request', (req, res) => {
    const { telegram_id, stars_amount, asset, wallet_address } = req.body;
    
    db.get(`SELECT name, stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        if (!row || row.stars < stars_amount) {
            return res.json({ success: false, error: 'Недостаточно звёзд' });
        }
        
        db.run(`UPDATE users SET stars = stars - ? WHERE telegram_id = ?`, [stars_amount, telegram_id]);
        db.run(`INSERT INTO user_finance (telegram_id, deposited, withdrawn, admin_added) VALUES (?, 0, ?, 0) ON CONFLICT(telegram_id) DO UPDATE SET withdrawn = withdrawn + ?`, 
            [telegram_id, stars_amount, stars_amount]);
        
        db.run(`INSERT INTO withdraw_requests (telegram_id, name, amount, asset, wallet) VALUES (?, ?, ?, ?, ?)`,
            [telegram_id, row.name, stars_amount, asset, wallet_address || 'Telegram Stars']);
        
        let message = `🔴 <b>НОВАЯ ЗАЯВКА НА ВЫВОД</b>\n👤 ${row.name}\n🆔 ${telegram_id}\n⭐ ${stars_amount}\n💳 ${asset}`;
        if (asset !== 'STARS') message += `\n📮 ${wallet_address}`;
        
        notifyAdmin(message);
        res.json({ success: true });
    });
});

// ==================== АДМИН-ПАНЕЛЬ ====================
app.post('/api/admin/add-stars', (req, res) => {
    const { admin_id, target_telegram_id, stars_amount, comment } = req.body;
    
    if (admin_id !== ADMIN_ID) {
        return res.json({ success: false, error: 'Доступ запрещён' });
    }
    
    db.get(`SELECT name FROM users WHERE telegram_id = ?`, [target_telegram_id], (err, row) => {
        if (!row) {
            return res.json({ success: false, error: 'Пользователь не найден' });
        }
        
        db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [stars_amount, target_telegram_id]);
        db.run(`INSERT INTO user_finance (telegram_id, deposited, withdrawn, admin_added) VALUES (?, 0, 0, ?) ON CONFLICT(telegram_id) DO UPDATE SET admin_added = admin_added + ?`, 
            [target_telegram_id, stars_amount, stars_amount]);
        
        notifyUser(target_telegram_id, `👑 Админ пополнил ваш баланс на ${stars_amount}⭐\n📝 ${comment || 'Без комментария'}`);
        notifyAdmin(`✅ Админ пополнил ${row.name} на ${stars_amount}⭐`);
        
        res.json({ success: true });
    });
});

app.post('/api/admin/get-withdraw-requests', (req, res) => {
    const { admin_id } = req.body;
    if (admin_id !== ADMIN_ID) return res.json({ success: false });
    
    db.all(`SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC`, (err, rows) => {
        res.json({ requests: rows || [] });
    });
});

app.post('/api/admin/approve-withdraw', (req, res) => {
    const { admin_id, telegram_id, stars_amount } = req.body;
    if (admin_id !== ADMIN_ID) return res.json({ success: false });
    
    db.run(`UPDATE withdraw_requests SET status = 'approved' WHERE telegram_id = ? AND amount = ? AND status = 'pending'`,
        [telegram_id, stars_amount]);
    
    notifyUser(telegram_id, `✅ Ваша заявка на вывод ${stars_amount}⭐ подтверждена!`);
    res.json({ success: true });
});

// ==================== РАКЕТА ====================
let rocketState = {
    status: 'waiting',
    currentMultiplier: 1.00,
    crashPoint: 0,
    bets: [],
    countdown: 10
};

let rocketInterval = null;
let countdownInterval = null;
let minesState = new Map();
let rouletteBets = [];

function generateCrashPoint() {
    let r = Math.random();
    if (r < 0.25) return 1.05 + Math.random() * 0.15;
    if (r < 0.50) return 1.20 + Math.random() * 0.30;
    if (r < 0.70) return 1.50 + Math.random() * 0.50;
    if (r < 0.85) return 2.00 + Math.random() * 1.00;
    if (r < 0.95) return 3.00 + Math.random() * 2.00;
    return 5.00 + Math.random() * 3.00;
}

function startRocketCountdown() {
    rocketState.status = 'waiting';
    rocketState.countdown = 10;
    rocketState.bets = [];
    
    io.emit('rocket_countdown', rocketState.countdown);
    io.emit('rocket_bets_clear');
    
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        rocketState.countdown--;
        io.emit('rocket_countdown', rocketState.countdown);
        if (rocketState.countdown <= 0) {
            clearInterval(countdownInterval);
            startRocketFlying();
        }
    }, 1000);
}

function startRocketFlying() {
    let crash = generateCrashPoint();
    
    rocketState = {
        status: 'flying',
        currentMultiplier: 1.00,
        crashPoint: crash,
        bets: rocketState.bets,
        countdown: 0
    };
    
    io.emit('rocket_start', { crashPoint: crash });
    
    if (rocketInterval) clearInterval(rocketInterval);
    
    let lastTime = Date.now();
    
    rocketInterval = setInterval(() => {
        if (rocketState.status !== 'flying') {
            clearInterval(rocketInterval);
            return;
        }
        
        const delta = Math.min(100, Date.now() - lastTime);
        lastTime = Date.now();
        
        let speed = rocketState.currentMultiplier < 1.5 ? 0.008 : 0.012 + (rocketState.currentMultiplier - 1.5) * 0.003;
        speed = Math.min(speed, 0.035);
        
        rocketState.currentMultiplier += speed * (delta / 100);
        
        for (let bet of rocketState.bets) {
            if (!bet.cashedAt && bet.autoCashout > 0 && rocketState.currentMultiplier >= (bet.autoCashout - 0.005)) {
                const winAmount = Math.floor(bet.amount * rocketState.currentMultiplier);
                bet.cashedAt = rocketState.currentMultiplier;
                bet.winAmount = winAmount;
                
                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                    [winAmount, winAmount, bet.telegram_id]);
                
                io.emit('rocket_cashout_done', { name: bet.name, multiplier: rocketState.currentMultiplier, win: winAmount });
            }
        }
        
        if (rocketState.currentMultiplier >= rocketState.crashPoint) {
            clearInterval(rocketInterval);
            rocketState.status = 'crashed';
            
            io.emit('rocket_crash', rocketState.currentMultiplier);
            db.run(`INSERT INTO rocket_history (multiplier) VALUES (?)`, [rocketState.currentMultiplier]);
            
            setTimeout(startRocketCountdown, 1500);
        } else {
            io.emit('rocket_multiplier', rocketState.currentMultiplier);
        }
    }, 50);
}

function calculateMinesMultiplier(minesCount, revealed) {
    let perCell = minesCount === 5 ? 1.04 : minesCount === 10 ? 1.12 : minesCount === 15 ? 1.30 : minesCount === 20 ? 2.00 : 3.00;
    return Math.min(Math.pow(perCell, revealed), 500);
}

// ==================== СОКЕТЫ ====================
io.on('connection', (socket) => {
    console.log('👤 Игрок подключился');
    
    socket.on('register', (data, callback) => {
        const { telegram_id, name, avatar, username } = data;
        db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row) {
                db.run(`INSERT INTO users (telegram_id, name, avatar, username) VALUES (?, ?, ?, ?)`, [telegram_id, name, avatar, username]);
                callback({ success: true, stars: 0 });
            } else {
                callback({ success: true, stars: row.stars, name: row.name, avatar: row.avatar });
            }
        });
    });
    
    socket.on('get_balance', (telegram_id, callback) => {
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            callback({ stars: row?.stars || 0 });
        });
    });
    
    socket.on('get_referral_stats', (telegram_id, callback) => {
        db.all(`SELECT name, username FROM users WHERE referrer_id = ?`, [telegram_id], (err, rows) => {
            callback({ count: rows?.length || 0, referrals: rows || [] });
        });
    });
    
    socket.on('rocket_place_bet', (data, callback) => {
        if (rocketState.status !== 'waiting') return callback({ success: false, error: 'Ставки только до взлёта!' });
        
        const { telegram_id, name, amount, autoCashout, avatar } = data;
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < amount) return callback({ success: false, error: 'Недостаточно звёзд!' });
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [amount, telegram_id]);
            
            rocketState.bets.push({ telegram_id, name, amount, autoCashout: autoCashout || 0, cashedAt: null, avatar });
            io.emit('rocket_bet_placed', { name, amount, avatar });
            callback({ success: true });
        });
    });
    
    socket.on('rocket_cancel_bet', ({ telegram_id }, callback) => {
        const betIndex = rocketState.bets.findIndex(b => b.telegram_id === telegram_id && !b.cashedAt);
        if (betIndex === -1) return callback({ success: false });
        
        const bet = rocketState.bets[betIndex];
        db.run(`UPDATE users SET stars = stars + ?, games_played = games_played - 1 WHERE telegram_id = ?`, [bet.amount, telegram_id]);
        rocketState.bets.splice(betIndex, 1);
        io.emit('rocket_bet_cancelled', { telegram_id, name: bet.name });
        callback({ success: true, amount: bet.amount });
    });
    
    socket.on('rocket_cashout', ({ telegram_id }) => {
        if (rocketState.status !== 'flying') return;
        const bet = rocketState.bets.find(b => b.telegram_id === telegram_id && !b.cashedAt);
        if (!bet) return;
        
        const winAmount = Math.floor(bet.amount * rocketState.currentMultiplier);
        bet.cashedAt = rocketState.currentMultiplier;
        
        db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
            [winAmount, winAmount, telegram_id]);
        
        io.emit('rocket_cashout_done', { name: bet.name, multiplier: rocketState.currentMultiplier, win: winAmount });
    });
    
    socket.on('rocket_get_history', () => {
        db.all(`SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10`, (err, rows) => {
            socket.emit('rocket_history_data', rows || []);
        });
    });
    
    socket.on('mines_start', (data, callback) => {
        const { telegram_id, betAmount, minesCount } = data;
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < betAmount) return callback({ success: false, error: 'Недостаточно звёзд!' });
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [betAmount, telegram_id]);
            
            const totalCells = 25;
            const mineIndices = [];
            while (mineIndices.length < minesCount) {
                const idx = Math.floor(Math.random() * totalCells);
                if (!mineIndices.includes(idx)) mineIndices.push(idx);
            }
            
            minesState.set(telegram_id, { grid: mineIndices, bet: betAmount, minesCount, revealed: 0, active: true });
            callback({ success: true });
        });
    });
    
    socket.on('mines_reveal', ({ telegram_id, cellIndex }, callback) => {
        const game = minesState.get(telegram_id);
        if (!game || !game.active) return callback({ success: false, exploded: true });
        if (game.grid.includes(cellIndex)) {
            game.active = false;
            minesState.delete(telegram_id);
            return callback({ success: false, exploded: true });
        }
        
        game.revealed++;
        const multiplier = calculateMinesMultiplier(game.minesCount, game.revealed);
        const winAmount = Math.floor(game.bet * multiplier);
        
        if (game.revealed === 25 - game.minesCount) {
            db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                [winAmount, winAmount, telegram_id]);
            game.active = false;
            minesState.delete(telegram_id);
            callback({ success: true, revealed: game.revealed, multiplier: multiplier.toFixed(2), winAmount, finished: true });
        } else {
            callback({ success: true, revealed: game.revealed, multiplier: multiplier.toFixed(2), winAmount });
        }
    });
    
    socket.on('mines_cashout', ({ telegram_id }, callback) => {
        const game = minesState.get(telegram_id);
        if (!game || !game.active) return callback({ success: false });
        
        const multiplier = calculateMinesMultiplier(game.minesCount, game.revealed);
        const winAmount = Math.floor(game.bet * multiplier);
        
        db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
            [winAmount, winAmount, telegram_id]);
        
        game.active = false;
        minesState.delete(telegram_id);
        callback({ success: true, winAmount });
    });
    
    socket.on('roulette_place_bet', (data, callback) => {
        const { telegram_id, name, amount, avatar } = data;
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < amount) return callback({ success: false, error: 'Недостаточно звёзд!' });
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [amount, telegram_id]);
            
            const hue = Math.floor(Math.random() * 360);
            const color = `hsl(${hue}, 70%, 55%)`;
            
            rouletteBets.push({ telegram_id, name, amount, avatar: avatar || '👤', color });
            io.emit('roulette_update', [...rouletteBets]);
            callback({ success: true });
        });
    });
    
    socket.on('roulette_cancel_bet', ({ telegram_id }, callback) => {
        const betIndex = rouletteBets.findIndex(b => b.telegram_id === telegram_id);
        if (betIndex === -1) return callback({ success: false });
        
        const bet = rouletteBets[betIndex];
        db.run(`UPDATE users SET stars = stars + ?, games_played = games_played - 1 WHERE telegram_id = ?`, [bet.amount, telegram_id]);
        rouletteBets.splice(betIndex, 1);
        io.emit('roulette_update', [...rouletteBets]);
        callback({ success: true, amount: bet.amount });
    });
    
    socket.on('roulette_spin', () => {
        if (rouletteBets.length < 2) return;
        
        const total = rouletteBets.reduce((s, b) => s + b.amount, 0);
        let rand = Math.random() * total;
        let accum = 0;
        let winner = null;
        
        for (let bet of rouletteBets) {
            accum += bet.amount;
            if (rand <= accum) {
                winner = bet;
                break;
            }
        }
        
        if (winner) {
            db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                [total, total, winner.telegram_id]);
            io.emit('roulette_result', { winner, total });
        } else {
            io.emit('roulette_result', { winner: null, total });
        }
        
        rouletteBets = [];
        io.emit('roulette_update', []);
    });
    
    socket.on('roulette_get_bets', (callback) => {
        callback([...rouletteBets]);
    });
    
    socket.on('get_leaderboard', () => {
        db.all(`SELECT name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50`, (err, rows) => {
            io.emit('leaderboard_data', rows || []);
        });
    });
});

startRocketCountdown();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});