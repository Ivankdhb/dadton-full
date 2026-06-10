const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
// Нативный парсер ячеек TON Bag of Cells
const { Cell } = require('@ton/core');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ========== КОНФИГУРАЦИЯ ПРОЕКТА ==========
const BOT_TOKEN = '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const ADMIN_ID = '1631627984';
const MERCHANT_WALLET = 'UQCEA1RKJ0eAZ_kvpN7tzhrCIh94XBw9ROSeQbaHPXOEOPRP';
const TON_API_KEY = '06d6391b22c661acad89e10e47a3ff85eaaa179012354d517460508fbc91dabd';

const MIN_BET = 10;
const MAX_BET = 10000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/dadton',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ========== СТРУКТУРА ТАБЛИЦ БАЗЫ ДАННЫХ ==========
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, telegram_id TEXT UNIQUE, name TEXT, avatar TEXT, username TEXT,
                stars INTEGER DEFAULT 0, turnover INTEGER DEFAULT 0, games_played INTEGER DEFAULT 0, wins INTEGER DEFAULT 0,
                referrer_id TEXT, wallet_address TEXT, banned INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS rocket_history (id SERIAL PRIMARY KEY, multiplier REAL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS user_finance (id SERIAL PRIMARY KEY, telegram_id TEXT UNIQUE, deposited INTEGER DEFAULT 0, withdrawn INTEGER DEFAULT 0, admin_added INTEGER DEFAULT 0, admin_removed INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS withdraw_requests (id SERIAL PRIMARY KEY, telegram_id TEXT, name TEXT, username TEXT, amount INTEGER, asset TEXT, wallet TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS referrals_log (id SERIAL PRIMARY KEY, referrer_id TEXT, referred_id TEXT, name TEXT, amount INTEGER, earned INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS pending_payments (id SERIAL PRIMARY KEY, telegram_id TEXT NOT NULL, order_id TEXT UNIQUE NOT NULL, amount REAL NOT NULL, stars_amount INTEGER NOT NULL, payload TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP, tx_hash TEXT);
            CREATE TABLE IF NOT EXISTS games_history (id SERIAL PRIMARY KEY, telegram_id TEXT, game_type TEXT, game_name TEXT, bet_amount INTEGER, win_amount INTEGER, profit INTEGER, multiplier REAL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        `);
        console.log('✅ База данных PostgreSql полностью развернута.');
    } catch (err) {
        console.error('Ошибка БД:', err);
    } finally {
        client.release();
    }
}
initDatabase();

// ========== ВСПОМОГАТЕЛЬНЫЙ СЕРВЕРНЫЙ ИГРОВОЙ МОДУЛЬ ==========
async function sendTelegramMessage(chatId, text) {
    try { await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML' }); } catch (e) {}
}

function broadcast(data) {
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); });
}

async function sendUserBalance(tgId) {
    const r = await pool.query("SELECT stars FROM users WHERE telegram_id = $1", [tgId]);
    if (r.rows[0]) {
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.telegram_id === tgId) c.send(JSON.stringify({ type: 'balance_update', stars: r.rows[0].stars })); });
    }
}

async function saveGameHistory(tgId, type, name, bet, win, profit, mult) {
    await pool.query(`INSERT INTO games_history (telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tgId, type, name, bet, win, profit, mult]);
}

function generateCrashPoint() {
    let r = Math.random() * 100;
    if (r < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2));
    if (r < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2));
    return parseFloat((2.00 + Math.random() * 3.00).toFixed(2));
}

// ========== СЕРВЕРНЫЙ ЦИКЛ ИГРЫ: РАКЕТА ==========
let botPaused = false, rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.00, timer: 10, bets: [] };

function runRocketLoop() {
    if (botPaused) return setTimeout(runRocketLoop, 1000);
    if (rocketState.status === 'waiting') {
        if (rocketState.timer > 0) {
            rocketState.timer--;
            broadcast({ type: 'rocket_tick', timer: rocketState.timer, bets: rocketState.bets });
            setTimeout(runRocketLoop, 1000);
        } else {
            rocketState.status = 'flying'; rocketState.multiplier = 1.00; rocketState.crashPoint = generateCrashPoint();
            broadcast({ type: 'rocket_start', crashPoint: rocketState.crashPoint });
            setTimeout(runRocketLoop, 100);
        }
    } else if (rocketState.status === 'flying') {
        if (rocketState.multiplier >= rocketState.crashPoint) {
            rocketState.status = 'crashed';
            pool.query("INSERT INTO rocket_history (multiplier) VALUES ($1)", [rocketState.crashPoint]);
            broadcast({ type: 'rocket_crash', multiplier: rocketState.crashPoint });
            rocketState.bets.forEach(async b => {
                if (!b.cashedOut) {
                    await pool.query("UPDATE users SET turnover=turnover+$1, games_played=games_played+1 WHERE telegram_id=$2", [b.amount, b.telegram_id]);
                    await saveGameHistory(b.telegram_id, 'rocket', 'Ракета', b.amount, 0, -b.amount, rocketState.crashPoint);
                    sendUserBalance(b.telegram_id);
                }
            });
            setTimeout(() => { rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.00, timer: 10, bets: [] }; runRocketLoop(); }, 3000);
        } else {
            let inc = rocketState.multiplier > 2.0 ? 0.04 : 0.01;
            rocketState.multiplier = parseFloat((rocketState.multiplier + inc).toFixed(2));
            rocketState.bets.forEach(b => {
                if (!b.cashedOut && b.autoCashout && rocketState.multiplier >= b.autoCashoutValue && !b.cashingOut) {
                    b.cashingOut = true; handleRocketCashout(b.telegram_id, b.autoCashoutValue);
                }
            });
            broadcast({ type: 'rocket_fly', multiplier: rocketState.multiplier });
            setTimeout(runRocketLoop, 150);
        }
    }
}

