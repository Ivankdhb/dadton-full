const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ========== КОНФИГУРАЦИЯ ==========
const BOT_TOKEN = '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const ADMIN_ID = '1631627984';
const MERCHANT_WALLET = 'UQCEA1RKJ0eAZ_kvpN7tzhrCIh94XBw9ROSeQbaHPXOEOPRP';
const TON_API_KEY = '06d6391b22c661acad89e10e47a3ff85eaaa179012354d517460508fbc91dabd';

const MIN_BET = 10;
const MAX_BET = 10000;

// ========== ПОДКЛЮЧЕНИЕ К POSTGRESQL ==========
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/dadton',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ========== ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ ==========
async function initDatabase() {
    const client = await pool.connect();
    try {
        // Users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
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
            )
        `);

        // Rocket history
        await client.query(`
            CREATE TABLE IF NOT EXISTS rocket_history (
                id SERIAL PRIMARY KEY,
                multiplier REAL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // User finance
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_finance (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT UNIQUE,
                deposited INTEGER DEFAULT 0,
                withdrawn INTEGER DEFAULT 0,
                admin_added INTEGER DEFAULT 0,
                admin_removed INTEGER DEFAULT 0
            )
        `);

        // Withdraw requests
        await client.query(`
            CREATE TABLE IF NOT EXISTS withdraw_requests (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT,
                name TEXT,
                username TEXT,
                amount INTEGER,
                asset TEXT,
                wallet TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Referrals log
        await client.query(`
            CREATE TABLE IF NOT EXISTS referrals_log (
                id SERIAL PRIMARY KEY,
                referrer_id TEXT,
                referred_id TEXT,
                name TEXT,
                amount INTEGER,
                earned INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Games history
        await client.query(`
            CREATE TABLE IF NOT EXISTS games_history (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT,
                game_type TEXT,
                game_name TEXT,
                bet_amount INTEGER,
                win_amount INTEGER,
                profit INTEGER,
                multiplier REAL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Pending payments - ПРАВИЛЬНАЯ СТРУКТУРА (пересоздаём для гарантии)
        await client.query(`DROP TABLE IF EXISTS pending_payments CASCADE`);
        await client.query(`
            CREATE TABLE pending_payments (
                id SERIAL PRIMARY KEY,
                telegram_id TEXT NOT NULL,
                order_id TEXT UNIQUE NOT NULL,
                amount REAL NOT NULL,
                stars_amount INTEGER NOT NULL,
                payload TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                tx_hash TEXT
            )
        `);

        console.log('✅ Все таблицы PostgreSQL созданы/обновлены');
    } catch (err) {
        console.error('Ошибка инициализации БД:', err);
    } finally {
        client.release();
    }
}

// Запускаем инициализацию
initDatabase();

// ========== TON CONNECT MANIFEST ==========
app.get('/tonconnect-manifest.json', (req, res) => {
    res.json({
        url: "https://dadton-full.onrender.com",
        name: "DadTon Casino",
        iconUrl: "https://dadton-full.onrender.com/icon.png",
        termsOfUseUrl: "https://dadton-full.onrender.com/terms.html",
        privacyPolicyUrl: "https://dadton-full.onrender.com/privacy.html"
    });
});

app.get('/icon.png', (req, res) => {
    const svg = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
        <rect width="256" height="256" fill="#0a0a0a" rx="40"/>
        <circle cx="128" cy="128" r="80" fill="#FFD700"/>
        <text x="128" y="150" font-size="64" text-anchor="middle" fill="#000" font-weight="900" font-family="Arial">D</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
});

app.get('/terms.html', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Terms of Use</title></head><body><h1>Terms of Use</h1><p>By using DadTon you agree to the terms...</p></body></html>`);
});

app.get('/privacy.html', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Privacy Policy</title></head><body><h1>Privacy Policy</h1><p>Your data is safe with us...</p></body></html>`);
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

async function sendUserBalance(telegram_id) {
    const result = await pool.query("SELECT stars FROM users WHERE telegram_id = $1", [telegram_id]);
    if (result.rows[0]) {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.telegram_id === telegram_id) {
                client.send(JSON.stringify({ type: 'balance_update', stars: result.rows[0].stars }));
            }
        });
    }
}

