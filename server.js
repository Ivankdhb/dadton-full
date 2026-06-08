const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static('public'));

// ==================== БАЗА ДАННЫХ ====================
const db = new sqlite3.Database('dadton.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE,
        name TEXT,
        avatar TEXT,
        stars INTEGER DEFAULT 1000,
        turnover INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        referrer_id TEXT
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
});

console.log('✅ База данных готова');

// ==================== TELEGRAM STARS ====================
const BOT_TOKEN = '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Отправка уведомления админу в Telegram
async function notifyAdmin(message) {
    try {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: '1631627984',
                text: message,
                parse_mode: 'HTML'
            })
        });
    } catch(e) { console.log('Notify error:', e); }
}

app.post('/api/create-invoice', async (req, res) => {
    const { amount, initData } = req.body;
    
    if (!amount || amount < 1) {
        return res.json({ success: false, error: 'Неверная сумма' });
    }
    
    let userId = 'unknown';
    try {
        const params = new URLSearchParams(initData);
        const user = JSON.parse(params.get('user') || '{}');
        userId = user.id || 'unknown';
    } catch(e) {}
    
    try {
        const response = await fetch(`${TELEGRAM_API}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: "⭐ DadTon - Пополнение",
                description: `Покупка ${amount} звёзд`,
                payload: JSON.stringify({ userId, amount, type: 'stars' }),
                provider_token: "",
                currency: "XTR",
                prices: [{ label: "Звёзды", amount: parseInt(amount) }]
            })
        });
        
        const data = await response.json();
        
        if (data.ok) {
            res.json({ success: true, invoiceLink: data.result });
        } else {
            res.json({ success: false, error: data.description });
        }
    } catch (error) {
        console.error('Create invoice error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/telegram', async (req, res) => {
    const { pre_checkout_query, message } = req.body;
    
    if (pre_checkout_query) {
        await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pre_checkout_query_id: pre_checkout_query.id,
                ok: true
            })
        });
        return res.sendStatus(200);
    }
    
    if (message?.successful_payment) {
        const payment = message.successful_payment;
        const payload = JSON.parse(payment.invoice_payload);
        const starsAmount = payment.total_amount;
        const userId = payload.userId;
        
        db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [starsAmount, userId.toString()]);
        db.run(`INSERT INTO user_finance (telegram_id, deposited, withdrawn) VALUES (?, ?, 0) ON CONFLICT(telegram_id) DO UPDATE SET deposited = deposited + ?`, 
            [userId.toString(), starsAmount, starsAmount]);
        
        console.log(`✅ Пользователь ${userId} пополнил ${starsAmount}⭐`);
        await notifyAdmin(`💰 <b>ПОПОЛНЕНИЕ ЧЕРЕЗ STARS</b>\n👤 ID: ${userId}\n⭐ Сумма: +${starsAmount}`);
        return res.sendStatus(200);
    }
    
    res.sendStatus(200);
});

// ==================== API ЭНДПОИНТЫ ====================
app.post('/api/deposit-request', (req, res) => {
    const { telegram_id, name, amount, asset, stars } = req.body;
    console.log(`📩 ЗАЯВКА: ${name} (${telegram_id}) хочет пополнить ${amount} ${asset} -> ${stars}⭐`);
    notifyAdmin(`📩 <b>ЗАЯВКА НА ПОПОЛНЕНИЕ</b>\n👤 ${name}\n🆔 ${telegram_id}\n💎 ${amount} ${asset}\n⭐ ${stars}`);
    res.json({ success: true });
});

app.post('/api/withdraw-request', (req, res) => {
    const { telegram_id, stars_amount, asset, wallet_address } = req.body;
    
    db.get(`SELECT name, stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        if (!row || row.stars < stars_amount) {
            return res.json({ success: false, error: 'Недостаточно звёзд' });
        }
        
        db.run(`INSERT INTO withdraw_requests (telegram_id, name, amount, asset, wallet) VALUES (?, ?, ?, ?, ?)`,
            [telegram_id, row.name, stars_amount, asset, wallet_address]);
        
        notifyAdmin(`
🔴 <b>НОВАЯ ЗАЯВКА НА ВЫВОД</b>
👤 Игрок: ${row.name}
🆔 ID: ${telegram_id}
⭐ Сумма: ${stars_amount}
💳 Валюта: ${asset}
📮 Кошелёк: ${wallet_address}
        `);
        
        res.json({ success: true, message: 'Заявка отправлена админу' });
    });
});