async function handleRocketCashout(tgId, forceMult = null) {
    let b = rocketState.bets.find(x => x.telegram_id === tgId);
    if (!b || b.cashedOut || rocketState.status !== 'flying') return;
    b.cashedOut = true; b.multiplier = forceMult || rocketState.multiplier;
    let win = Math.floor(b.amount * b.multiplier);
    await pool.query("UPDATE users SET stars=stars+$1, turnover=turnover+$2, games_played=games_played+1, wins=wins+1 WHERE telegram_id=$3", [win, b.amount, tgId]);
    await saveGameHistory(tgId, 'rocket', 'Ракета', b.amount, win, win - b.amount, b.multiplier);
    sendUserBalance(tgId); broadcast({ type: 'rocket_cashout_success', telegram_id: tgId, multiplier: b.multiplier, winAmount: win });
}

// ========== СЕРВЕРНЫЙ ЦИКЛ ИГРЫ: РУЛЕТКА ==========
let rouletteState = { status: 'waiting', timer: 15, bets: [], totalBank: 0, winner: null };

function runRouletteLoop() {
    if (rouletteState.status === 'waiting') {
        if (rouletteState.bets.length >= 2) {
            if (rouletteState.timer > 0) {
                rouletteState.timer--; broadcast({ type: 'roulette_tick', timer: rouletteState.timer, bets: rouletteState.bets, total: rouletteState.totalBank });
                setTimeout(runRouletteLoop, 1000);
            } else { executeRouletteRoll(); }
        } else { broadcast({ type: 'roulette_wait_players', bets: rouletteState.bets }); setTimeout(runRouletteLoop, 2000); }
    }
}

async function executeRouletteRoll() {
    rouletteState.status = 'rolling';
    let rand = Math.random() * rouletteState.totalBank, w = 0, winner = rouletteState.bets[0];
    for (let b of rouletteState.bets) { w += b.amount; if (rand <= w) { winner = b; break; } }
    broadcast({ type: 'roulette_roll', winner, bets: rouletteState.bets });
    setTimeout(async () => {
        await pool.query("UPDATE users SET stars=stars+$1, wins=wins+1, games_played=games_played+1, turnover=turnover+$2 WHERE telegram_id=$3", [rouletteState.totalBank, winner.amount, winner.telegram_id]);
        await saveGameHistory(winner.telegram_id, 'roulette', 'Рулетка', winner.amount, rouletteState.totalBank, rouletteState.totalBank - winner.amount, rouletteState.totalBank / winner.amount);
        for (let b of rouletteState.bets) {
            if (b.telegram_id !== winner.telegram_id) {
                await pool.query("UPDATE users SET games_played=games_played+1, turnover=turnover+$1 WHERE telegram_id=$2", [b.amount, b.telegram_id]);
                await saveGameHistory(b.telegram_id, 'roulette', 'Рулетка', b.amount, 0, -b.amount, 0);
            }
            sendUserBalance(b.telegram_id);
        }
        rouletteState = { status: 'waiting', timer: 15, bets: [], totalBank: 0, winner: null }; runRouletteLoop();
    }, 4000);
}

// ========== ПЛАТЕЖНЫЕ И ИГРОВЫЕ ЭНДПОИНТЫ API ==========
app.post('/api/register', async (req, res) => {
    const { telegram_id, name, avatar, username, referrer_id } = req.body;
    const existing = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
    if (existing.rows[0]) {
        await pool.query("UPDATE users SET name=$1, avatar=$2, username=$3 WHERE telegram_id=$4", [name, avatar, username, telegram_id]);
        return res.json({ success: true, user: { ...existing.rows[0], name, avatar, username } });
    }
    let ref = (referrer_id && referrer_id !== telegram_id) ? referrer_id : null;
    const r = await pool.query("INSERT INTO users (telegram_id, name, avatar, username, referrer_id) VALUES ($1,$2,$3,$4,$5) RETURNING *", [telegram_id, name, avatar, username, ref]);
    await pool.query("INSERT INTO user_finance (telegram_id) VALUES ($1)", [telegram_id]);
    res.json({ success: true, user: r.rows[0] });
});

app.post('/api/pending-payment', async (req, res) => {
    const { telegram_id, amount, order_id, payload } = req.body;
    if (!telegram_id || !amount || !order_id) return res.json({ success: false });
    try {
        await pool.query(`INSERT INTO pending_payments (telegram_id, order_id, amount, stars_amount, payload) VALUES ($1,$2,$3,$4,$5)`, [telegram_id, order_id, amount, Math.floor(amount * 100), payload]);
        // Возвращаем MERCHANT_WALLET. Скрипт подставит его в транзакцию
        res.json({ success: true, order_id, target_wallet: MERCHANT_WALLET });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/check-payment-status', async (req, res) => {
    const r = await pool.query("SELECT status, stars_amount FROM pending_payments WHERE order_id = $1", [req.body.order_id]);
    if (r.rows[0]) res.json({ status: r.rows[0].status, stars: r.rows[0].stars_amount });
    else res.json({ status: 'not_found' });
});

// ЛОГИКА МИНЫ (SERVER)
let activeMineGames = {};
app.post('/api/games/mines/start', async (req, res) => {
    const { telegram_id, amount, minesCount } = req.body;
    const u = await pool.query("SELECT stars FROM users WHERE telegram_id=$1", [telegram_id]);
    if (!u.rows[0] || u.rows[0].stars < amount || amount < MIN_BET) return res.json({ success: false, msg: 'Ошибка ставки' });
    let board = Array(25).fill(false), p = 0;
    while (p < minesCount) { let i = Math.floor(Math.random()*25); if(!board[i]) { board[i]=true; p++; } }
    await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [amount, telegram_id]);
    activeMineGames[telegram_id] = { bet: amount, minesCount: parseInt(minesCount), board, revealed: [], status: 'active' };
    sendUserBalance(telegram_id); res.json({ success: true });
});