async function saveGameHistory(telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier) {
    await pool.query(
        `INSERT INTO games_history (telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier]
    );
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
            pool.query("INSERT INTO rocket_history (multiplier) VALUES ($1)", [rocketState.crashPoint]);
            broadcast({ type: 'rocket_crash', multiplier: rocketState.crashPoint });
            
            rocketState.bets.forEach(async (b) => {
                if (!b.cashedOut) {
                    await pool.query("UPDATE users SET turnover = turnover + $1, games_played = games_played + 1 WHERE telegram_id = $2", 
                        [b.amount, b.telegram_id]);
                    await saveGameHistory(b.telegram_id, 'rocket', 'Ракета', b.amount, 0, -b.amount, rocketState.crashPoint);
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

async function handleRocketCashout(tgId, forceMultiplier = null) {
    let bet = rocketState.bets.find(b => b.telegram_id === tgId);
    if (!bet || bet.cashedOut || rocketState.status !== 'flying') return;

    bet.cashedOut = true;
    bet.multiplier = forceMultiplier || rocketState.multiplier;
    let winAmount = Math.floor(bet.amount * bet.multiplier);

    await pool.query(
        "UPDATE users SET stars = stars + $1, turnover = turnover + $2, games_played = games_played + 1, wins = wins + 1 WHERE telegram_id = $3",
        [winAmount, bet.amount, tgId]
    );
    await saveGameHistory(tgId, 'rocket', 'Ракета', bet.amount, winAmount, winAmount - bet.amount, bet.multiplier);
    sendUserBalance(tgId);
    
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

async function executeRouletteRoll() {
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

    setTimeout(async () => {
        await pool.query(
            "UPDATE users SET stars = stars + $1, wins = wins + 1, games_played = games_played + 1, turnover = turnover + $2 WHERE telegram_id = $3",
            [rouletteState.totalBank, winnerBet.amount, winnerBet.telegram_id]
        );
        await saveGameHistory(winnerBet.telegram_id, 'roulette', 'Рулетка', winnerBet.amount, rouletteState.totalBank, 
            rouletteState.totalBank - winnerBet.amount, rouletteState.totalBank / winnerBet.amount);
        
        for (let b of rouletteState.bets) {
            if (b.telegram_id !== winnerBet.telegram_id) {
                await pool.query("UPDATE users SET games_played = games_played + 1, turnover = turnover + $1 WHERE telegram_id = $2", 
                    [b.amount, b.telegram_id]);
                await saveGameHistory(b.telegram_id, 'roulette', 'Рулетка', b.amount, 0, -b.amount, 0);
            }
            sendUserBalance(b.telegram_id);
        }

        rouletteState.status = 'waiting';
        rouletteState.timer = 15;
        rouletteState.bets = [];
        rouletteState.totalBank = 0;
        rouletteState.winner = null;
        runRouletteLoop();
    }, 4000);
}

// ========== API ЭНДПОИНТЫ ==========
app.post('/api/register', async (req, res) => {
    const { telegram_id, name, avatar, username, referrer_id } = req.body;
    
    const existing = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
    if (existing.rows[0]) {
        await pool.query("UPDATE users SET name = $1, avatar = $2, username = $3 WHERE telegram_id = $4", 
            [name, avatar, username, telegram_id]);
        return res.json({ success: true, user: { ...existing.rows[0], avatar, name, username, stars: existing.rows[0].stars } });
    } else {
        let refId = (referrer_id && referrer_id !== telegram_id) ? referrer_id : null;
        await pool.query(
            "INSERT INTO users (telegram_id, name, avatar, username, referrer_id) VALUES ($1, $2, $3, $4, $5)",
            [telegram_id, name, avatar, username, refId]
        );
        await pool.query("INSERT INTO user_finance (telegram_id) VALUES ($1)", [telegram_id]);
        res.json({ success: true, user: { telegram_id, name, avatar, username, stars: 1000 } });
    }
});

app.post('/api/get-balance', async (req, res) => {
    const result = await pool.query("SELECT stars, banned FROM users WHERE telegram_id = $1", [req.body.telegram_id]);
    if (result.rows[0]) res.json({ stars: result.rows[0].stars, banned: result.rows[0].banned });
    else res.status(404).json({ error: 'User not found' });
});

app.post('/api/user-stats', async (req, res) => {
    const result = await pool.query("SELECT games_played, turnover, wins FROM users WHERE telegram_id = $1", [req.body.telegram_id]);
    if (result.rows[0]) res.json({ success: true, ...result.rows[0] });
    else res.json({ success: false });
});

app.get('/api/rocket-history', async (req, res) => {
    const result = await pool.query("SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10");
    res.json(result.rows.map(r => r.multiplier));
});

app.get('/api/leaderboard', async (req, res) => {
    const result = await pool.query("SELECT telegram_id, name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50");
    res.json(result.rows);
});

app.post('/api/user-games-history', async (req, res) => {
    const result = await pool.query(
        "SELECT game_type, game_name, bet_amount, win_amount, profit, multiplier, created_at FROM games_history WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 20",
        [req.body.telegram_id]
    );
    res.json(result.rows);
});

app.post('/api/user-finance', async (req, res) => {
    const result = await pool.query("SELECT deposited, withdrawn, admin_added, admin_removed FROM user_finance WHERE telegram_id = $1", 
        [req.body.telegram_id]);
    res.json(result.rows[0] || { deposited: 0, withdrawn: 0, admin_added: 0, admin_removed: 0 });
});

app.post('/api/user-referrals', async (req, res) => {
    const { telegram_id } = req.body;
    const result = await pool.query("SELECT * FROM referrals_log WHERE referrer_id = $1 ORDER BY created_at DESC", [telegram_id]);
    let earned = result.rows.reduce((sum, r) => sum + r.earned, 0);
    res.json({ count: result.rows.length, earned, referrals: result.rows });
});

app.post('/api/save-wallet', async (req, res) => {
    const { telegram_id, wallet_address } = req.body;
    if (!telegram_id || !wallet_address) {
        return res.json({ success: false, msg: 'Missing data' });
    }
    await pool.query("UPDATE users SET wallet_address = $1 WHERE telegram_id = $2", [wallet_address, telegram_id]);
    res.json({ success: true });
});

// ========== ПЛАТЕЖИ ==========
app.post('/api/pending-payment', async (req, res) => {
    const { telegram_id, amount, order_id, payload } = req.body;
    const starsAmount = Math.floor(amount * 100);
    
    console.log('📝 Creating pending payment:', { telegram_id, amount, order_id, starsAmount });
    
    try {
        const result = await pool.query(
            `INSERT INTO pending_payments (telegram_id, order_id, amount, stars_amount, payload) 
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [telegram_id, order_id, amount, starsAmount, payload]
        );
        console.log('✅ Pending payment created:', result.rows[0]);
        res.json({ success: true, order_id });
    } catch (err) {
        console.error('❌ Pending payment error:', err.message);
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/check-payment-status', async (req, res) => {
    const { order_id } = req.body;
    const result = await pool.query(
        "SELECT status, amount, stars_amount FROM pending_payments WHERE order_id = $1",
        [order_id]
    );
    if (result.rows[0]) {
        res.json({
            status: result.rows[0].status,
            amount: result.rows[0].amount,
            stars: result.rows[0].stars_amount
        });
    } else {
        res.json({ status: 'not_found' });
    }
});

