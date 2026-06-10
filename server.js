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
const BOT_TOKEN = process.env.BOT_TOKEN || '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const ADMIN_ID = process.env.ADMIN_ID || '1631627984';
const MERCHANT_WALLET = process.env.MERCHANT_WALLET || 'UQCEA1RKJ0eAZ_kvpN7tzhrCIh94XBw9ROSeQbaHPXOEOPRP';

const MIN_BET = 10;
const ROULETTE_FEE = 0.05;
let botPaused = false;
let botUnderMaintenance = false;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/dadton',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ========== ИНИЦИАЛИЗАЦИЯ ТАБЛИЦ ==========
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY, telegram_id TEXT UNIQUE, name TEXT, avatar TEXT, username TEXT,
            stars INTEGER DEFAULT 0, turnover INTEGER DEFAULT 0, games_played INTEGER DEFAULT 0,
            wins INTEGER DEFAULT 0, referrer_id TEXT, wallet_address TEXT, banned INTEGER DEFAULT 0
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS rocket_history (id SERIAL PRIMARY KEY, multiplier REAL, timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS user_finance (id SERIAL PRIMARY KEY, telegram_id TEXT UNIQUE, deposited INTEGER DEFAULT 0, withdrawn INTEGER DEFAULT 0, admin_added INTEGER DEFAULT 0, admin_removed INTEGER DEFAULT 0)`);
        await client.query(`CREATE TABLE IF NOT EXISTS withdraw_requests (id SERIAL PRIMARY KEY, telegram_id TEXT, name TEXT, username TEXT, amount INTEGER, asset TEXT, wallet TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS games_history (id SERIAL PRIMARY KEY, telegram_id TEXT, game_type TEXT, game_name TEXT, bet_amount INTEGER, win_amount INTEGER, profit INTEGER, multiplier REAL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        console.log('✅ Database ready');
    } catch (err) { console.error(err); } finally { client.release(); }
}
initDatabase();

// ========== ВСПОМОГАТЕЛЬНЫЕ ==========
async function sendTelegramMessage(chatId, text) {
    try { await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML' }); } catch(e) { console.error(e.message); }
}

function broadcast(data) { 
    wss.clients.forEach(c => { 
        if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); 
    }); 
}

async function sendUserBalance(tgId) {
    const r = await pool.query("SELECT stars FROM users WHERE telegram_id = $1", [tgId]);
    if (r.rows[0]) {
        wss.clients.forEach(c => { 
            if (c.readyState === WebSocket.OPEN && c.telegram_id === tgId) 
                c.send(JSON.stringify({ type: 'balance_update', stars: r.rows[0].stars })); 
        });
    }
}

async function saveGameHistory(tgId, type, name, bet, win, profit, mult) {
    await pool.query(`INSERT INTO games_history (telegram_id, game_type, game_name, bet_amount, win_amount, profit, multiplier) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [tgId, type, name, bet, win, profit, mult]);
}

function generateCrashPoint() {
    const r = Math.random() * 100;
    if (r < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2));
    if (r < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2));
    if (r < 70) return parseFloat((1.50 + Math.random() * 0.50).toFixed(2));
    if (r < 85) return parseFloat((2.00 + Math.random() * 1.00).toFixed(2));
    if (r < 95) return parseFloat((3.00 + Math.random() * 2.00).toFixed(2));
    return parseFloat((5.00 + Math.random() * 3.00).toFixed(2));
}

// ========== РАКЕТА ==========
let rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.00, timer: 10, bets: [] };

function runRocketLoop() {
    if (botPaused || botUnderMaintenance) return setTimeout(runRocketLoop, 1000);
    if (rocketState.status === 'waiting') {
        if (rocketState.timer > 0) {
            rocketState.timer--;
            broadcast({ type: 'rocket_tick', timer: rocketState.timer, bets: rocketState.bets });
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
            rocketState.bets.forEach(async b => {
                if (!b.cashedOut) {
                    await pool.query("UPDATE users SET turnover=turnover+$1, games_played=games_played+1 WHERE telegram_id=$2", [b.amount, b.telegram_id]);
                    await saveGameHistory(b.telegram_id, 'rocket', 'Ракета', b.amount, 0, -b.amount, rocketState.crashPoint);
                    sendUserBalance(b.telegram_id);
                }
            });
            setTimeout(() => { 
                rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.00, timer: 10, bets: [] }; 
                runRocketLoop(); 
            }, 3000);
        } else {
            let inc = 0.01;
            if (rocketState.multiplier > 2.0) inc = 0.02;
            if (rocketState.multiplier > 5.0) inc = 0.03;
            rocketState.multiplier = parseFloat((rocketState.multiplier + inc).toFixed(2));
            broadcast({ type: 'rocket_fly', multiplier: rocketState.multiplier });
            setTimeout(runRocketLoop, 100);
        }
    }
}

async function handleRocketCashout(tgId) {
    let b = rocketState.bets.find(x => x.telegram_id === tgId);
    if (!b || b.cashedOut || rocketState.status !== 'flying') return;
    b.cashedOut = true;
    b.multiplier = rocketState.multiplier;
    let win = Math.floor(b.amount * b.multiplier);
    await pool.query("UPDATE users SET stars=stars+$1, turnover=turnover+$2, games_played=games_played+1, wins=wins+1 WHERE telegram_id=$3", [win, b.amount, tgId]);
    await saveGameHistory(tgId, 'rocket', 'Ракета', b.amount, win, win - b.amount, b.multiplier);
    sendUserBalance(tgId);
    broadcast({ type: 'rocket_cashout_success', telegram_id: tgId, multiplier: b.multiplier, winAmount: win });
}

// ========== API ==========
app.post('/api/register', async (req, res) => {
    const { telegram_id, name, avatar, username } = req.body;
    const existing = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
    if (existing.rows[0]) {
        await pool.query("UPDATE users SET name=$1, avatar=$2, username=$3 WHERE telegram_id=$4", [name, avatar, username, telegram_id]);
        return res.json({ success: true, user: existing.rows[0] });
    }
    const r = await pool.query("INSERT INTO users (telegram_id, name, avatar, username, stars) VALUES ($1,$2,$3,$4,0) RETURNING *", [telegram_id, name, avatar, username]);
    await pool.query("INSERT INTO user_finance (telegram_id) VALUES ($1)", [telegram_id]);
    res.json({ success: true, user: r.rows[0] });
});

app.post('/api/get-balance', async (req, res) => { 
    const r = await pool.query("SELECT stars, banned FROM users WHERE telegram_id=$1", [req.body.telegram_id]); 
    res.json(r.rows[0] || { stars: 0, banned: 0 }); 
});

app.post('/api/save-wallet', async (req, res) => { 
    await pool.query("UPDATE users SET wallet_address=$1 WHERE telegram_id=$2", [req.body.wallet_address, req.body.telegram_id]); 
    res.json({ success: true }); 
});

app.get('/api/rocket-history', async (req, res) => { 
    const r = await pool.query("SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10"); 
    res.json(r.rows.map(x => x.multiplier)); 
});

app.get('/api/leaderboard', async (req, res) => { 
    const r = await pool.query("SELECT telegram_id, name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50"); 
    res.json(r.rows); 
});

app.post('/api/withdraw-request', async (req, res) => {
    const { telegram_id, name, username, amount, asset, wallet } = req.body;
    const u = await pool.query("SELECT stars FROM users WHERE telegram_id=$1", [telegram_id]);
    if (!u.rows[0] || u.rows[0].stars < amount) return res.json({ success: false, msg: 'Недостаточно средств' });
    await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [amount, telegram_id]);
    await pool.query("INSERT INTO withdraw_requests (telegram_id, name, username, amount, asset, wallet) VALUES ($1,$2,$3,$4,$5,$6)", [telegram_id, name, username, amount, asset, wallet]);
    sendUserBalance(telegram_id);
    await sendTelegramMessage(ADMIN_ID, `📤 НОВАЯ ЗАЯВКА\n👤 ${name}\n💰 ${amount} ${asset}`);
    res.json({ success: true });
});

app.post('/api/create-invoice', async (req, res) => {
    try {
        const r = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            title: 'DadTon Popolnenie', description: `${req.body.amount} zvezd`,
            payload: `stars_${req.body.telegram_id}_${Date.now()}`,
            currency: "XTR",
            prices: [{ label: `${req.body.amount} Stars`, amount: parseInt(req.body.amount) }]
        });
        r.data.ok ? res.json({ success: true, invoice_link: r.data.result }) : res.json({ success: false });
    } catch (e) { res.json({ success: false }); }
});

// ========== АДМИН API ==========
app.post('/api/admin/add-stars', async (req, res) => { 
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [req.body.amount, req.body.target_id]); 
    sendUserBalance(req.body.target_id);
    res.json({ success: true }); 
});

app.post('/api/admin/remove-stars', async (req, res) => { 
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [req.body.amount, req.body.target_id]); 
    sendUserBalance(req.body.target_id);
    res.json({ success: true }); 
});

app.post('/api/admin/ban-user', async (req, res) => { 
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET banned=1 WHERE telegram_id=$1", [req.body.target_id]); 
    res.json({ success: true }); 
});

app.post('/api/admin/unban-user', async (req, res) => { 
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET banned=0 WHERE telegram_id=$1", [req.body.target_id]); 
    res.json({ success: true }); 
});

app.post('/api/admin/message-user', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await sendTelegramMessage(req.body.target_id, `📩 АДМИН:\n${req.body.message}`);
    res.json({ success: true });
});

app.post('/api/admin/broadcast', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    const users = await pool.query("SELECT telegram_id FROM users");
    let sent = 0;
    for (const user of users.rows) {
        await sendTelegramMessage(user.telegram_id, `📢 РАССЫЛКА:\n${req.body.message}`);
        sent++;
    }
    res.json({ success: true, sent });
});

app.post('/api/admin/toggle-pause', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    botPaused = !botPaused;
    res.json({ success: true, paused: botPaused });
});

app.post('/api/admin/reset-user-balance', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET stars=0 WHERE telegram_id=$1", [req.body.target_id]);
    sendUserBalance(req.body.target_id);
    res.json({ success: true });
});

app.post('/api/admin/reset-user-turnover', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET turnover=0 WHERE telegram_id=$1", [req.body.target_id]);
    res.json({ success: true });
});

app.post('/api/admin/get-users', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    const r = await pool.query("SELECT id, telegram_id, name, stars, banned, games_played, wins FROM users ORDER BY id");
    res.json(r.rows);
});

app.post('/api/admin/get-withdraw-requests', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    const r = await pool.query("SELECT * FROM withdraw_requests WHERE status='pending' ORDER BY created_at DESC");
    res.json(r.rows);
});

app.post('/api/admin/approve-withdraw', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE withdraw_requests SET status='approved' WHERE id=$1", [req.body.request_id]);
    res.json({ success: true });
});

app.post('/api/admin/reject-withdraw', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    const r = await pool.query("SELECT * FROM withdraw_requests WHERE id=$1", [req.body.request_id]);
    if (r.rows[0]) {
        await pool.query("UPDATE withdraw_requests SET status='rejected' WHERE id=$1", [req.body.request_id]);
        await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [r.rows[0].amount, r.rows[0].telegram_id]);
        sendUserBalance(r.rows[0].telegram_id);
    }
    res.json({ success: true });
});

app.post('/api/admin/reset-leaderboard', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET turnover=0");
    res.json({ success: true });
});

app.post('/api/admin/clear-wallets', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET wallet_address=NULL");
    res.json({ success: true });
});

app.post('/api/admin/clear-all-balances', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET stars=0");
    res.json({ success: true });
});

app.post('/api/admin/maintenance', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    botUnderMaintenance = !botUnderMaintenance;
    res.json({ success: true, maintenance: botUnderMaintenance });
});

app.post('/api/admin/reset-admin-stats', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("UPDATE users SET stars=0, turnover=0, games_played=0, wins=0 WHERE telegram_id=$1", [ADMIN_ID]);
    await pool.query("DELETE FROM games_history WHERE telegram_id=$1", [ADMIN_ID]);
    res.json({ success: true });
});

app.post('/api/admin/clear-all-data', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    await pool.query("DELETE FROM users WHERE telegram_id != $1", [ADMIN_ID]);
    await pool.query("DELETE FROM games_history");
    await pool.query("DELETE FROM withdraw_requests");
    await pool.query("UPDATE users SET stars=0, turnover=0, games_played=0, wins=0 WHERE telegram_id=$1", [ADMIN_ID]);
    res.json({ success: true });
});

// Webhook
app.post('/webhook/telegram', async (req, res) => {
    const update = req.body;
    if (update.message?.successful_payment) {
        const p = update.message.successful_payment;
        const tgId = p.invoice_payload.split('_')[1];
        await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [p.total_amount, tgId]);
        sendUserBalance(tgId);
    }
    res.sendStatus(200);
});

// Manifest
app.get('/tonconnect-manifest.json', (req, res) => { 
    res.json({ url: "https://dadton-full.onrender.com", name: "DadTon", iconUrl: "https://dadton-full.onrender.com/icon.png" }); 
});

app.get('/icon.png', (req, res) => { 
    res.setHeader('Content-Type', 'image/svg+xml'); 
    res.send('<svg width="256" height="256"><rect width="256" height="256" fill="#0a0a0a" rx="40"/><circle cx="128" cy="128" r="80" fill="#FFD700"/><text x="128" y="150" font-size="64" text-anchor="middle" fill="#000" font-weight="900">D</text></svg>'); 
});

// ========== WEBSOCKET ==========
wss.on('connection', ws => {
    ws.on('message', async msg => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'auth') ws.telegram_id = data.telegram_id;
            if (data.type === 'rocket_bet') {
                if (rocketState.status !== 'waiting') return;
                const u = await pool.query("SELECT stars FROM users WHERE telegram_id=$1", [data.telegram_id]);
                if (!u.rows[0] || u.rows[0].stars < data.amount) return;
                await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [data.amount, data.telegram_id]);
                rocketState.bets.push({ telegram_id: data.telegram_id, name: data.name, avatar: data.avatar, amount: data.amount, cashedOut: false });
                sendUserBalance(data.telegram_id);
                broadcast({ type: 'rocket_bets_update', bets: rocketState.bets });
            }
            if (data.type === 'rocket_cashout') handleRocketCashout(data.telegram_id);
        } catch (e) { console.error(e); }
    });
});

runRocketLoop();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));