app.post('/api/games/mines/reveal', async (req, res) => {
    let g = activeMineGames[req.body.telegram_id]; if(!g || g.status !== 'active') return res.json({ success: false });
    if (g.board[req.body.index]) {
        g.status = 'lost'; await pool.query("UPDATE users SET games_played=games_played+1, turnover=turnover+$1 WHERE telegram_id=$2", [g.bet, req.body.telegram_id]);
        await saveGameHistory(req.body.telegram_id, 'mines', `Мины ${g.minesCount}`, g.bet, 0, -g.bet, 0);
        delete activeMineGames[req.body.telegram_id]; sendUserBalance(req.body.telegram_id); return res.json({ success: true, hitMine: true, board: g.board });
    }
    if(!g.revealed.includes(req.body.index)) g.revealed.push(req.body.index);
    let base = g.minesCount === 5 ? 1.04 : g.minesCount === 10 ? 1.12 : 1.30;
    let mult = parseFloat(Math.pow(base, g.revealed.length).toFixed(2));
    if (g.revealed.length === (25 - g.minesCount)) {
        let win = Math.floor(g.bet * mult); await pool.query("UPDATE users SET stars=stars+$1, wins=wins+1, games_played=games_played+1, turnover=turnover+$2 WHERE telegram_id=$3", [win, g.bet, req.body.telegram_id]);
        await saveGameHistory(req.body.telegram_id, 'mines', `Мины ${g.minesCount}`, g.bet, win, win-g.bet, mult);
        delete activeMineGames[req.body.telegram_id]; sendUserBalance(req.body.telegram_id); return res.json({ success: true, win: true, winAmount: win, multiplier: mult });
    }
    res.json({ success: true, hitMine: false, multiplier: mult });
});

app.post('/api/games/mines/cashout', async (req, res) => {
    let g = activeMineGames[req.body.telegram_id]; if(!g || g.revealed.length===0) return res.json({ success: false });
    let base = g.minesCount === 5 ? 1.04 : g.minesCount === 10 ? 1.12 : 1.30;
    let mult = parseFloat(Math.pow(base, g.revealed.length).toFixed(2)), win = Math.floor(g.bet * mult);
    await pool.query("UPDATE users SET stars=stars+$1, wins=wins+1, games_played=games_played+1, turnover=turnover+$2 WHERE telegram_id=$3", [win, g.bet, req.body.telegram_id]);
    await saveGameHistory(req.body.telegram_id, 'mines', `Мины ${g.minesCount}`, g.bet, win, win-g.bet, mult);
    delete activeMineGames[req.body.telegram_id]; sendUserBalance(req.body.telegram_id); res.json({ success: true, winAmount: win });
});

// ========== ОСТАЛЬНЫЕ ЭНДПОИНТЫ ФИНАНСОВ И АДМИНКИ ==========
app.post('/api/get-balance', async (req, res) => { const r = await pool.query("SELECT stars, banned FROM users WHERE telegram_id=$1", [req.body.telegram_id]); res.json(r.rows[0]||{stars:0,banned:0}); });
app.post('/api/user-stats', async (req, res) => { const r = await pool.query("SELECT games_played, turnover, wins FROM users WHERE telegram_id=$1", [req.body.telegram_id]); res.json({ success: true, ...r.rows[0] }); });
app.get('/api/rocket-history', async (req, res) => { const r = await pool.query("SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10"); res.json(r.rows.map(x=>x.multiplier)); });
app.get('/api/leaderboard', async (req, res) => { const r = await pool.query("SELECT name, turnover FROM users ORDER BY turnover DESC LIMIT 50"); res.json(r.rows); });
app.post('/api/user-games-history', async (req, res) => { const r = await pool.query("SELECT game_name, profit FROM games_history WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 20", [req.body.telegram_id]); res.json(r.rows); });
app.post('/api/user-finance', async (req, res) => { const r = await pool.query("SELECT deposited, withdrawn FROM user_finance WHERE telegram_id=$1", [req.body.telegram_id]); res.json(r.rows[0]||{deposited:0,withdrawn:0}); });
app.post('/api/user-referrals', async (req, res) => { const r = await pool.query("SELECT COUNT(*)::int as count FROM users WHERE referrer_id=$1", [req.body.telegram_id]); res.json({ count: r.rows[0].count, earned: 0 }); });
app.post('/api/save-wallet', async (req, res) => { await pool.query("UPDATE users SET wallet_address=$1 WHERE telegram_id=$2", [req.body.wallet_address, req.body.telegram_id]); res.json({ success: true }); });
app.post('/api/withdraw-request', async (req, res) => {
    const { telegram_id, name, username, amount, asset, wallet } = req.body;
    await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [amount, telegram_id]);
    await pool.query("INSERT INTO withdraw_requests (telegram_id, name, username, amount, asset, wallet) VALUES ($1,$2,$3,$4,$5,$6)", [telegram_id, name, username, amount, asset, wallet]);
    await pool.query("UPDATE user_finance SET withdrawn=withdrawn+$1 WHERE telegram_id=$2", [amount, telegram_id]);
    sendUserBalance(telegram_id); res.json({ success: true });
});