app.post('/api/cancel-rocket-bet', (req, res) => {
    const { telegram_id } = req.body;
    let betIndex = rocketState.bets.findIndex(b => b.telegram_id === telegram_id && !b.cashedOut);
    if (betIndex !== -1 && rocketState.status === 'waiting') {
        let bet = rocketState.bets[betIndex];
        pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [bet.amount, telegram_id]);
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
        pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [bet.amount, telegram_id]);
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

app.post('/api/games/mines/start', async (req, res) => {
    const { telegram_id, amount, minesCount } = req.body;
    if (amount < MIN_BET || amount > MAX_BET) {
        return res.json({ success: false, msg: 'Сумма ставки вне лимитов' });
    }
    
    const user = await pool.query("SELECT stars, banned FROM users WHERE telegram_id = $1", [telegram_id]);
    if (!user.rows[0] || user.rows[0].banned) return res.json({ success: false, msg: 'Блокировка' });
    if (user.rows[0].stars < amount) return res.json({ success: false, msg: 'Недостаточно средств' });
    
    let board = Array(25).fill(false);
    let placed = 0;
    while (placed < minesCount) {
        let idx = Math.floor(Math.random() * 25);
        if (!board[idx]) { board[idx] = true; placed++; }
    }

    await pool.query("UPDATE users SET stars = stars - $1 WHERE telegram_id = $2", [amount, telegram_id]);
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

app.post('/api/games/mines/reveal', async (req, res) => {
    const { telegram_id, index } = req.body;
    let game = activeMineGames[telegram_id];
    if (!game || game.status !== 'active') return res.json({ success: false });

    if (game.board[index]) {
        game.status = 'lost';
        await pool.query("UPDATE users SET games_played = games_played + 1, turnover = turnover + $1 WHERE telegram_id = $2", 
            [game.bet, telegram_id]);
        await saveGameHistory(telegram_id, 'mines', `Мины ${game.minesCount}`, game.bet, 0, -game.bet, 0);
        delete activeMineGames[telegram_id];
        sendUserBalance(telegram_id);
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
            await pool.query("UPDATE users SET stars = stars + $1, wins = wins + 1, games_played = games_played + 1, turnover = turnover + $2 WHERE telegram_id = $3", 
                [winAmount, game.bet, telegram_id]);
            await saveGameHistory(telegram_id, 'mines', `Мины ${game.minesCount}`, game.bet, winAmount, winAmount - game.bet, currentMultiplier);
            delete activeMineGames[telegram_id];
            sendUserBalance(telegram_id);
            return res.json({ success: true, win: true, winAmount, multiplier: currentMultiplier });
        }

        res.json({ success: true, hitMine: false, multiplier: currentMultiplier });
    }
});

app.post('/api/games/mines/cashout', async (req, res) => {
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

    await pool.query("UPDATE users SET stars = stars + $1, wins = wins + 1, games_played = games_played + 1, turnover = turnover + $2 WHERE telegram_id = $3", 
        [winAmount, game.bet, telegram_id]);
    await saveGameHistory(telegram_id, 'mines', `Мины ${game.minesCount}`, game.bet, winAmount, winAmount - game.bet, currentMultiplier);
    delete activeMineGames[telegram_id];
    sendUserBalance(telegram_id);
    res.json({ success: true, winAmount, multiplier: currentMultiplier });
});

// ========== ВЫВОД СРЕДСТВ ==========
app.post('/api/withdraw-request', async (req, res) => {
    const { telegram_id, name, username, amount, asset, wallet } = req.body;
    if (amount < 100) return res.json({ success: false, msg: 'Минимальная сумма вывода 100⭐' });
    
    const user = await pool.query("SELECT stars FROM users WHERE telegram_id = $1", [telegram_id]);
    if (!user.rows[0] || user.rows[0].stars < amount) return res.json({ success: false, msg: 'Недостаточно звёзд' });
    
    await pool.query("UPDATE users SET stars = stars - $1 WHERE telegram_id = $2", [amount, telegram_id]);
    await pool.query(
        "INSERT INTO withdraw_requests (telegram_id, name, username, amount, asset, wallet) VALUES ($1, $2, $3, $4, $5, $6)",
        [telegram_id, name, username, amount, asset, wallet]
    );
    await pool.query("UPDATE user_finance SET withdrawn = withdrawn + $1 WHERE telegram_id = $2", [amount, telegram_id]);
    
    sendUserBalance(telegram_id);

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

// ========== TELEGRAM STARS ==========
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

app.post('/webhook/telegram', async (req, res) => {
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

            await pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [amount, tgId]);
            await pool.query("UPDATE user_finance SET deposited = deposited + $1 WHERE telegram_id = $2", [amount, tgId]);
            sendUserBalance(tgId);
            
            const referrer = await pool.query("SELECT referrer_id, name FROM users WHERE telegram_id = $1", [tgId]);
            if (referrer.rows[0] && referrer.rows[0].referrer_id) {
                let refBonus = Math.floor(amount * 0.05);
                await pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [refBonus, referrer.rows[0].referrer_id]);
                await pool.query(
                    "INSERT INTO referrals_log (referrer_id, referred_id, name, amount, earned) VALUES ($1, $2, $3, $4, $5)",
                    [referrer.rows[0].referrer_id, tgId, referrer.rows[0].name || 'Игрок', amount, refBonus]
                );
                sendUserBalance(referrer.rows[0].referrer_id);
            }
            
            sendTelegramMessage(ADMIN_ID, `🟢 <b>ПОПОЛНЕНИЕ</b>\n👤 ID: ${tgId}\n⭐ Сумма: ${amount} Stars`);
        }
    }
    res.sendStatus(200);
});