app.post('/api/finance-stats', (req, res) => {
    const { telegram_id } = req.body;
    db.get(`SELECT deposited, withdrawn FROM user_finance WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        res.json({ deposited: row?.deposited || 0, withdrawn: row?.withdrawn || 0 });
    });
});

// ==================== АДМИН-ФУНКЦИИ ====================
const ADMIN_ID = '1631627984';

app.post('/api/admin/add-stars', (req, res) => {
    const { admin_id, target_telegram_id, stars_amount } = req.body;
    
    if (admin_id !== ADMIN_ID) {
        return res.json({ success: false, error: 'Доступ запрещён' });
    }
    
    if (!target_telegram_id || !stars_amount || stars_amount < 1) {
        return res.json({ success: false, error: 'Неверные данные' });
    }
    
    db.get(`SELECT name, stars FROM users WHERE telegram_id = ?`, [target_telegram_id], (err, row) => {
        if (!row) {
            return res.json({ success: false, error: 'Пользователь не найден' });
        }
        
        db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [stars_amount, target_telegram_id]);
        db.run(`INSERT INTO user_finance (telegram_id, deposited, withdrawn) VALUES (?, ?, 0) ON CONFLICT(telegram_id) DO UPDATE SET deposited = deposited + ?`, 
            [target_telegram_id, stars_amount, stars_amount]);
        
        notifyAdmin(`✅ <b>АДМИН ПОПОЛНИЛ БАЛАНС</b>\n📱 Пользователь: ${row.name}\n🆔 ID: ${target_telegram_id}\n⭐ Сумма: +${stars_amount}`);
        
        res.json({ success: true, message: `Пользователю ${row.name} добавлено ${stars_amount}⭐` });
    });
});

app.post('/api/admin/get-users', (req, res) => {
    const { admin_id } = req.body;
    
    if (admin_id !== ADMIN_ID) {
        return res.json({ success: false, error: 'Доступ запрещён' });
    }
    
    db.all(`SELECT telegram_id, name, stars, turnover FROM users ORDER BY stars DESC LIMIT 100`, (err, rows) => {
        res.json({ success: true, users: rows || [] });
    });
});

app.post('/api/admin/get-withdraw-requests', (req, res) => {
    const { admin_id } = req.body;
    
    if (admin_id !== ADMIN_ID) {
        return res.json({ success: false, error: 'Доступ запрещён' });
    }
    
    db.all(`SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC`, (err, rows) => {
        res.json({ success: true, requests: rows || [] });
    });
});

app.post('/api/admin/approve-withdraw', (req, res) => {
    const { admin_id, telegram_id, stars_amount } = req.body;
    
    if (admin_id !== ADMIN_ID) {
        return res.json({ success: false, error: 'Доступ запрещён' });
    }
    
    db.get(`SELECT stars, name FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        if (!row || row.stars < stars_amount) {
            return res.json({ success: false, error: 'Недостаточно средств' });
        }
        
        db.run(`UPDATE users SET stars = stars - ? WHERE telegram_id = ?`, [stars_amount, telegram_id]);
        db.run(`INSERT INTO user_finance (telegram_id, deposited, withdrawn) VALUES (?, 0, ?) ON CONFLICT(telegram_id) DO UPDATE SET withdrawn = withdrawn + ?`, 
            [telegram_id, stars_amount, stars_amount]);
        
        db.run(`UPDATE withdraw_requests SET status = 'approved' WHERE telegram_id = ? AND amount = ? AND status = 'pending'`,
            [telegram_id, stars_amount]);
        
        notifyAdmin(`✅ <b>ВЫВОД ПОДТВЕРЖДЁН</b>\n👤 Игрок: ${row.name}\n⭐ Сумма: ${stars_amount}\n💸 Статус: ВЫПОЛНЕН`);
        
        res.json({ success: true });
    });
});