// АДМИН-МЕТОДЫ (SERVER)
app.post('/api/admin/get-users', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); const r = await pool.query("SELECT telegram_id, name, stars FROM users LIMIT 50"); res.json(r.rows); });
app.post('/api/admin/get-withdraw-requests', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); const r = await pool.query("SELECT * FROM withdraw_requests WHERE status='pending'"); res.json(r.rows); });
app.post('/api/admin/approve-withdraw', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE withdraw_requests SET status='approved' WHERE id=$1", [req.body.request_id]); res.json({ success: true }); });
app.post('/api/admin/add-stars', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [req.body.amount, req.body.target_id]); sendUserBalance(req.body.target_id); res.json({ success: true }); });
app.post('/api/admin/remove-stars', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [req.body.amount, req.body.target_id]); sendUserBalance(req.body.target_id); res.json({ success: true }); });
app.post('/api/admin/ban-user', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET banned=1 WHERE telegram_id=$1", [req.body.target_id]); res.json({ success: true }); });
app.post('/api/admin/unban-user', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET banned=0 WHERE telegram_id=$1", [req.body.target_id]); res.json({ success: true }); });
app.post('/api/admin/reset-all', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=0, turnover=0, games_played=0, wins=0"); await pool.query("DELETE FROM pending_payments"); res.json({ success: true }); });
app.post('/api/admin/pause-bot', (req, res) => { if (req.body.admin_id === ADMIN_ID) { botPaused = true; res.json({ success: true }); } });
app.post('/api/admin/resume-bot', (req, res) => { if (req.body.admin_id === ADMIN_ID) { botPaused = false; res.json({ success: true }); } });

// ========== ИНТЕГРАЦИЯ С БЛОКЧЕЙНОМ TON (БЕЗОПАСНЫЙ АВТОПАРСЕР BOC) ==========
function parseBocBodyPayload(inMsg) {
    try {
        if (!inMsg || !inMsg.msg_data || !inMsg.msg_data.body) return null;
        // Чтение base64 структуры BOC ячейки через десериализатор @ton/core
        const cell = Cell.fromBase64(inMsg.msg_data.body);
        const slice = cell.beginParse();
        if (slice.remainingBits >= 32) {
            const prefix = slice.loadUint(32);
            if (prefix === 0) { // Проверка текстового маркера ячейки комментария
                const txt = slice.loadStringTail();
                const m = txt.match(/deposit:(\d+):(\d+)/);
                if (m) return { telegram_id: m[1] };
            }
        }
        return null;
    } catch (e) { return null; }
}

async function checkPendingPayments() {
    try {
        const pending = await pool.query("SELECT * FROM pending_payments WHERE status = 'pending'");
        if (pending.rows.length === 0) return;

        const response = await axios.get(`https://toncenter.com/api/v2/getTransactions`, {
            params: { address: MERCHANT_WALLET, limit: 30, include_msg_data: true, api_key: TON_API_KEY }, timeout: 10000
        });
        if (!response.data?.ok || !response.data?.result) return;
        const txs = response.data.result;

        for (const pay of pending.rows) {
            const match = txs.find(t => {
                const inMsg = t.in_msg; if (!inMsg) return false;
                const parsed = parseBocBodyPayload(inMsg); if (!parsed) return false;
                const valNano = parseInt(inMsg.value) || 0;
                const expNano = pay.amount * 1000000000;
                // Сверка без зазоров, строго до единого нанотона
                return parsed.telegram_id === pay.telegram_id && valNano === expNano;
            });

            if (match) {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [pay.stars_amount, pay.telegram_id]);
                    await client.query("UPDATE user_finance SET deposited=deposited+$1 WHERE telegram_id=$2", [pay.stars_amount, pay.telegram_id]);
                    await client.query("UPDATE pending_payments SET status='completed', completed_at=NOW(), tx_hash=$1 WHERE id=$2", [match.transaction_id?.hash || 'unknown', pay.id]);
                    await client.query('COMMIT');
                    await sendTelegramMessage(pay.telegram_id, `✅ <b>Баланс пополнен!</b> Начислено: ${pay.stars_amount} ⭐`);
                    sendUserBalance(pay.telegram_id);
                } catch (err) { await client.query('ROLLBACK'); } finally { client.release(); }
            }
        }
    } catch (e) { console.error('Ошибка проверки транзакций:', e.message); }
}
setInterval(checkPendingPayments, 10000);

// ========== WEBSOCKET ОБРАБОТЧИК СТАВОК И ИГРОКОВ ==========
wss.on('connection', ws => {
    ws.on('message', async msg => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'auth') ws.telegram_id = data.telegram_id;
            if (data.type === 'rocket_bet') {
                if (rocketState.status !== 'waiting' || data.amount < MIN_BET) return;
                await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [data.amount, data.telegram_id]);
                rocketState.bets.push({ telegram_id: data.telegram_id, name: data.name, amount: data.amount, autoCashout: data.autoCashout, autoCashoutValue: parseFloat(data.autoCashoutValue), cashedOut: false });
                sendUserBalance(data.telegram_id); broadcast({ type: 'rocket_bets_update', bets: rocketState.bets });
            }
            if (data.type === 'rocket_cashout') handleRocketCashout(data.telegram_id);
            if (data.type === 'roulette_bet') {
                if (rouletteState.status !== 'waiting' || data.amount < MIN_BET) return;
                await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [data.amount, data.telegram_id]);
                rouletteState.bets.push({ telegram_id: data.telegram_id, name: data.name, amount: data.amount, color: ['#ff4444','#3B82F6','#FFD700'][rouletteState.bets.length % 3] });
                rouletteState.totalBank += data.amount; sendUserBalance(data.telegram_id);
                broadcast({ type: 'roulette_bets_update', bets: rouletteState.bets, total: rouletteState.totalBank });
            }
        } catch(e) {}
    });
});

