const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== TON CONNECT MANIFEST (прямо в коде) ==========
app.get('/tonconnect-manifest.json', (req, res) => {
    res.json({
        url: "https://dadton-full.onrender.com",
        name: "DadTon Casino",
        iconUrl: "https://dadton-full.onrender.com/icon.png",
        termsOfUseUrl: "https://dadton-full.onrender.com/terms.html",
        privacyPolicyUrl: "https://dadton-full.onrender.com/privacy.html"
    });
});

// Иконка на лету (чтобы не было 404)
app.get('/icon.png', (req, res) => {
    const svg = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
        <rect width="256" height="256" fill="#0a0a0a" rx="40"/>
        <circle cx="128" cy="128" r="80" fill="#FFD700"/>
        <text x="128" y="150" font-size="64" text-anchor="middle" fill="#000" font-weight="900" font-family="Arial">D</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
});

// Заглушка для terms.html
app.get('/terms.html', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Terms of Use</title></head><body><h1>Terms of Use</h1><p>By using DadTon you agree to the terms...</p></body></html>`);
});

// Заглушка для privacy.html
app.get('/privacy.html', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Privacy Policy</title></head><body><h1>Privacy Policy</h1><p>Your data is safe with us...</p></body></html>`);
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ========== КОНФИГУРАЦИЯ ==========
const BOT_TOKEN = '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const ADMIN_ID = '1631627984';
const MERCHANT_WALLET = 'UQCEA1RKJ0eAZ_kvpN7tzhrCIh94XBw9ROSeQbaHPXOEOPRP';

const MIN_BET = 10;
const MAX_BET = 10000;