// ==================== КОНСТАНТЫ ====================
const MAX_BET = 5000;
const MIN_BET = 10;

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
let rouletteIsSpinning = false;

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
    
    console.log(`🚀 Ракета взлетела! Краш: ${crash.toFixed(2)}x`);
    io.emit('rocket_start', { crashPoint: crash });
    
    if (rocketInterval) clearInterval(rocketInterval);
    
    let lastTime = Date.now();
    
    rocketInterval = setInterval(() => {
        if (rocketState.status !== 'flying') {
            clearInterval(rocketInterval);
            return;
        }
        
        const now = Date.now();
        const delta = Math.min(100, now - lastTime);
        lastTime = now;
        
        let speed = rocketState.currentMultiplier < 1.5 ? 0.008 : 0.012 + (rocketState.currentMultiplier - 1.5) * 0.003;
        speed = Math.min(speed, 0.035);
        
        rocketState.currentMultiplier += speed * (delta / 100);
        
        for (let bet of rocketState.bets) {
            if (!bet.cashedAt && bet.autoCashout && rocketState.currentMultiplier >= (bet.autoCashout - 0.005)) {
                const winAmount = Math.floor(bet.amount * rocketState.currentMultiplier);
                bet.cashedAt = rocketState.currentMultiplier;
                bet.winAmount = winAmount;
                
                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                    [winAmount, winAmount, bet.telegram_id]);
                
                io.emit('rocket_cashout_done', { 
                    name: bet.name, 
                    multiplier: rocketState.currentMultiplier, 
                    win: winAmount, 
                    amount: bet.amount, 
                    avatar: bet.avatar 
                });
            }
        }
        
        if (rocketState.currentMultiplier >= rocketState.crashPoint) {
            clearInterval(rocketInterval);
            rocketState.status = 'crashed';
            
            console.log(`💥 КРАШ! ${rocketState.currentMultiplier.toFixed(2)}x`);
            io.emit('rocket_crash', rocketState.currentMultiplier);
            
            db.run(`INSERT INTO rocket_history (multiplier) VALUES (?)`, [rocketState.currentMultiplier]);
            
            setTimeout(startRocketCountdown, 1500);
        } else {
            io.emit('rocket_multiplier', rocketState.currentMultiplier);
        }
    }, 50);
}

function calculateRouletteWinner() {
    let total = rouletteBets.reduce((s, b) => s + b.amount, 0);
    if (total === 0) return null;
    let rand = Math.random() * total;
    let accum = 0;
    for (let bet of rouletteBets) {
        accum += bet.amount;
        if (rand <= accum) return bet;
    }
    return null;
}