runRocketLoop(); runRouletteLoop();
server.listen(process.env.PORT || 3000, () => console.log(`🚀 Сервер готов.`)); const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
// Нативный парсер ячеек TON Bag of Cells
const { Cell } = require('@ton/core');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ========== КОНФИГУРАЦИЯ ПРОЕКТА ==========
const BOT_TOKEN = '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const ADMIN_ID = '1631627984';
const MERCHANT_WALLET = 'UQCEA1RKJ0eAZ_kvpN7tzhrCIh94XBw9ROSeQbaHPXOEOPRP';
const TON_API_KEY = '06d6391b22c661acad89e10e47a3ff85eaaa179012354d517460508fbc91dabd';

const MIN_BET = 10;
const MAX_BET = 10000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/dadton',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ========== СТРУКТУРА ТАБЛИЦ БАЗЫ ДАННЫХ ==========
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, telegram_id TEXT UNIQUE, name TEXT, avatar TEXT, username TEXT,
                stars INTEGER DEFAULT 0, turnover INTEGER DEFAULT 0, games_played INTEGER DEFAULT 0, wins INTEGER DEFAULT 0,
                referrer_id TEXT, wallet_address TEXT, banned INTEGER DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS rocket_history (id SERIAL PRIMARY KEY, multiplier REAL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS user_finance (id SERIAL PRIMARY KEY, telegram_id TEXT UNIQUE, deposited INTEGER DEFAULT 0, withdrawn INTEGER DEFAULT 0, admin_added INTEGER DEFAULT 0, admin_removed INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS withdraw_requests (id SERIAL PRIMARY KEY, telegram_id TEXT, name TEXT, username TEXT, amount INTEGER, asset TEXT, wallet TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS referrals_log (id SERIAL PRIMARY KEY, referrer_id TEXT, referred_id TEXT, name TEXT, amount INTEGER, earned INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS pending_payments (id SERIAL PRIMARY KEY, telegram_id TEXT NOT NULL, order_id TEXT UNIQUE NOT NULL, amount REAL NOT NULL, stars_amount INTEGER NOT NULL, payload TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP, tx_hash TEXT);
            CREATE TABLE IF NOT EXISTS games_history (id SERIAL PRIMARY KEY, telegram_id TEXT, game_type TEXT, game_name TEXT, bet_amount INTEGER, win_amount INTEGER, profit INTEGER, multiplier REAL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        `);
        console.log('✅ База данных PostgreSql полностью развернута.');
    } catch (err) {
        console.error('Ошибка БД:', err);
    } finally {
        client.release();
    }
}
initDatabase();

// ========== ВСПОМОГАТЕЛЬНЫЙ СЕРВЕРНЫЙ ИГРОВОЙ МОДУЛЬ ==========
async function sendTelegramMessage(chatId, text) {
    try { await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML' }); } catch (e) {}
}

function broadcast(data) {
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); });
}

async function sendUserBalance(tgId) {
    const r = await pool.query("SELECT stars FROM users WHERE telegram_id = $1", [tgId]);
    if (r.rows[0]) {
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.telegram_id === tgId) c.send(JSON.stringify({ type: 'balance_update', stars: r.rows[0].stars })); });
    }
}

async function saveGameHistory(tgId, type, name, bet, win, profit, mult) {
    await pool.query(`INSERT INTO games_history (telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tgId, type, name, bet, win, profit, mult]);
}

function generateCrashPoint() {
    let r = Math.random() * 100;
    if (r < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2));
    if (r < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2));
    return parseFloat((2.00 + Math.random() * 3.00).toFixed(2));
}

// ========== СЕРВЕРНЫЙ ЦИКЛ ИГРЫ: РАКЕТА ==========
let botPaused = false, rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.00, timer: 10, bets: [] };

function runRocketLoop() {
    if (botPaused) return setTimeout(runRocketLoop, 1000);
    if (rocketState.status === 'waiting') {
        if (rocketState.timer > 0) {
            rocketState.timer--;
            broadcast({ type: 'rocket_tick', timer: rocketState.timer, bets: rocketState.bets });
            setTimeout(runRocketLoop, 1000);
        } else {
            rocketState.status = 'flying'; rocketState.multiplier = 1.00; rocketState.crashPoint = generateCrashPoint();
            broadcast({ type: 'rocket_start', crashPoint: rocketState.crashPoint });
            setTimeout(runRocketLoop, 100);
        }
    } else if (rocketState.status === 'flying') {
        if (rocketState.multiplier >= rocketState.crashPoint) {
            rocketState.status = 'crashed';
            pool.query("INSERT INTO rocket_history (multiplier) VALUES ($1)", [rocketState.crashPoint]);
            broadcast({ type: 'rocket_crash', multiplier: rocketState.crashPoint });
            rocketState.bets.forEach(async b => {
                if (!b.cashedOut) {
                    await pool.query("UPDATE users SET turnover=turnover+$1, games_played=games_played+1 WHERE telegram_id=$2", [b.amount, b.telegram_id]);
                    await saveGameHistory(b.telegram_id, 'rocket', 'Ракета', b.amount, 0, -b.amount, rocketState.crashPoint);
                    sendUserBalance(b.telegram_id);
                }
            });
            setTimeout(() => { rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.00, timer: 10, bets: [] }; runRocketLoop(); }, 3000);
        } else {
            let inc = rocketState.multiplier > 2.0 ? 0.04 : 0.01;
            rocketState.multiplier = parseFloat((rocketState.multiplier + inc).toFixed(2));
            rocketState.bets.forEach(b => {
                if (!b.cashedOut && b.autoCashout && rocketState.multiplier >= b.autoCashoutValue && !b.cashingOut) {
                    b.cashingOut = true; handleRocketCashout(b.telegram_id, b.autoCashoutValue);
                }
            });
            broadcast({ type: 'rocket_fly', multiplier: rocketState.multiplier });
            setTimeout(runRocketLoop, 150);
        }
    }
}