// ========== БД ==========
const db = new sqlite3.Database('./dadton.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE,
        name TEXT,
        avatar TEXT,
        username TEXT,
        stars INTEGER DEFAULT 1000,
        turnover INTEGER DEFAULT 0,
        games_played INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        referrer_id TEXT,
        wallet_address TEXT,
        banned INTEGER DEFAULT 0
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
        admin_added INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS withdraw_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        name TEXT,
        username TEXT,
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
        name TEXT,
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

    db.run(`CREATE TABLE IF NOT EXISTS games_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        game_type TEXT,
        game_name TEXT,
        bet_amount INTEGER,
        win_amount INTEGER,
        profit INTEGER,
        multiplier REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
async function sendTelegramMessage(chatId, text) {
    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        });
    } catch (e) {
        console.error('Ошибка отправки ТГ уведомления:', e.message);
    }
}

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function sendUserBalance(telegram_id) {
    db.get("SELECT stars FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
        if (row) {
            wss.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.telegram_id === telegram_id) {
                    client.send(JSON.stringify({ type: 'balance_update', stars: row.stars }));
                }
            });
        }
    });
}

function saveGameHistory(telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier) {
    db.run(`INSERT INTO games_history (telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`, 
            [telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier]);
}

function generateCrashPoint() {
    const rand = Math.random() * 100;
    if (rand < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2));
    if (rand < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2));
    if (rand < 70) return parseFloat((1.50 + Math.random() * 0.50).toFixed(2));
    if (rand < 85) return parseFloat((2.00 + Math.random() * 1.00).toFixed(2));
    if (rand < 95) return parseFloat((3.00 + Math.random() * 2.00).toFixed(2));
    return parseFloat((5.00 + Math.random() * 3.00).toFixed(2));
}

// ========== ЛОГИКА РАКЕТЫ ==========
let botPaused = false;
let rocketState = {
    status: 'waiting',
    multiplier: 1.00,
    crashPoint: 1.00,
    timer: 10,
    bets: []
};

function runRocketLoop() {
    if (botPaused) {
        setTimeout(runRocketLoop, 1000);
        return;
    }
    
    if (rocketState.status === 'waiting') {
        if (rocketState.timer > 0) {
            rocketState.timer--;
            let hasBet = rocketState.bets.some(b => !b.cashedOut);
            broadcast({ type: 'rocket_tick', timer: rocketState.timer, bets: rocketState.bets, hasBet });
            setTimeout(runRocketLoop, 1000);
        } else {
            rocketState.status = 'flying';
            rocketState.multiplier = 1.00;
            rocketState.crashPoint = generateCrashPoint();
            broadcast({ type: 'rocket_start', crashPoint: rocketState.crashPoint });
            setTimeout(runRocketLoop, 100);
        }
    } else if (rocketState.status === 'flying') {
        if (rocketState.multiplier >= rocketState.crashPoint) {
            rocketState.status = 'crashed';
            db.run("INSERT INTO rocket_history (multiplier) VALUES (?)", [rocketState.crashPoint]);
            broadcast({ type: 'rocket_crash', multiplier: rocketState.crashPoint });
            
            rocketState.bets.forEach(b => {
                if (!b.cashedOut) {
                    db.run("UPDATE users SET turnover = turnover + ?, games_played = games_played + 1 WHERE telegram_id = ?", 
                        [b.amount, b.telegram_id]);
                    saveGameHistory(b.telegram_id, 'rocket', 'Ракета', b.amount, 0, -b.amount, rocketState.crashPoint);
                    sendUserBalance(b.telegram_id);
                }
            });

            setTimeout(() => {
                rocketState.status = 'waiting';
                rocketState.multiplier = 1.00;
                rocketState.timer = 10;
                rocketState.bets = [];
                runRocketLoop();
            }, 3000);
        } else {
            let increment = 0.01;
            if (rocketState.multiplier > 2.0) increment = 0.03;
            if (rocketState.multiplier > 5.0) increment = 0.07;
            rocketState.multiplier = parseFloat((rocketState.multiplier + increment).toFixed(2));
            
            rocketState.bets.forEach(b => {
                if (!b.cashedOut && b.autoCashout && rocketState.multiplier >= b.autoCashoutValue && !b.cashingOut) {
                    b.cashingOut = true;
                    handleRocketCashout(b.telegram_id, b.autoCashoutValue);
                }
            });

            broadcast({ type: 'rocket_fly', multiplier: rocketState.multiplier });
            setTimeout(runRocketLoop, 150);
        }
    }
}

function handleRocketCashout(tgId, forceMultiplier = null) {
    let bet = rocketState.bets.find(b => b.telegram_id === tgId);
    if (!bet || bet.cashedOut || rocketState.status !== 'flying') return;

    bet.cashedOut = true;
    bet.multiplier = forceMultiplier || rocketState.multiplier;
    let winAmount = Math.floor(bet.amount * bet.multiplier);

    db.serialize(() => {
        db.run("UPDATE users SET stars = stars + ?, turnover = turnover + ?, games_played = games_played + 1, wins = wins + 1 WHERE telegram_id = ?", 
            [winAmount, bet.amount, tgId]);
        saveGameHistory(tgId, 'rocket', 'Ракета', bet.amount, winAmount, winAmount - bet.amount, bet.multiplier);
        sendUserBalance(tgId);
    });
    broadcast({ type: 'rocket_cashout_success', telegram_id: tgId, multiplier: bet.multiplier, winAmount });
}

// ========== ЛОГИКА РУЛЕТКИ ==========
let rouletteState = {
    status: 'waiting',
    timer: 15,
    bets: [],
    totalBank: 0,
    winner: null
};

function runRouletteLoop() {
    if (rouletteState.status === 'waiting') {
        if (rouletteState.bets.length >= 2) {
            if (rouletteState.timer > 0) {
                rouletteState.timer--;
                broadcast({ type: 'roulette_tick', timer: rouletteState.timer, bets: rouletteState.bets, total: rouletteState.totalBank });
                setTimeout(runRouletteLoop, 1000);
            } else {
                executeRouletteRoll();
            }
        } else {
            broadcast({ type: 'roulette_wait_players', bets: rouletteState.bets });
            setTimeout(runRouletteLoop, 2000);
        }
    }
}

function executeRouletteRoll() {
    rouletteState.status = 'rolling';
    let rand = Math.random() * rouletteState.totalBank;
    let currentWeight = 0;
    let winnerBet = rouletteState.bets[0];

    for (let b of rouletteState.bets) {
        currentWeight += b.amount;
        if (rand <= currentWeight) {
            winnerBet = b;
            break;
        }
    }

    rouletteState.winner = winnerBet;
    broadcast({ type: 'roulette_roll', winner: winnerBet, randomPoint: rand });

    setTimeout(() => {
        db.serialize(() => {
            db.run("UPDATE users SET stars = stars + ?, wins = wins + 1, games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", 
                [rouletteState.totalBank, winnerBet.amount, winnerBet.telegram_id]);
            saveGameHistory(winnerBet.telegram_id, 'roulette', 'Рулетка', winnerBet.amount, rouletteState.totalBank, 
                rouletteState.totalBank - winnerBet.amount, rouletteState.totalBank / winnerBet.amount);
            
            rouletteState.bets.forEach(b => {
                if (b.telegram_id !== winnerBet.telegram_id) {
                    db.run("UPDATE users SET games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", 
                        [b.amount, b.telegram_id]);
                    saveGameHistory(b.telegram_id, 'roulette', 'Рулетка', b.amount, 0, -b.amount, 0);
                }
                sendUserBalance(b.telegram_id);
            });
        });

        rouletteState.status = 'waiting';
        rouletteState.timer = 15;
        rouletteState.bets = [];
        rouletteState.totalBank = 0;
        rouletteState.winner = null;
        runRouletteLoop();
    }, 4000);
}

// ========== API ЭНДПОИНТЫ ==========
app.post('/api/register', (req, res) => {
    const { telegram_id, name, avatar, username, referrer_id } = req.body;
    db.get("SELECT * FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
        if (row) {
            db.run("UPDATE users SET name = ?, avatar = ?, username = ? WHERE telegram_id = ?", [name, avatar, username, telegram_id]);
            return res.json({ success: true, user: { ...row, avatar, name, username, stars: row.stars } });
        } else {
            let refId = (referrer_id && referrer_id !== telegram_id) ? referrer_id : null;
            db.run("INSERT INTO users (telegram_id, name, avatar, username, referrer_id) VALUES (?, ?, ?, ?, ?)", 
                [telegram_id, name, avatar, username, refId], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                db.run("INSERT INTO user_finance (telegram_id) VALUES (?)", [telegram_id]);
                res.json({ success: true, user: { telegram_id, name, avatar, username, stars: 1000 } });
            });
        }
    });
});

app.post('/api/get-balance', (req, res) => {
    db.get("SELECT stars, banned FROM users WHERE telegram_id = ?", [req.body.telegram_id], (err, row) => {
        if (row) res.json({ stars: row.stars, banned: row.banned });
        else res.status(404).json({ error: 'User not found' });
    });
});

app.post('/api/user-stats', (req, res) => {
    db.get("SELECT games_played, turnover, wins FROM users WHERE telegram_id = ?", [req.body.telegram_id], (err, row) => {
        if (row) res.json({ success: true, ...row });
        else res.json({ success: false });
    });
});

app.get('/api/rocket-history', (req, res) => {
    db.all("SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10", [], (err, rows) => {
        res.json(rows.map(r => r.multiplier));
    });
});

app.get('/api/leaderboard', (req, res) => {
    db.all("SELECT telegram_id, name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50", [], (err, rows) => {
        res.json(rows);
    });
});

app.post('/api/user-games-history', (req, res) => {
    db.all("SELECT game_type, game_name, bet_amount, win_amount, profit, multiplier, created_at FROM games_history WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 20", 
        [req.body.telegram_id], (err, rows) => {
            res.json(rows || []);
        });
});

app.post('/api/user-finance', (req, res) => {
    db.get("SELECT deposited, withdrawn, admin_added FROM user_finance WHERE telegram_id = ?", [req.body.telegram_id], (err, row) => {
        res.json(row || { deposited: 0, withdrawn: 0, admin_added: 0 });
    });
});

app.post('/api/user-referrals', (req, res) => {
    const { telegram_id } = req.body;
    db.all("SELECT * FROM referrals_log WHERE referrer_id = ? ORDER BY created_at DESC", [telegram_id], (err, rows) => {
        let earned = rows.reduce((sum, r) => sum + r.earned, 0);
        res.json({ count: rows.length, earned, referrals: rows });
    });
});

// Сохранение кошелька
app.post('/api/save-wallet', (req, res) => {
    const { telegram_id, wallet_address } = req.body;
    if (!telegram_id || !wallet_address) {
        return res.json({ success: false, msg: 'Missing data' });
    }
    db.run("UPDATE users SET wallet_address = ? WHERE telegram_id = ?", [wallet_address, telegram_id], (err) => {
        if (err) {
            console.error('Save wallet error:', err);
            return res.json({ success: false, msg: err.message });
        }
        res.json({ success: true });
    });
});

app.post('/api/cancel-rocket-bet', (req, res) => {
    const { telegram_id } = req.body;
    let betIndex = rocketState.bets.findIndex(b => b.telegram_id === telegram_id && !b.cashedOut);
    if (betIndex !== -1 && rocketState.status === 'waiting') {
        let bet = rocketState.bets[betIndex];
        db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [bet.amount, telegram_id], () => {
            sendUserBalance(telegram_id);
        });
        rocketState.bets.splice(betIndex, 1);
        broadcast({ type: 'rocket_bet_cancelled', telegram_id });
        res.json({ success: true });
    } else {
        res.json({ success: false, msg: 'Нельзя отменить' });
    }
});

app.post('/api/cancel-roulette-bet', (req, res) => {
    const { telegram_id } = req.body;
    let betIndex = rouletteState.bets.findIndex(b => b.telegram_id === telegram_id);
    if (betIndex !== -1 && rouletteState.status === 'waiting') {
        let bet = rouletteState.bets[betIndex];
        db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [bet.amount, telegram_id], () => {
            sendUserBalance(telegram_id);
        });
        rouletteState.totalBank -= bet.amount;
        rouletteState.bets.splice(betIndex, 1);
        broadcast({ type: 'roulette_bets_update', bets: rouletteState.bets, total: rouletteState.totalBank });
        res.json({ success: true });
    } else {
        res.json({ success: false, msg: 'Нельзя отменить' });
    }
});

// ========== МИНЫ ==========
let activeMineGames = {};

app.post('/api/games/mines/start', (req, res) => {
    const { telegram_id, amount, minesCount } = req.body;
    if (amount < MIN_BET || amount > MAX_BET) {
        return res.json({ success: false, msg: 'Сумма ставки вне лимитов' });
    }
    
    db.get("SELECT stars, banned FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
        if (!row || row.banned) return res.json({ success: false, msg: 'Блокировка' });
        if (row.stars < amount) return res.json({ success: false, msg: 'Недостаточно средств' });
        
        let board = Array(25).fill(false);
        let placed = 0;
        while (placed < minesCount) {
            let idx = Math.floor(Math.random() * 25);
            if (!board[idx]) { board[idx] = true; placed++; }
        }

        db.run("UPDATE users SET stars = stars - ? WHERE telegram_id = ?", [amount, telegram_id], () => {
            activeMineGames[telegram_id] = {
                bet: amount,
                minesCount: parseInt(minesCount),
                board: board,
                revealed: [],
                status: 'active'
            };
            sendUserBalance(telegram_id);
            res.json({ success: true });
        });
    });
});

app.post('/api/games/mines/reveal', (req, res) => {
    const { telegram_id, index } = req.body;
    let game = activeMineGames[telegram_id];
    if (!game || game.status !== 'active') return res.json({ success: false });

    if (game.board[index]) {
        game.status = 'lost';
        db.run("UPDATE users SET games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", [game.bet, telegram_id], () => {
            sendUserBalance(telegram_id);
        });
        saveGameHistory(telegram_id, 'mines', `Мины ${game.minesCount}`, game.bet, 0, -game.bet, 0);
        delete activeMineGames[telegram_id];
        return res.json({ success: true, hitMine: true, board: game.board });
    } else {
        if (!game.revealed.includes(index)) game.revealed.push(index);
        
        let base = 1.04;
        if (game.minesCount === 10) base = 1.12;
        if (game.minesCount === 15) base = 1.30;
        if (game.minesCount === 20) base = 2.00;
        if (game.minesCount === 24) base = 3.00;

        let currentMultiplier = parseFloat(Math.pow(base, game.revealed.length).toFixed(2));
        let maxSafe = 25 - game.minesCount;

        if (game.revealed.length === maxSafe) {
            let winAmount = Math.floor(game.bet * currentMultiplier);
            db.run("UPDATE users SET stars = stars + ?, wins = wins + 1, games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", 
                [winAmount, game.bet, telegram_id], () => {
                    sendUserBalance(telegram_id);
                });
            saveGameHistory(telegram_id, 'mines', `Мины ${game.minesCount}`, game.bet, winAmount, winAmount - game.bet, currentMultiplier);
            delete activeMineGames[telegram_id];
            return res.json({ success: true, win: true, winAmount, multiplier: currentMultiplier });
        }

        res.json({ success: true, hitMine: false, multiplier: currentMultiplier });
    }
});

app.post('/api/games/mines/cashout', (req, res) => {
    const { telegram_id } = req.body;
    let game = activeMineGames[telegram_id];
    if (!game || game.status !== 'active' || game.revealed.length === 0) return res.json({ success: false });

    let base = 1.04;
    if (game.minesCount === 10) base = 1.12;
    if (game.minesCount === 15) base = 1.30;
    if (game.minesCount === 20) base = 2.00;
    if (game.minesCount === 24) base = 3.00;

    let currentMultiplier = parseFloat(Math.pow(base, game.revealed.length).toFixed(2));
    let winAmount = Math.floor(game.bet * currentMultiplier);

    db.run("UPDATE users SET stars = stars + ?, wins = wins + 1, games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", 
        [winAmount, game.bet, telegram_id], () => {
            sendUserBalance(telegram_id);
        });
    saveGameHistory(telegram_id, 'mines', `Мины ${game.minesCount}`, game.bet, winAmount, winAmount - game.bet, currentMultiplier);
    delete activeMineGames[telegram_id];
    res.json({ success: true, winAmount, multiplier: currentMultiplier });
});

// ========== ВЫВОД СРЕДСТВ ==========
app.post('/api/withdraw-request', (req, res) => {
    const { telegram_id, name, username, amount, asset, wallet } = req.body;
    if (amount < 100) return res.json({ success: false, msg: 'Минимальная сумма вывода 100⭐' });
    
    db.get("SELECT stars FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
        if (!row || row.stars < amount) return res.json({ success: false, msg: 'Недостаточно звёзд' });
        
        db.serialize(() => {
            db.run("UPDATE users SET stars = stars - ? WHERE telegram_id = ?", [amount, telegram_id], () => {
                sendUserBalance(telegram_id);
            });
            db.run("INSERT INTO withdraw_requests (telegram_id, name, username, amount, asset, wallet) VALUES (?, ?, ?, ?, ?, ?)",
                [telegram_id, name, username, amount, asset, wallet]);
            db.run("UPDATE user_finance SET withdrawn = withdrawn + ? WHERE telegram_id = ?", [amount, telegram_id]);
            
            let messageText = `🔴 <b>НОВАЯ ЗАЯВКА НА ВЫВОД</b>\n\n`;
            messageText += `👤 Имя: ${name}\n`;
            messageText += `🔖 Юзернейм: ${username ? '@' + username.replace('@', '') : 'отсутствует'}\n`;
            messageText += `🆔 Telegram ID: <code>${telegram_id}</code>\n`;
            messageText += `⭐ Сумма: <b>${amount} ⭐</b>\n`;
            messageText += `💳 Валюта: <b>${asset}</b>\n`;
            if (asset !== 'Stars') messageText += `📮 Кошелёк: <code>${wallet}</code>\n`;

            sendTelegramMessage(ADMIN_ID, messageText);
            res.json({ success: true, commission: Math.floor(amount * 0.15) });
        });
    });
});

// ========== TELEGRAM STARS ИНВОЙСЫ ==========
app.post('/api/create-invoice', async (req, res) => {
    const { telegram_id, amount } = req.body;
    if (amount < 1) return res.json({ success: false, error: 'Минимальная сумма 1 звезда' });
    
    try {
        const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            title: `Пополнение DadTon`,
            description: `Зачисление ${amount} звёзд на игровой аккаунт`,
            payload: `stars_deposit_${telegram_id}_${Date.now()}`,
            provider_token: "",
            currency: "XTR",
            prices: [{ label: `${amount} Stars`, amount: parseInt(amount) }]
        });
        if (response.data && response.data.ok) {
            res.json({ success: true, invoice_link: response.data.result });
        } else {
            res.json({ success: false, error: 'Ошибка Telegram API' });
        }
    } catch (e) {
        console.error('Create invoice error:', e.message);
        res.json({ success: false, error: e.message });
    }
});

// ========== WEBHOOK ДЛЯ ОПЛАТ STARS ==========
app.post('/webhook/telegram', (req, res) => {
    const update = req.body;
    
    if (update.pre_checkout_query) {
        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
            pre_checkout_query_id: update.pre_checkout_query.id,
            ok: true
        }).catch(e => console.error('PreCheckout error:', e.message));
        return res.sendStatus(200);
    }

    if (update.message && update.message.successful_payment) {
        const payment = update.message.successful_payment;
        const payload = payment.invoice_payload;
        if (payload && payload.startsWith('stars_deposit_')) {
            const parts = payload.split('_');
            const tgId = parts[2];
            const amount = payment.total_amount;

            db.serialize(() => {
                db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [amount, tgId], () => {
                    sendUserBalance(tgId);
                });
                db.run("UPDATE user_finance SET deposited = deposited + ? WHERE telegram_id = ?", [amount, tgId]);
                
                db.get("SELECT referrer_id, name FROM users WHERE telegram_id = ?", [tgId], (err, uRow) => {
                    if (uRow && uRow.referrer_id) {
                        let refBonus = Math.floor(amount * 0.05);
                        db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [refBonus, uRow.referrer_id], () => {
                            sendUserBalance(uRow.referrer_id);
                        });
                        db.run("INSERT INTO referrals_log (referrer_id, referred_id, name, amount, earned) VALUES (?, ?, ?, ?, ?)",
                            [uRow.referrer_id, tgId, uRow.name || 'Игрок', amount, refBonus]);
                    }
                });
                
                sendTelegramMessage(ADMIN_ID, `🟢 <b>ПОПОЛНЕНИЕ</b>\n👤 ID: ${tgId}\n⭐ Сумма: ${amount} Stars`);
            });
        }
    }
    res.sendStatus(200);
});

// ========== АДМИН-ПАНЕЛЬ ==========
app.post('/api/admin/get-users', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    db.all("SELECT telegram_id, name, stars, games_played, wins, banned FROM users LIMIT 50", [], (err, rows) => { 
        res.json(rows || []); 
    });
});

app.post('/api/admin/get-withdraw-requests', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    db.all("SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC", [], (err, rows) => { 
        res.json(rows || []); 
    });
});

app.post('/api/admin/approve-withdraw', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const { request_id } = req.body;
    db.get("SELECT * FROM withdraw_requests WHERE id = ?", [request_id], (err, row) => {
        if (row) {
            db.run("UPDATE withdraw_requests SET status = 'approved' WHERE id = ?", [request_id], () => {
                sendTelegramMessage(row.telegram_id, `✅ Ваша заявка на вывод ${row.amount}⭐ подтверждена!`);
                res.json({ success: true });
            });
        } else res.json({ success: false });
    });
});

app.post('/api/admin/add-stars', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const { target_id, amount } = req.body;
    db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [amount, target_id], () => {
        db.run("UPDATE user_finance SET admin_added = admin_added + ? WHERE telegram_id = ?", [amount, target_id]);
        sendUserBalance(target_id);
        res.json({ success: true });
    });
});

app.post('/api/admin/ban-user', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    db.run("UPDATE users SET banned = 1 WHERE telegram_id = ?", [req.body.target_id], () => res.json({ success: true }));
});

app.post('/api/admin/unban-user', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    db.run("UPDATE users SET banned = 0 WHERE telegram_id = ?", [req.body.target_id], () => res.json({ success: true }));
});

app.post('/api/admin/pause-bot', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    botPaused = true;
    res.json({ success: true });
});

app.post('/api/admin/resume-bot', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    botPaused = false;
    res.json({ success: true });
});

// ========== WEBSOCKET ОБРАБОТКА ==========
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'auth') {
                ws.telegram_id = data.telegram_id;
            }
            if (data.type === 'rocket_bet') {
                if (rocketState.status !== 'waiting') {
                    return ws.send(JSON.stringify({ type: 'err', msg: 'Раунд уже идёт!' }));
                }
                if (data.amount < MIN_BET || data.amount > MAX_BET) {
                    return ws.send(JSON.stringify({ type: 'err', msg: 'Сумма вне лимитов' }));
                }
                db.get("SELECT stars, banned FROM users WHERE telegram_id = ?", [data.telegram_id], (err, row) => {
                    if (err || !row || row.banned) return;
                    if (row.stars >= data.amount) {
                        db.run("UPDATE users SET stars = stars - ? WHERE telegram_id = ?", [data.amount, data.telegram_id], () => {
                            rocketState.bets.push({
                                telegram_id: data.telegram_id,
                                name: data.name,
                                avatar: data.avatar || '',
                                amount: data.amount,
                                autoCashout: data.autoCashout || false,
                                autoCashoutValue: parseFloat(data.autoCashoutValue) || 1.5,
                                cashedOut: false,
                                cashingOut: false
                            });
                            sendUserBalance(data.telegram_id);
                            broadcast({ type: 'rocket_bets_update', bets: rocketState.bets });
                        });
                    }
                });
            }
            if (data.type === 'rocket_cashout') {
                handleRocketCashout(data.telegram_id);
            }
            if (data.type === 'cancel_rocket_bet') {
                let betIndex = rocketState.bets.findIndex(b => b.telegram_id === data.telegram_id && !b.cashedOut);
                if (betIndex !== -1 && rocketState.status === 'waiting') {
                    let bet = rocketState.bets[betIndex];
                    db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [bet.amount, data.telegram_id], () => {
                        sendUserBalance(data.telegram_id);
                    });
                    rocketState.bets.splice(betIndex, 1);
                    broadcast({ type: 'rocket_bet_cancelled', telegram_id: data.telegram_id });
                }
            }
            if (data.type === 'roulette_bet') {
                if (rouletteState.status !== 'waiting') return;
                if (data.amount < MIN_BET || data.amount > MAX_BET) return;
                db.get("SELECT stars, banned FROM users WHERE telegram_id = ?", [data.telegram_id], (err, row) => {
                    if (err || !row || row.banned) return;
                    if (row.stars >= data.amount) {
                        db.run("UPDATE users SET stars = stars - ? WHERE telegram_id = ?", [data.amount, data.telegram_id], () => {
                            const colors = ['#ff4444', '#00cc66', '#3B82F6', '#FFD700', '#A855F7', '#FF6B6B', '#4ECDC4'];
                            const randomColor = colors[rouletteState.bets.length % colors.length];
                            rouletteState.bets.push({
                                telegram_id: data.telegram_id,
                                name: data.name,
                                avatar: data.avatar || '',
                                amount: data.amount,
                                color: randomColor
                            });
                            rouletteState.totalBank += data.amount;
                            sendUserBalance(data.telegram_id);
                            broadcast({ type: 'roulette_bets_update', bets: rouletteState.bets, total: rouletteState.totalBank });
                        });
                    }
                });
            }
            if (data.type === 'cancel_roulette_bet') {
                let betIndex = rouletteState.bets.findIndex(b => b.telegram_id === data.telegram_id);
                if (betIndex !== -1 && rouletteState.status === 'waiting') {
                    let bet = rouletteState.bets[betIndex];
                    db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [bet.amount, data.telegram_id], () => {
                        sendUserBalance(data.telegram_id);
                    });
                    rouletteState.totalBank -= bet.amount;
                    rouletteState.bets.splice(betIndex, 1);
                    broadcast({ type: 'roulette_bets_update', bets: rouletteState.bets, total: rouletteState.totalBank });
                }
            }
        } catch (e) { console.error('WebSocket error:', e); }
    });
});

// ========== ЗАПУСК ==========
runRocketLoop();
runRouletteLoop();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));