// ========== АДМИН-ПАНЕЛЬ ==========
app.post('/api/admin/get-users', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const result = await pool.query("SELECT telegram_id, name, stars, games_played, wins, banned FROM users LIMIT 50");
    res.json(result.rows);
});

app.post('/api/admin/get-withdraw-requests', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const result = await pool.query("SELECT * FROM withdraw_requests WHERE status = 'pending' ORDER BY created_at DESC");
    res.json(result.rows);
});

app.post('/api/admin/approve-withdraw', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const { request_id } = req.body;
    const request = await pool.query("SELECT * FROM withdraw_requests WHERE id = $1", [request_id]);
    if (request.rows[0] && request.rows[0].status === 'pending') {
        await pool.query("UPDATE withdraw_requests SET status = 'approved' WHERE id = $1", [request_id]);
        sendTelegramMessage(request.rows[0].telegram_id, `✅ Ваша заявка на вывод ${request.rows[0].amount}⭐ подтверждена!`);
        res.json({ success: true });
    } else res.json({ success: false });
});

app.post('/api/admin/reject-withdraw', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const { request_id } = req.body;
    const request = await pool.query("SELECT * FROM withdraw_requests WHERE id = $1", [request_id]);
    if (request.rows[0] && request.rows[0].status === 'pending') {
        await pool.query("UPDATE withdraw_requests SET status = 'rejected' WHERE id = $1", [request_id]);
        await pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [request.rows[0].amount, request.rows[0].telegram_id]);
        await pool.query("UPDATE user_finance SET withdrawn = withdrawn - $1 WHERE telegram_id = $2", [request.rows[0].amount, request.rows[0].telegram_id]);
        sendTelegramMessage(request.rows[0].telegram_id, `❌ Ваша заявка на вывод ${request.rows[0].amount}⭐ отклонена. Средства возвращены на баланс.`);
        sendUserBalance(request.rows[0].telegram_id);
        res.json({ success: true });
    } else res.json({ success: false });
});