async function handleRocketCashout(tgId, forceMult = null) {
    let b = rocketState.bets.find(x => x.telegram_id === tgId);
    if (!b || b.cashedOut || rocketState.status !== 'flying') return;
    b.cashedOut = true; b.multiplier = forceMult || rocketState.multiplier;
    let win = Math.floor(b.amount * b.multiplier);
    await pool.query("UPDATE users SET stars=stars+$1, turnover=turnover+$2, games_played=games_played+1, wins=wins+1 WHERE telegram_id=$3", [win, b.amount, tgId]);
    await saveGameHistory(tgId, 'rocket', 'Ракета', b.amount, win, win - b.amount, b.multiplier);
    sendUserBalance(tgId); broadcast({ type: 'rocket_cashout_success', telegram_id: tgId, multiplier: b.multiplier, winAmount: win });
}

// ========== СЕРВЕРНЫЙ ЦИКЛ ИГРЫ: РУЛЕТКА ==========
let rouletteState = { status: 'waiting', timer: 15, bets: [], totalBank: 0, winner: null };

function runRouletteLoop() {
    if (rouletteState.status === 'waiting') {
        if (rouletteState.bets.length >= 2) {
            if (rouletteState.timer > 0) {
                rouletteState.timer--; broadcast({ type: 'roulette_tick', timer: rouletteState.timer, bets: rouletteState.bets, total: rouletteState.totalBank });
                setTimeout(runRouletteLoop, 1000);
            } else { executeRouletteRoll(); }
        } else { broadcast({ type: 'roulette_wait_players', bets: rouletteState.bets }); setTimeout(runRouletteLoop, 2000); }
    }
}

async function executeRouletteRoll() {
    rouletteState.status = 'rolling';
    let rand = Math.random() * rouletteState.totalBank, w = 0, winner = rouletteState.bets[0];
    for (let b of rouletteState.bets) { w += b.amount; if (rand <= w) { winner = b; break; } }
    broadcast({ type: 'roulette_roll', winner, bets: rouletteState.bets });
    setTimeout(async () => {
        await pool.query("UPDATE users SET stars=stars+$1, wins=wins+1, games_played=games_played+1, turnover=turnover+$2 WHERE telegram_id=$3", [rouletteState.totalBank, winner.amount, winner.telegram_id]);
        await saveGameHistory(winner.telegram_id, 'roulette', 'Рулетка', winner.amount, rouletteState.totalBank, rouletteState.totalBank - winner.amount, rouletteState.totalBank / winner.amount);
        for (let b of rouletteState.bets) {
            if (b.telegram_id !== winner.telegram_id) {
                await pool.query("UPDATE users SET games_played=games_played+1, turnover=turnover+$1 WHERE telegram_id=$2", [b.amount, b.telegram_id]);
                await saveGameHistory(b.telegram_id, 'roulette', 'Рулетка', b.amount, 0, -b.amount, 0);
            }
            sendUserBalance(b.telegram_id);
        }
        rouletteState = { status: 'waiting', timer: 15, bets: [], totalBank: 0, winner: null }; runRouletteLoop();
    }, 4000);
}

// ========== ПЛАТЕЖНЫЕ И ИГРОВЫЕ ЭНДПОИНТЫ API ==========
app.post('/api/register', async (req, res) => {
    const { telegram_id, name, avatar, username, referrer_id } = req.body;
    const existing = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
    if (existing.rows[0]) {
        await pool.query("UPDATE users SET name=$1, avatar=$2, username=$3 WHERE telegram_id=$4", [name, avatar, username, telegram_id]);
        return res.json({ success: true, user: { ...existing.rows[0], name, avatar, username } });
    }
    let ref = (referrer_id && referrer_id !== telegram_id) ? referrer_id : null;
    const r = await pool.query("INSERT INTO users (telegram_id, name, avatar, username, referrer_id) VALUES ($1,$2,$3,$4,$5) RETURNING *", [telegram_id, name, avatar, username, ref]);
    await pool.query("INSERT INTO user_finance (telegram_id) VALUES ($1)", [telegram_id]);
    res.json({ success: true, user: r.rows[0] });
});

app.post('/api/pending-payment', async (req, res) => {
    const { telegram_id, amount, order_id, payload } = req.body;
    if (!telegram_id || !amount || !order_id) return res.json({ success: false });
    try {
        await pool.query(`INSERT INTO pending_payments (telegram_id, order_id, amount, stars_amount, payload) VALUES ($1,$2,$3,$4,$5)`, [telegram_id, order_id, amount, Math.floor(amount * 100), payload]);
        // Возвращаем MERCHANT_WALLET. Скрипт подставит его в транзакцию
        res.json({ success: true, order_id, target_wallet: MERCHANT_WALLET });
    } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/check-payment-status', async (req, res) => {
    const r = await pool.query("SELECT status, stars_amount FROM pending_payments WHERE order_id = $1", [req.body.order_id]);
    if (r.rows[0]) res.json({ status: r.rows[0].status, stars: r.rows[0].stars_amount });
    else res.json({ status: 'not_found' });
});

// ЛОГИКА МИНЫ (SERVER)
let activeMineGames = {};
app.post('/api/games/mines/start', async (req, res) => {
    const { telegram_id, amount, minesCount } = req.body;
    const u = await pool.query("SELECT stars FROM users WHERE telegram_id=$1", [telegram_id]);
    if (!u.rows[0] || u.rows[0].stars < amount || amount < MIN_BET) return res.json({ success: false, msg: 'Ошибка ставки' });
    let board = Array(25).fill(false), p = 0;
    while (p < minesCount) { let i = Math.floor(Math.random()*25); if(!board[i]) { board[i]=true; p++; } }
    await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [amount, telegram_id]);
    activeMineGames[telegram_id] = { bet: amount, minesCount: parseInt(minesCount), board, revealed: [], status: 'active' };
    sendUserBalance(telegram_id); res.json({ success: true });
});