// ==================== СОКЕТЫ ====================
io.on('connection', (socket) => {
    console.log('👤 Игрок подключился');
    
    socket.on('register', (data, callback) => {
        const telegram_id = data.telegram_id;
        const name = data.name || 'Игрок';
        const avatar = data.avatar || '👤';
        const referrerId = data.referrer_id || null;
        
        if (!telegram_id) {
            if (callback) callback({ success: false, error: 'No telegram_id' });
            return;
        }
        
        db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row) {
                db.run(`INSERT INTO users (telegram_id, name, avatar, stars, referrer_id) VALUES (?, ?, ?, 1000, ?)`, 
                    [telegram_id, name, avatar, referrerId], function(err) {
                    if (err) {
                        if (callback) callback({ success: false, error: err.message });
                    } else {
                        db.run(`INSERT INTO user_finance (telegram_id, deposited, withdrawn) VALUES (?, 0, 0)`, [telegram_id]);
                        if (referrerId) {
                            db.run(`UPDATE users SET stars = stars + 100 WHERE telegram_id = ?`, [referrerId]);
                        }
                        if (callback) callback({ success: true, stars: 1000, name, telegram_id, avatar, turnover: 0, games_played: 0, wins: 0 });
                    }
                });
            } else {
                db.get(`SELECT deposited, withdrawn FROM user_finance WHERE telegram_id = ?`, [telegram_id], (err, finance) => {
                    if (callback) callback({ 
                        success: true, 
                        stars: row.stars, 
                        name: row.name, 
                        telegram_id, 
                        avatar: row.avatar || '👤', 
                        turnover: row.turnover || 0, 
                        games_played: row.games_played || 0, 
                        wins: row.wins || 0,
                        total_deposited: finance?.deposited || 0,
                        total_withdrawn: finance?.withdrawn || 0
                    });
                });
            }
        });
    });
    
    socket.on('get_balance', (telegram_id, callback) => {
        db.get(`SELECT stars, name, avatar, turnover, games_played, wins FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (row) {
                db.get(`SELECT deposited, withdrawn FROM user_finance WHERE telegram_id = ?`, [telegram_id], (err, finance) => {
                    if (callback) callback({ 
                        stars: row.stars, 
                        name: row.name, 
                        avatar: row.avatar || '👤', 
                        turnover: row.turnover || 0, 
                        games_played: row.games_played || 0, 
                        wins: row.wins || 0,
                        total_deposited: finance?.deposited || 0,
                        total_withdrawn: finance?.withdrawn || 0
                    });
                });
            } else {
                if (callback) callback({ stars: 1000 });
            }
        });
    });
    
    socket.on('get_referral_stats', (telegram_id, callback) => {
        db.get(`SELECT COUNT(*) as count, SUM(turnover) as total FROM users WHERE referrer_id = ?`, [telegram_id], (err, row) => {
            if (callback) callback({ count: row?.count || 0, earned: Math.floor((row?.total || 0) * 0.1) });
        });
    });
    
    socket.on('get_finance_stats', (telegram_id, callback) => {
        db.get(`SELECT deposited, withdrawn FROM user_finance WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (callback) callback({ deposited: row?.deposited || 0, withdrawn: row?.withdrawn || 0 });
        });
    });
    
    // ========== РАКЕТА ==========
    socket.on('rocket_place_bet', (data, callback) => {
        if (!data || rocketState.status !== 'waiting') {
            if (callback) callback({ success: false, error: 'Ставки только до взлёта!' });
            return;
        }
        
        const { telegram_id, name, amount, autoCashout, avatar } = data;
        
        if (amount < MIN_BET || amount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < amount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [amount, telegram_id]);
            
            rocketState.bets.push({
                telegram_id, name, amount, autoCashout: parseFloat(autoCashout) || 0,
                cashedAt: null, winAmount: null, avatar: avatar || '👤'
            });
            
            io.emit('rocket_bet_placed', { name, amount, autoCashout, avatar: avatar || '👤' });
            if (callback) callback({ success: true });
        });
    });
    
    socket.on('rocket_cancel_bet', (data, callback) => {
        const { telegram_id } = data;
        const betIndex = rocketState.bets.findIndex(b => b.telegram_id === telegram_id && !b.cashedAt);
        
        if (betIndex === -1) {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
            return;
        }
        
        const bet = rocketState.bets[betIndex];
        db.run(`UPDATE users SET stars = stars + ?, games_played = games_played - 1 WHERE telegram_id = ?`, [bet.amount, telegram_id]);
        rocketState.bets.splice(betIndex, 1);
        io.emit('rocket_bet_cancelled', { telegram_id, name: bet.name });
        if (callback) callback({ success: true, amount: bet.amount });
    });
    
    socket.on('rocket_cashout', (data, callback) => {
        if (rocketState.status !== 'flying') {
            if (callback) callback({ success: false, error: 'Сейчас нельзя забрать' });
            return;
        }
        
        const { telegram_id, name } = data;
        const bet = rocketState.bets.find(b => b.telegram_id === telegram_id && !b.cashedAt);
        
        if (!bet) {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
            return;
        }
        
        const winAmount = Math.floor(bet.amount * rocketState.currentMultiplier);
        bet.cashedAt = rocketState.currentMultiplier;
        bet.winAmount = winAmount;
        
        db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
            [winAmount, winAmount, telegram_id]);
        
        io.emit('rocket_cashout_done', { name, multiplier: rocketState.currentMultiplier, win: winAmount, amount: bet.amount, avatar: bet.avatar });
        if (callback) callback({ success: true, win: winAmount });
    });
    
    socket.on('rocket_get_history', () => {
        db.all(`SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10`, (err, rows) => {
            socket.emit('rocket_history_data', rows || []);
        });
    });
    
    // ========== МИНЫ ==========
    function calculateMinesMultiplier(minesCount, revealed) {
        let perCellMultiplier = 1;
        if (minesCount === 5) perCellMultiplier = 1.04;
        else if (minesCount === 10) perCellMultiplier = 1.12;
        else if (minesCount === 15) perCellMultiplier = 1.30;
        else if (minesCount === 20) perCellMultiplier = 2.00;
        else if (minesCount === 24) perCellMultiplier = 3.00;
        
        let multiplier = Math.pow(perCellMultiplier, revealed);
        return Math.min(multiplier, 500);
    }
    
    socket.on('mines_start', (data, callback) => {
        const { telegram_id, betAmount, minesCount } = data;
        
        if (betAmount < MIN_BET || betAmount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        if (minesCount < 1 || minesCount > 24) {
            if (callback) callback({ success: false, error: 'Мин от 1 до 24' });
            return;
        }
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < betAmount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [betAmount, telegram_id]);
            
            const totalCells = 25;
            const mineIndices = [];
            while (mineIndices.length < minesCount) {
                const idx = Math.floor(Math.random() * totalCells);
                if (!mineIndices.includes(idx)) mineIndices.push(idx);
            }
            
            minesState.set(telegram_id, {
                grid: mineIndices,
                bet: betAmount,
                minesCount: minesCount,
                revealed: 0,
                active: true
            });
            
            if (callback) callback({ success: true, minesCount: minesCount });
        });
    });
    
    socket.on('mines_reveal', (data, callback) => {
        const { telegram_id, cellIndex } = data;
        const game = minesState.get(telegram_id);
        
        if (!game || !game.active) {
            if (callback) callback({ success: false, error: 'Игра не активна' });
            return;
        }
        
        if (game.grid.includes(cellIndex)) {
            game.active = false;
            minesState.delete(telegram_id);
            if (callback) callback({ success: false, exploded: true });
            return;
        }
        
        game.revealed++;
        
        const totalCells = 25;
        const safeCells = totalCells - game.minesCount;
        const multiplier = calculateMinesMultiplier(game.minesCount, game.revealed);
        const winAmount = Math.floor(game.bet * multiplier);
        
        if (game.revealed === safeCells) {
            db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                [winAmount, winAmount, telegram_id]);
            game.active = false;
            minesState.delete(telegram_id);
            if (callback) callback({ success: true, revealed: game.revealed, multiplier: multiplier.toFixed(2), winAmount, finished: true });
        } else {
            if (callback) callback({ success: true, revealed: game.revealed, multiplier: multiplier.toFixed(2), winAmount });
        }
    });
    
    socket.on('mines_cashout', (data, callback) => {
        const { telegram_id } = data;
        const game = minesState.get(telegram_id);
        
        if (!game || !game.active) {
            if (callback) callback({ success: false, error: 'Игра не активна' });
            return;
        }
        
        const multiplier = calculateMinesMultiplier(game.minesCount, game.revealed);
        const winAmount = Math.floor(game.bet * multiplier);
        
        db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
            [winAmount, winAmount, telegram_id]);
        
        game.active = false;
        minesState.delete(telegram_id);
        
        if (callback) callback({ success: true, winAmount });
    });
    
    // ========== РУЛЕТКА ==========
    socket.on('roulette_place_bet', (data, callback) => {
        if (rouletteIsSpinning) {
            if (callback) callback({ success: false, error: 'Рулетка крутится!' });
            return;
        }
        
        const { telegram_id, name, amount, avatar } = data;
        
        if (amount < MIN_BET || amount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        if (rouletteBets.length >= 20) {
            if (callback) callback({ success: false, error: 'Достигнут лимит игроков' });
            return;
        }
        
        db.get(`SELECT stars FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
            if (!row || row.stars < amount) {
                if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
                return;
            }
            
            db.run(`UPDATE users SET stars = stars - ?, games_played = games_played + 1 WHERE telegram_id = ?`, [amount, telegram_id]);
            
            const hue = Math.floor(Math.random() * 360);
            const color = `hsl(${hue}, 70%, 55%)`;
            
            rouletteBets.push({ telegram_id, name, amount, avatar: avatar || '👤', color });
            io.emit('roulette_update', [...rouletteBets]);
            if (callback) callback({ success: true });
        });
    });
    
    socket.on('roulette_cancel_bet', (data, callback) => {
        const { telegram_id } = data;
        const betIndex = rouletteBets.findIndex(b => b.telegram_id === telegram_id);
        
        if (betIndex !== -1) {
            const bet = rouletteBets[betIndex];
            db.run(`UPDATE users SET stars = stars + ?, games_played = games_played - 1 WHERE telegram_id = ?`, [bet.amount, telegram_id]);
            rouletteBets.splice(betIndex, 1);
            io.emit('roulette_update', [...rouletteBets]);
            if (callback) callback({ success: true, amount: bet.amount });
        } else {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
        }
    });
    
    socket.on('roulette_spin', (callback) => {
        if (rouletteIsSpinning || rouletteBets.length < 2) {
            if (callback) callback({ success: false, error: 'Нужно минимум 2 участника!' });
            return;
        }
        
        rouletteIsSpinning = true;
        io.emit('roulette_spinning');
        
        setTimeout(() => {
            const winner = calculateRouletteWinner();
            const total = rouletteBets.reduce((s, b) => s + b.amount, 0);
            
            if (winner) {
                db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                    [total, total, winner.telegram_id]);
                io.emit('roulette_result', { winner, total });
            } else {
                io.emit('roulette_result', { winner: null, total });
            }
            
            rouletteBets = [];
            rouletteIsSpinning = false;
            io.emit('roulette_update', []);
            if (callback) callback({ success: true });
        }, 3000);
    });
    
    socket.on('roulette_get_bets', (callback) => {
        if (callback) callback([...rouletteBets]);
    });
    
    socket.on('get_leaderboard', () => {
        db.all(`SELECT name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50`, (err, rows) => {
            io.emit('leaderboard_data', rows || []);
        });
    });
});

startRocketCountdown();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});