app.post('/api/admin/remove-stars', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const { target_id, amount } = req.body;
    const user = await pool.query("SELECT stars FROM users WHERE telegram_id = $1", [target_id]);
    if (!user.rows[0] || user.rows[0].stars < amount) {
        return res.json({ success: false, msg: 'Недостаточно средств' });
    }
    await pool.query("UPDATE users SET stars = stars - $1 WHERE telegram_id = $2", [amount, target_id]);
    await pool.query("UPDATE user_finance SET admin_removed = admin_removed + $1 WHERE telegram_id = $2", [amount, target_id]);
    sendUserBalance(target_id);
    res.json({ success: true });
});

app.post('/api/admin/add-stars', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const { target_id, amount } = req.body;
    await pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [amount, target_id]);
    await pool.query("UPDATE user_finance SET admin_added = admin_added + $1 WHERE telegram_id = $2", [amount, target_id]);
    sendUserBalance(target_id);
    res.json({ success: true });
});

app.post('/api/admin/get-pending-payments', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const result = await pool.query("SELECT * FROM pending_payments WHERE status = 'pending' ORDER BY created_at DESC");
    res.json(result.rows);
});

app.post('/api/admin/approve-payment', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    const { order_id } = req.body;
    const payment = await pool.query("SELECT * FROM pending_payments WHERE order_id = $1 AND status = 'pending'", [order_id]);
    if (payment.rows[0]) {
        await pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [payment.rows[0].stars_amount, payment.rows[0].telegram_id]);
        await pool.query("UPDATE user_finance SET deposited = deposited + $1 WHERE telegram_id = $2", [payment.rows[0].stars_amount, payment.rows[0].telegram_id]);
        await pool.query("UPDATE pending_payments SET status = 'completed', completed_at = NOW() WHERE order_id = $1", [order_id]);
        sendUserBalance(payment.rows[0].telegram_id);
        sendTelegramMessage(payment.rows[0].telegram_id, `✅ Ваш платёж подтверждён! Начислено ${payment.rows[0].stars_amount}⭐`);
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/admin/ban-user', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    await pool.query("UPDATE users SET banned = 1 WHERE telegram_id = $1", [req.body.target_id]);
    res.json({ success: true });
});