app.post('/api/games/mines/reveal', async (req, res) => {
    let g = activeMineGames[req.body.telegram_id]; if(!g || g.status !== 'active') return res.json({ success: false });
    if (g.board[req.body.index]) {
        g.status = 'lost'; await pool.query("UPDATE users SET games_played=games_played+1, turnover=turnover+$1 WHERE telegram_id=$2", [g.bet, req.body.telegram_id]);
        await saveGameHistory(req.body.telegram_id, 'mines', `Мины ${g.minesCount}`, g.bet, 0, -g.bet, 0);
        delete activeMineGames[req.body.telegram_id]; sendUserBalance(req.body.telegram_id); return res.json({ success: true, hitMine: true, board: g.board });
    }
    if(!g.revealed.includes(req.body.index)) g.revealed.push(req.body.index);
    let base = g.minesCount === 5 ? 1.04 : g.minesCount === 10 ? 1.12 : 1.30;
    let mult = parseFloat(Math.pow(base, g.revealed.length).toFixed(2));
    if (g.revealed.length === (25 - g.minesCount)) {
        let win = Math.floor(g.bet * mult); await pool.query("UPDATE users SET stars=stars+$1, wins=wins+1, games_played=games_played+1, turnover=turnover+$2 WHERE telegram_id=$3", [win, g.bet, req.body.telegram_id]);
        await saveGameHistory(req.body.telegram_id, 'mines', `Мины ${g.minesCount}`, g.bet, win, win-g.bet, mult);
        delete activeMineGames[req.body.telegram_id]; sendUserBalance(req.body.telegram_id); return res.json({ success: true, win: true, winAmount: win, multiplier: mult });
    }
    res.json({ success: true, hitMine: false, multiplier: mult });
});

app.post('/api/games/mines/cashout', async (req, res) => {
    let g = activeMineGames[req.body.telegram_id]; if(!g || g.revealed.length===0) return res.json({ success: false });
    let base = g.minesCount === 5 ? 1.04 : g.minesCount === 10 ? 1.12 : 1.30;
    let mult = parseFloat(Math.pow(base, g.revealed.length).toFixed(2)), win = Math.floor(g.bet * mult);
    await pool.query("UPDATE users SET stars=stars+$1, wins=wins+1, games_played=games_played+1, turnover=turnover+$2 WHERE telegram_id=$3", [win, g.bet, req.body.telegram_id]);
    await saveGameHistory(req.body.telegram_id, 'mines', `Мины ${g.minesCount}`, g.bet, win, win-g.bet, mult);
    delete activeMineGames[req.body.telegram_id]; sendUserBalance(req.body.telegram_id); res.json({ success: true, winAmount: win });
});

// ========== ОСТАЛЬНЫЕ ЭНДПОИНТЫ ФИНАНСОВ И АДМИНКИ ==========
app.post('/api/get-balance', async (req, res) => { const r = await pool.query("SELECT stars, banned FROM users WHERE telegram_id=$1", [req.body.telegram_id]); res.json(r.rows[0]||{stars:0,banned:0}); });
app.post('/api/user-stats', async (req, res) => { const r = await pool.query("SELECT games_played, turnover, wins FROM users WHERE telegram_id=$1", [req.body.telegram_id]); res.json({ success: true, ...r.rows[0] }); });
app.get('/api/rocket-history', async (req, res) => { const r = await pool.query("SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10"); res.json(r.rows.map(x=>x.multiplier)); });
app.get('/api/leaderboard', async (req, res) => { const r = await pool.query("SELECT name, turnover FROM users ORDER BY turnover DESC LIMIT 50"); res.json(r.rows); });
app.post('/api/user-games-history', async (req, res) => { const r = await pool.query("SELECT game_name, profit FROM games_history WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 20", [req.body.telegram_id]); res.json(r.rows); });
app.post('/api/user-finance', async (req, res) => { const r = await pool.query("SELECT deposited, withdrawn FROM user_finance WHERE telegram_id=$1", [req.body.telegram_id]); res.json(r.rows[0]||{deposited:0,withdrawn:0}); });
app.post('/api/user-referrals', async (req, res) => { const r = await pool.query("SELECT COUNT(*)::int as count FROM users WHERE referrer_id=$1", [req.body.telegram_id]); res.json({ count: r.rows[0].count, earned: 0 }); });
app.post('/api/save-wallet', async (req, res) => { await pool.query("UPDATE users SET wallet_address=$1 WHERE telegram_id=$2", [req.body.wallet_address, req.body.telegram_id]); res.json({ success: true }); });
app.post('/api/withdraw-request', async (req, res) => {
    const { telegram_id, name, username, amount, asset, wallet } = req.body;
    await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [amount, telegram_id]);
    await pool.query("INSERT INTO withdraw_requests (telegram_id, name, username, amount, asset, wallet) VALUES ($1,$2,$3,$4,$5,$6)", [telegram_id, name, username, amount, asset, wallet]);
    await pool.query("UPDATE user_finance SET withdrawn=withdrawn+$1 WHERE telegram_id=$2", [amount, telegram_id]);
    sendUserBalance(telegram_id); res.json({ success: true });
});

// АДМИН-МЕТОДЫ (SERVER)
app.post('/api/admin/get-users', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); const r = await pool.query("SELECT telegram_id, name, stars FROM users LIMIT 50"); res.json(r.rows); });
app.post('/api/admin/get-withdraw-requests', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); const r = await pool.query("SELECT * FROM withdraw_requests WHERE status='pending'"); res.json(r.rows); });
app.post('/api/admin/approve-withdraw', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE withdraw_requests SET status='approved' WHERE id=$1", [req.body.request_id]); res.json({ success: true }); });
app.post('/api/admin/add-stars', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [req.body.amount, req.body.target_id]); sendUserBalance(req.body.target_id); res.json({ success: true }); });
app.post('/api/admin/remove-stars', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [req.body.amount, req.body.target_id]); sendUserBalance(req.body.target_id); res.json({ success: true }); });
app.post('/api/admin/ban-user', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET banned=1 WHERE telegram_id=$1", [req.body.target_id]); res.json({ success: true }); });
app.post('/api/admin/unban-user', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET banned=0 WHERE telegram_id=$1", [req.body.target_id]); res.json({ success: true }); });
app.post('/api/admin/reset-all', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=0, turnover=0, games_played=0, wins=0"); await pool.query("DELETE FROM pending_payments"); res.json({ success: true }); });
app.post('/api/admin/pause-bot', (req, res) => { if (req.body.admin_id === ADMIN_ID) { botPaused = true; res.json({ success: true }); } });
app.post('/api/admin/resume-bot', (req, res) => { if (req.body.admin_id === ADMIN_ID) { botPaused = false; res.json({ success: true }); } });

// ========== ИНТЕГРАЦИЯ С БЛОКЧЕЙНОМ TON (БЕЗОПАСНЫЙ АВТОПАРСЕР BOC) ==========
function parseBocBodyPayload(inMsg) {
    try {
        if (!inMsg || !inMsg.msg_data || !inMsg.msg_data.body) return null;
        // Чтение base64 структуры BOC ячейки через десериализатор @ton/core
        const cell = Cell.fromBase64(inMsg.msg_data.body);
        const slice = cell.beginParse();
        if (slice.remainingBits >= 32) {
            const prefix = slice.loadUint(32);
            if (prefix === 0) { // Проверка текстового маркера ячейки комментария
                const txt = slice.loadStringTail();
                const m = txt.match(/deposit:(\d+):(\d+)/);
                if (m) return { telegram_id: m[1] };
            }
        }
        return null;
    } catch (e) { return null; }
}

async function checkPendingPayments() {
    try {
        const pending = await pool.query("SELECT * FROM pending_payments WHERE status = 'pending'");
        if (pending.rows.length === 0) return;

        const response = await axios.get(`https://toncenter.com/api/v2/getTransactions`, {
            params: { address: MERCHANT_WALLET, limit: 30, include_msg_data: true, api_key: TON_API_KEY }, timeout: 10000
        });
        if (!response.data?.ok || !response.data?.result) return;
        const txs = response.data.result;

        for (const pay of pending.rows) {
            const match = txs.find(t => {
                const inMsg = t.in_msg; if (!inMsg) return false;
                const parsed = parseBocBodyPayload(inMsg); if (!parsed) return false;
                const valNano = parseInt(inMsg.value) || 0;
                const expNano = pay.amount * 1000000000;
                // Сверка без зазоров, строго до единого нанотона
                return parsed.telegram_id === pay.telegram_id && valNano === expNano;
            });

            if (match) {
                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    await client.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [pay.stars_amount, pay.telegram_id]);
                    await client.query("UPDATE user_finance SET deposited=deposited+$1 WHERE telegram_id=$2", [pay.stars_amount, pay.telegram_id]);
                    await client.query("UPDATE pending_payments SET status='completed', completed_at=NOW(), tx_hash=$1 WHERE id=$2", [match.transaction_id?.hash || 'unknown', pay.id]);
                    await client.query('COMMIT');
                    await sendTelegramMessage(pay.telegram_id, `✅ <b>Баланс пополнен!</b> Начислено: ${pay.stars_amount} ⭐`);
                    sendUserBalance(pay.telegram_id);
                } catch (err) { await client.query('ROLLBACK'); } finally { client.release(); }
            }
        }
    } catch (e) { console.error('Ошибка проверки транзакций:', e.message); }
}
setInterval(checkPendingPayments, 10000);

// ========== WEBSOCKET ОБРАБОТЧИК СТАВОК И ИГРОКОВ ==========
wss.on('connection', ws => {
    ws.on('message', async msg => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'auth') ws.telegram_id = data.telegram_id;
            if (data.type === 'rocket_bet') {
                if (rocketState.status !== 'waiting' || data.amount < MIN_BET) return;
                await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [data.amount, data.telegram_id]);
                rocketState.bets.push({ telegram_id: data.telegram_id, name: data.name, amount: data.amount, autoCashout: data.autoCashout, autoCashoutValue: parseFloat(data.autoCashoutValue), cashedOut: false });
                sendUserBalance(data.telegram_id); broadcast({ type: 'rocket_bets_update', bets: rocketState.bets });
            }
            if (data.type === 'rocket_cashout') handleRocketCashout(data.telegram_id);
            if (data.type === 'roulette_bet') {
                if (rouletteState.status !== 'waiting' || data.amount < MIN_BET) return;
                await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [data.amount, data.telegram_id]);
                rouletteState.bets.push({ telegram_id: data.telegram_id, name: data.name, amount: data.amount, color: ['#ff4444','#3B82F6','#FFD700'][rouletteState.bets.length % 3] });
                rouletteState.totalBank += data.amount; sendUserBalance(data.telegram_id);
                broadcast({ type: 'roulette_bets_update', bets: rouletteState.bets, total: rouletteState.totalBank });
            }
        } catch(e) {}
    });
});

runRocketLoop(); runRouletteLoop();
server.listen(process.env.PORT || 3000, () => console.log(`🚀 Сервер готов.`));