app.post('/api/admin/unban-user', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    await pool.query("UPDATE users SET banned = 0 WHERE telegram_id = $1", [req.body.target_id]);
    res.json({ success: true });
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

// ========== АВТОМАТИЧЕСКАЯ ПРОВЕРКА ТРАНЗАКЦИЙ TON ==========
async function getWalletTransactionsFast(limit = 30) {
    try {
        const url = `https://toncenter.com/api/v2/getTransactions`;
        const response = await axios.get(url, {
            params: {
                address: MERCHANT_WALLET,
                limit: limit,
                include_msg_data: true,
                api_key: TON_API_KEY
            },
            timeout: 5000
        });
        
        if (response.data && response.data.ok && response.data.result) {
            return response.data.result;
        }
        return [];
    } catch (e) {
        console.error('Error fetching transactions:', e.message);
        return [];
    }
}

function decodePayloadFromTx(inMsg) {
    try {
        if (!inMsg || !inMsg.msg_data || !inMsg.msg_data.body) return null;
        const decoded = Buffer.from(inMsg.msg_data.body, 'base64').toString('utf-8');
        const match = decoded.match(/deposit:(\d+):(\d+)/);
        if (match) {
            return { telegram_id: match[1], timestamp: match[2] };
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function checkPendingPayments() {
    console.log('🔍 Checking pending payments...');
    
    const pending = await pool.query(
        "SELECT * FROM pending_payments WHERE status = 'pending' ORDER BY created_at ASC"
    );
    
    if (pending.rows.length === 0) return;
    
    const transactions = await getWalletTransactionsFast(30);
    if (transactions.length === 0) {
        console.log('⚠️ No transactions fetched');
        return;
    }
    
    console.log(`📊 Got ${transactions.length} transactions, ${pending.rows.length} pending`);
    
    for (const payment of pending.rows) {
        const matchingTx = transactions.find(tx => {
            const inMsg = tx.in_msg;
            if (!inMsg || !inMsg.source) return false;
            
            const payloadData = decodePayloadFromTx(inMsg);
            if (!payloadData) return false;
            
            const amountNano = parseInt(inMsg.value) || 0;
            const expectedNano = payment.amount * 1000000000;
            const amountMatch = Math.abs(amountNano - expectedNano) < 100000000;
            
            return payloadData.telegram_id === payment.telegram_id && amountMatch;
        });
        
        if (matchingTx) {
            const starsAmount = Math.floor(payment.amount * 100);
            
            await pool.query(
                "UPDATE users SET stars = stars + $1 WHERE telegram_id = $2",
                [starsAmount, payment.telegram_id]
            );
            await pool.query(
                "UPDATE user_finance SET deposited = deposited + $1 WHERE telegram_id = $2",
                [starsAmount, payment.telegram_id]
            );
            await pool.query(
                "UPDATE pending_payments SET status = 'completed', completed_at = NOW() WHERE order_id = $1",
                [payment.order_id]
            );
            
            await sendTelegramMessage(
                payment.telegram_id,
                `✅ <b>Пополнение баланса!</b>\n\n💰 Сумма: ${payment.amount} TON\n⭐ Получено: ${starsAmount} звёзд\n\nСпасибо! 🚀`
            );
            
            await sendTelegramMessage(
                ADMIN_ID,
                `🟢 <b>УСПЕШНОЕ ПОПОЛНЕНИЕ</b>\n👤 ID: ${payment.telegram_id}\n💰 ${payment.amount} TON\n⭐ ${starsAmount}⭐`
            );
            
            sendUserBalance(payment.telegram_id);
        }
    }
}

// Запускаем проверку КАЖДЫЕ 5 СЕКУНД
setInterval(() => {
    checkPendingPayments();
}, 5000);

console.log('✅ TON payment checker started (every 5 seconds)');

// ========== WEBSOCKET ОБРАБОТКА ==========
wss.on('connection', (ws) => {
    ws.on('message', async (message) => {
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
                const user = await pool.query("SELECT stars, banned FROM users WHERE telegram_id = $1", [data.telegram_id]);
                if (!user.rows[0] || user.rows[0].banned) return;
                if (user.rows[0].stars >= data.amount) {
                    await pool.query("UPDATE users SET stars = stars - $1 WHERE telegram_id = $2", [data.amount, data.telegram_id]);
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
                }
            }
            if (data.type === 'rocket_cashout') {
                handleRocketCashout(data.telegram_id);
            }
            if (data.type === 'cancel_rocket_bet') {
                let betIndex = rocketState.bets.findIndex(b => b.telegram_id === data.telegram_id && !b.cashedOut);
                if (betIndex !== -1 && rocketState.status === 'waiting') {
                    let bet = rocketState.bets[betIndex];
                    await pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [bet.amount, data.telegram_id]);
                    sendUserBalance(data.telegram_id);
                    rocketState.bets.splice(betIndex, 1);
                    broadcast({ type: 'rocket_bet_cancelled', telegram_id: data.telegram_id });
                }
            }
            if (data.type === 'roulette_bet') {
                if (rouletteState.status !== 'waiting') return;
                if (data.amount < MIN_BET || data.amount > MAX_BET) return;
                const user = await pool.query("SELECT stars, banned FROM users WHERE telegram_id = $1", [data.telegram_id]);
                if (!user.rows[0] || user.rows[0].banned) return;
                if (user.rows[0].stars >= data.amount) {
                    await pool.query("UPDATE users SET stars = stars - $1 WHERE telegram_id = $2", [data.amount, data.telegram_id]);
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
                }
            }
            if (data.type === 'cancel_roulette_bet') {
                let betIndex = rouletteState.bets.findIndex(b => b.telegram_id === data.telegram_id);
                if (betIndex !== -1 && rouletteState.status === 'waiting') {
                    let bet = rouletteState.bets[betIndex];
                    await pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [bet.amount, data.telegram_id]);
                    sendUserBalance(data.telegram_id);
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