const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');
const { Cell } = require('@ton/core');

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
const ROULETTE_FEE = 0.05;

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
        await client.query(`CREATE TABLE IF NOT EXISTS referrals_log (id SERIAL PRIMARY KEY, referrer_id TEXT, referred_id TEXT, name TEXT, amount INTEGER, earned INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS pending_payments (id SERIAL PRIMARY KEY, telegram_id TEXT NOT NULL, order_id TEXT UNIQUE NOT NULL, amount REAL NOT NULL, stars_amount INTEGER NOT NULL, payload TEXT, status TEXT DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMP, tx_hash TEXT)`);
        await client.query(`CREATE TABLE IF NOT EXISTS games_history (id SERIAL PRIMARY KEY, telegram_id TEXT, game_type TEXT, game_name TEXT, bet_amount INTEGER, win_amount INTEGER, profit INTEGER, multiplier REAL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS nft_items (id SERIAL PRIMARY KEY, nft_id TEXT UNIQUE, name TEXT, description TEXT, image_url TEXT, rarity TEXT DEFAULT 'COMMON', price_stars INTEGER DEFAULT 100, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
        await client.query(`CREATE TABLE IF NOT EXISTS user_inventory (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, nft_id TEXT REFERENCES nft_items(nft_id), purchased_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, is_withdrawn BOOLEAN DEFAULT false, withdrawn_at TIMESTAMP, UNIQUE(user_id, nft_id))`);
        await client.query(`CREATE TABLE IF NOT EXISTS market_lots (id SERIAL PRIMARY KEY, nft_id TEXT REFERENCES nft_items(nft_id), seller_id INTEGER REFERENCES users(id), price INTEGER NOT NULL, status TEXT DEFAULT 'active', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, sold_at TIMESTAMP)`);
        console.log('✅ База данных готова');
    } catch (err) { console.error(err); } finally { client.release(); }
}
initDatabase();

// ========== ВСПОМОГАТЕЛЬНЫЕ ==========
async function sendTelegramMessage(chatId, text) {
    try { await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, { chat_id: chatId, text, parse_mode: 'HTML' }); } catch(e) {}
}
function broadcast(data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); }); }
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
    const r = Math.random() * 100;
    if (r < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2));
    if (r < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2));
    if (r < 70) return parseFloat((1.50 + Math.random() * 0.50).toFixed(2));
    if (r < 85) return parseFloat((2.00 + Math.random() * 1.00).toFixed(2));
    if (r < 95) return parseFloat((3.00 + Math.random() * 2.00).toFixed(2));
    return parseFloat((5.00 + Math.random() * 3.00).toFixed(2));
}

// ========== РАКЕТА ==========
let botPaused = false;
let rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.00, timer: 10, bets: [] };
function runRocketLoop() {
    if (botPaused) return setTimeout(runRocketLoop, 1000);
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
            setTimeout(() => { rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.00, timer: 10, bets: [] }; runRocketLoop(); }, 3000);
        } else {
            let inc = 0.01;
            if (rocketState.multiplier > 2.0) inc = 0.02;
            if (rocketState.multiplier > 5.0) inc = 0.03;
            rocketState.multiplier = parseFloat((rocketState.multiplier + inc).toFixed(2));
            rocketState.bets.forEach(b => {
                if (!b.cashedOut && b.autoCashout && rocketState.multiplier >= b.autoCashoutValue && !b.cashingOut) {
                    b.cashingOut = true;
                    handleRocketCashout(b.telegram_id, b.autoCashoutValue);
                }
            });
            broadcast({ type: 'rocket_fly', multiplier: rocketState.multiplier });
            setTimeout(runRocketLoop, 100);
        }
    }
}
async function handleRocketCashout(tgId, forceMult = null) {
    let b = rocketState.bets.find(x => x.telegram_id === tgId);
    if (!b || b.cashedOut || rocketState.status !== 'flying') return;
    b.cashedOut = true;
    b.multiplier = forceMult || rocketState.multiplier;
    let win = Math.floor(b.amount * b.multiplier);
    await pool.query("UPDATE users SET stars=stars+$1, turnover=turnover+$2, games_played=games_played+1, wins=wins+1 WHERE telegram_id=$3", [win, b.amount, tgId]);
    await saveGameHistory(tgId, 'rocket', 'Ракета', b.amount, win, win - b.amount, b.multiplier);
    sendUserBalance(tgId);
    broadcast({ type: 'rocket_cashout_success', telegram_id: tgId, multiplier: b.multiplier, winAmount: win });
}

// ========== РУЛЕТКА ==========
let rouletteState = { status: 'waiting', timer: 15, bets: [], totalBank: 0, winner: null, hasActiveBet: {} };
function runRouletteLoop() {
    if (rouletteState.status === 'waiting') {
        if (rouletteState.bets.length >= 2) {
            if (rouletteState.timer > 0) {
                rouletteState.timer--;
                broadcast({ type: 'roulette_tick', timer: rouletteState.timer, bets: rouletteState.bets, total: rouletteState.totalBank });
                setTimeout(runRouletteLoop, 1000);
            } else { executeRouletteRoll(); }
        } else { broadcast({ type: 'roulette_wait_players', bets: rouletteState.bets }); setTimeout(runRouletteLoop, 2000); }
    }
}
async function executeRouletteRoll() {
    rouletteState.status = 'rolling';
    let rand = Math.random() * rouletteState.totalBank, w = 0, winner = rouletteState.bets[0];
    for (let b of rouletteState.bets) { w += b.amount; if (rand <= w) { winner = b; break; } }
    const totalBank = rouletteState.totalBank, fee = Math.floor(totalBank * ROULETTE_FEE), prize = totalBank - fee;
    rouletteState.winner = winner;
    broadcast({ type: 'roulette_roll', winner, bets: rouletteState.bets, prize, fee });
    setTimeout(async () => {
        await pool.query("UPDATE users SET stars=stars+$1, wins=wins+1, games_played=games_played+1, turnover=turnover+$2 WHERE telegram_id=$3", [prize, winner.amount, winner.telegram_id]);
        await saveGameHistory(winner.telegram_id, 'roulette', 'Рулетка', winner.amount, prize, prize - winner.amount, prize / winner.amount);
        await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [fee, ADMIN_ID]);
        for (let b of rouletteState.bets) {
            if (b.telegram_id !== winner.telegram_id) {
                await pool.query("UPDATE users SET games_played=games_played+1, turnover=turnover+$1 WHERE telegram_id=$2", [b.amount, b.telegram_id]);
                await saveGameHistory(b.telegram_id, 'roulette', 'Рулетка', b.amount, 0, -b.amount, 0);
            }
            sendUserBalance(b.telegram_id);
        }
        rouletteState = { status: 'waiting', timer: 15, bets: [], totalBank: 0, winner: null, hasActiveBet: {} };
        runRouletteLoop();
    }, 4000);
}

// ========== МИНЫ ==========
let activeMineGames = {};
app.post('/api/games/mines/start', async (req, res) => {
    const { telegram_id, amount, minesCount } = req.body;
    const u = await pool.query("SELECT stars FROM users WHERE telegram_id=$1", [telegram_id]);
    if (!u.rows[0] || u.rows[0].stars < amount) return res.json({ success: false, msg: `Недостаточно баланса` });
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
        delete activeMineGames[req.body.telegram_id]; sendUserBalance(req.body.telegram_id);
        return res.json({ success: true, hitMine: true, board: g.board });
    }
    if(!g.revealed.includes(req.body.index)) g.revealed.push(req.body.index);
    let base = g.minesCount === 5 ? 1.04 : g.minesCount === 10 ? 1.12 : 1.30;
    let mult = parseFloat(Math.pow(base, g.revealed.length).toFixed(2));
    if (g.revealed.length === (25 - g.minesCount)) {
        let win = Math.floor(g.bet * mult);
        await pool.query("UPDATE users SET stars=stars+$1, wins=wins+1, games_played=games_played+1, turnover=turnover+$2 WHERE telegram_id=$3", [win, g.bet, req.body.telegram_id]);
        await saveGameHistory(req.body.telegram_id, 'mines', `Мины ${g.minesCount}`, g.bet, win, win-g.bet, mult);
        delete activeMineGames[req.body.telegram_id]; sendUserBalance(req.body.telegram_id);
        return res.json({ success: true, win: true, winAmount: win, multiplier: mult });
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

// ========== API ==========
app.post('/api/register', async (req, res) => {
    const { telegram_id, name, avatar, username } = req.body;
    const existing = await pool.query("SELECT * FROM users WHERE telegram_id = $1", [telegram_id]);
    if (existing.rows[0]) {
        await pool.query("UPDATE users SET name=$1, avatar=$2, username=$3 WHERE telegram_id=$4", [name, avatar, username, telegram_id]);
        return res.json({ success: true, user: { ...existing.rows[0], stars: existing.rows[0].stars } });
    }
    const r = await pool.query("INSERT INTO users (telegram_id, name, avatar, username, stars) VALUES ($1,$2,$3,$4,0) RETURNING *", [telegram_id, name, avatar, username]);
    await pool.query("INSERT INTO user_finance (telegram_id) VALUES ($1)", [telegram_id]);
    res.json({ success: true, user: r.rows[0] });
});
app.post('/api/get-balance', async (req, res) => { const r = await pool.query("SELECT stars, banned FROM users WHERE telegram_id=$1", [req.body.telegram_id]); res.json(r.rows[0] || { stars: 0, banned: 0 }); });
app.post('/api/user-stats', async (req, res) => { const r = await pool.query("SELECT games_played, turnover, wins FROM users WHERE telegram_id=$1", [req.body.telegram_id]); res.json({ success: true, ...r.rows[0] }); });
app.get('/api/rocket-history', async (req, res) => { const r = await pool.query("SELECT multiplier FROM rocket_history ORDER BY timestamp DESC LIMIT 10"); res.json(r.rows.map(x => x.multiplier)); });
app.get('/api/leaderboard', async (req, res) => { const r = await pool.query("SELECT telegram_id, name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50"); res.json(r.rows); });
app.post('/api/user-games-history', async (req, res) => { const r = await pool.query("SELECT game_name, profit FROM games_history WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 20", [req.body.telegram_id]); res.json(r.rows); });
app.post('/api/user-finance', async (req, res) => { const r = await pool.query("SELECT deposited, withdrawn FROM user_finance WHERE telegram_id=$1", [req.body.telegram_id]); res.json(r.rows[0] || { deposited: 0, withdrawn: 0 }); });
app.post('/api/user-referrals', async (req, res) => { const r = await pool.query("SELECT COUNT(*)::int as count FROM users WHERE referrer_id=$1", [req.body.telegram_id]); res.json({ count: r.rows[0].count, earned: 0 }); });
app.post('/api/save-wallet', async (req, res) => { await pool.query("UPDATE users SET wallet_address=$1 WHERE telegram_id=$2", [req.body.wallet_address, req.body.telegram_id]); res.json({ success: true }); });
app.post('/api/withdraw-request', async (req, res) => {
    const { telegram_id, name, username, amount, asset, wallet } = req.body;
    const u = await pool.query("SELECT stars FROM users WHERE telegram_id=$1", [telegram_id]);
    if (!u.rows[0] || u.rows[0].stars < amount) return res.json({ success: false, msg: 'Недостаточно средств' });
    await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [amount, telegram_id]);
    await pool.query("INSERT INTO withdraw_requests (telegram_id, name, username, amount, asset, wallet) VALUES ($1,$2,$3,$4,$5,$6)", [telegram_id, name, username, amount, asset, wallet]);
    await pool.query("UPDATE user_finance SET withdrawn=withdrawn+$1 WHERE telegram_id=$2", [amount, telegram_id]);
    sendUserBalance(telegram_id);
    res.json({ success: true });
});
app.post('/api/pending-payment', async (req, res) => {
    try {
        await pool.query(`INSERT INTO pending_payments (telegram_id, order_id, amount, stars_amount, payload) VALUES ($1,$2,$3,$4,$5)`, [req.body.telegram_id, req.body.order_id, req.body.amount, Math.floor(req.body.amount * 100), req.body.payload]);
        res.json({ success: true, order_id: req.body.order_id, target_wallet: MERCHANT_WALLET });
    } catch (e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/check-payment-status', async (req, res) => {
    const r = await pool.query("SELECT status, stars_amount FROM pending_payments WHERE order_id=$1", [req.body.order_id]);
    r.rows[0] ? res.json({ status: r.rows[0].status, stars: r.rows[0].stars_amount }) : res.json({ status: 'not_found' });
});
app.post('/api/create-invoice', async (req, res) => {
    try {
        const r = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            title: 'Пополнение DadTon', description: `Зачисление ${req.body.amount} звёзд`,
            payload: `stars_${req.body.telegram_id}_${Date.now()}`, provider_token: "", currency: "XTR",
            prices: [{ label: `${req.body.amount} Stars`, amount: parseInt(req.body.amount) }]
        });
        r.data.ok ? res.json({ success: true, invoice_link: r.data.result }) : res.json({ success: false });
    } catch (e) { res.json({ success: false }); }
});
app.post('/webhook/telegram', async (req, res) => {
    const update = req.body;
    if (update.pre_checkout_query) {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, { pre_checkout_query_id: update.pre_checkout_query.id, ok: true });
        return res.sendStatus(200);
    }
    if (update.message?.successful_payment) {
        const p = update.message.successful_payment, parts = p.invoice_payload.split('_'), tgId = parts[1];
        await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [p.total_amount, tgId]);
        await pool.query("UPDATE user_finance SET deposited=deposited+$1 WHERE telegram_id=$2", [p.total_amount, tgId]);
        sendUserBalance(tgId);
    }
    res.sendStatus(200);
});

// ========== NFT МАРКЕТ ==========
app.get('/api/gifts/market', async (req, res) => {
    try {
        const lots = await pool.query(`SELECT ml.*, ni.name, ni.image_url, ni.rarity, u.name as seller_name FROM market_lots ml JOIN nft_items ni ON ml.nft_id = ni.nft_id JOIN users u ON ml.seller_id = u.id WHERE ml.status = 'active' ORDER BY ml.price ASC`);
        res.json({ success: true, lots: lots.rows });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});
app.post('/api/gifts/sell', async (req, res) => {
    const { telegramId, nftId, price } = req.body;
    if (price < 10) return res.json({ success: false, error: 'Минимальная цена 10⭐' });
    try {
        await pool.query('BEGIN');
        const user = await pool.query("SELECT id FROM users WHERE telegram_id = $1", [telegramId]);
        if (!user.rows[0]) throw new Error('User not found');
        const inventory = await pool.query("SELECT * FROM user_inventory WHERE id = $1 AND user_id = $2 AND is_withdrawn = false", [nftId, user.rows[0].id]);
        if (!inventory.rows[0]) throw new Error('Gift not found');
        const nft = await pool.query("SELECT nft_id FROM nft_items WHERE id = $1", [inventory.rows[0].nft_id]);
        await pool.query("INSERT INTO market_lots (nft_id, seller_id, price) VALUES ($1, $2, $3)", [nft.rows[0].nft_id, user.rows[0].id, price]);
        await pool.query("UPDATE user_inventory SET is_withdrawn = true WHERE id = $1", [nftId]);
        await pool.query('COMMIT');
        res.json({ success: true });
    } catch (e) { await pool.query('ROLLBACK'); res.status(400).json({ success: false, error: e.message }); }
});
app.post('/api/gifts/buy', async (req, res) => {
    const { telegramId, lotId } = req.body;
    try {
        await pool.query('BEGIN');
        const buyer = await pool.query("SELECT id, stars FROM users WHERE telegram_id = $1 FOR UPDATE", [telegramId]);
        if (!buyer.rows[0]) throw new Error('User not found');
        const lot = await pool.query("SELECT * FROM market_lots WHERE id = $1 AND status = 'active' FOR UPDATE", [lotId]);
        if (!lot.rows[0]) throw new Error('Lot not found');
        if (buyer.rows[0].stars < lot.rows[0].price) throw new Error('Insufficient stars');
        const fee = Math.floor(lot.rows[0].price * 0.10);
        const sellerEarn = lot.rows[0].price - fee;
        await pool.query("UPDATE users SET stars = stars - $1 WHERE id = $2", [lot.rows[0].price, buyer.rows[0].id]);
        await pool.query("UPDATE users SET stars = stars + $1 WHERE id = $2", [sellerEarn, lot.rows[0].seller_id]);
        await pool.query("UPDATE users SET stars = stars + $1 WHERE telegram_id = $2", [fee, ADMIN_ID]);
        await pool.query("UPDATE market_lots SET status = 'sold', sold_at = NOW() WHERE id = $1", [lotId]);
        await pool.query("INSERT INTO user_inventory (user_id, nft_id) VALUES ($1, $2)", [buyer.rows[0].id, lot.rows[0].nft_id]);
        await pool.query('COMMIT');
        sendUserBalance(telegramId);
        res.json({ success: true, fee });
    } catch (e) { await pool.query('ROLLBACK'); res.status(400).json({ success: false, error: e.message }); }
});
app.get('/api/nft/inventory/:telegramId', async (req, res) => {
    try {
        const user = await pool.query("SELECT id FROM users WHERE telegram_id = $1", [req.params.telegramId]);
        if (!user.rows[0]) return res.json({ success: false });
        const inv = await pool.query(`SELECT ui.*, ni.* FROM user_inventory ui JOIN nft_items ni ON ui.nft_id = ni.nft_id WHERE ui.user_id = $1 AND ui.is_withdrawn = false ORDER BY ui.purchased_at DESC`, [user.rows[0].id]);
        res.json({ success: true, inventory: inv.rows });
    } catch (e) { res.status(500).json({ success: false }); }
});
app.post('/api/nft/withdraw', async (req, res) => {
    const { telegramId, inventoryId } = req.body;
    try {
        await pool.query('BEGIN');
        const user = await pool.query("SELECT id, stars FROM users WHERE telegram_id = $1 FOR UPDATE", [telegramId]);
        if (!user.rows[0]) throw new Error('User not found');
        const item = await pool.query("SELECT * FROM user_inventory WHERE id = $1 AND user_id = $2 AND is_withdrawn = false FOR UPDATE", [inventoryId, user.rows[0].id]);
        if (!item.rows[0]) throw new Error('Item not found');
        if (user.rows[0].stars < 15) throw new Error(`Недостаточно звезд. Нужно 15⭐`);
        await pool.query("UPDATE users SET stars = stars - 15 WHERE id = $1", [user.rows[0].id]);
        await pool.query("UPDATE user_inventory SET is_withdrawn = true, withdrawn_at = NOW() WHERE id = $1", [inventoryId]);
        await pool.query('COMMIT');
        await sendTelegramMessage(telegramId, `✅ Подарок выведен на ваш Telegram-аккаунт! Списано 15⭐`);
        res.json({ success: true });
    } catch (e) { await pool.query('ROLLBACK'); res.status(400).json({ success: false, error: e.message }); }
});
app.post('/api/admin/add-nft', async (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403);
    const { nft_id, name, description, image_url, rarity, price_stars } = req.body;
    try {
        await pool.query(`INSERT INTO nft_items (nft_id, name, description, image_url, rarity, price_stars) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (nft_id) DO UPDATE SET name = EXCLUDED.name, price_stars = EXCLUDED.price_stars`, [nft_id, name, description, image_url, rarity || 'COMMON', price_stars]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ========== АДМИН ==========
app.post('/api/admin/get-users', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); const r = await pool.query("SELECT id, telegram_id, name, stars, banned FROM users LIMIT 50"); res.json(r.rows); });
app.post('/api/admin/get-withdraw-requests', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); const r = await pool.query("SELECT * FROM withdraw_requests WHERE status='pending'"); res.json(r.rows); });
app.post('/api/admin/approve-withdraw', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE withdraw_requests SET status='approved' WHERE id=$1", [req.body.request_id]); res.json({ success: true }); });
app.post('/api/admin/reject-withdraw', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); const r = await pool.query("SELECT * FROM withdraw_requests WHERE id=$1", [req.body.request_id]); if (r.rows[0]) { await pool.query("UPDATE withdraw_requests SET status='rejected' WHERE id=$1", [req.body.request_id]); await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [r.rows[0].amount, r.rows[0].telegram_id]); sendUserBalance(r.rows[0].telegram_id); } res.json({ success: true }); });
app.post('/api/admin/add-stars', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [req.body.amount, req.body.target_id]); sendUserBalance(req.body.target_id); res.json({ success: true }); });
app.post('/api/admin/remove-stars', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [req.body.amount, req.body.target_id]); sendUserBalance(req.body.target_id); res.json({ success: true }); });
app.post('/api/admin/ban-user', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET banned=1 WHERE telegram_id=$1", [req.body.target_id]); res.json({ success: true }); });
app.post('/api/admin/unban-user', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET banned=0 WHERE telegram_id=$1", [req.body.target_id]); res.json({ success: true }); });
app.post('/api/admin/reset-all', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET stars=0, turnover=0, games_played=0, wins=0"); await pool.query("DELETE FROM pending_payments"); await pool.query("DELETE FROM games_history"); res.json({ success: true }); });
app.post('/api/admin/reset-leaderboard', async (req, res) => { if (req.body.admin_id !== ADMIN_ID) return res.sendStatus(403); await pool.query("UPDATE users SET turnover=0"); res.json({ success: true }); });
app.post('/api/admin/pause-bot', (req, res) => { if (req.body.admin_id === ADMIN_ID) { botPaused = true; res.json({ success: true }); } });
app.post('/api/admin/resume-bot', (req, res) => { if (req.body.admin_id === ADMIN_ID) { botPaused = false; res.json({ success: true }); } });

// ========== TON API ==========
function parseBocBodyPayload(inMsg) {
    try {
        if (!inMsg?.msg_data?.body) return null;
        const cell = Cell.fromBase64(inMsg.msg_data.body);
        const slice = cell.beginParse();
        if (slice.remainingBits >= 32 && slice.loadUint(32) === 0) {
            const txt = slice.loadStringTail();
            const m = txt.match(/deposit:(\d+):(\d+)/);
            if (m) return { telegram_id: m[1] };
        }
        return null;
    } catch (e) { return null; }
}
async function checkPendingPayments() {
    try {
        const pending = await pool.query("SELECT * FROM pending_payments WHERE status='pending'");
        if (pending.rows.length === 0) return;
        const txs = await axios.get(`https://toncenter.com/api/v2/getTransactions`, { params: { address: MERCHANT_WALLET, limit: 30, include_msg_data: true, api_key: TON_API_KEY }, timeout: 10000 });
        if (!txs.data?.ok) return;
        for (const pay of pending.rows) {
            const match = txs.data.result.find(t => { const p = parseBocBodyPayload(t.in_msg); return p && p.telegram_id === pay.telegram_id && parseInt(t.in_msg.value) === pay.amount * 1000000000; });
            if (match) {
                await pool.query("BEGIN");
                await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [pay.stars_amount, pay.telegram_id]);
                await pool.query("UPDATE user_finance SET deposited=deposited+$1 WHERE telegram_id=$2", [pay.stars_amount, pay.telegram_id]);
                await pool.query("UPDATE pending_payments SET status='completed', completed_at=NOW() WHERE id=$1", [pay.id]);
                await pool.query("COMMIT");
                await sendTelegramMessage(pay.telegram_id, `✅ Баланс пополнен! Начислено: ${pay.stars_amount} ⭐`);
                sendUserBalance(pay.telegram_id);
            }
        }
    } catch (e) { console.error(e.message); }
}
setInterval(checkPendingPayments, 15000);

// ========== MANIFEST ==========
app.get('/tonconnect-manifest.json', (req, res) => { res.json({ url: "https://dadton-full.onrender.com", name: "DadTon Casino", iconUrl: "https://dadton-full.onrender.com/icon.png" }); });
app.get('/icon.png', (req, res) => { res.setHeader('Content-Type', 'image/svg+xml'); res.send('<svg width="256" height="256"><rect width="256" height="256" fill="#0a0a0a" rx="40"/><circle cx="128" cy="128" r="80" fill="#FFD700"/><text x="128" y="150" font-size="64" text-anchor="middle" fill="#000" font-weight="900">D</text></svg>'); });

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
                rocketState.bets.push({ telegram_id: data.telegram_id, name: data.name, avatar: data.avatar, amount: data.amount, autoCashout: data.autoCashout, autoCashoutValue: parseFloat(data.autoCashoutValue), cashedOut: false });
                sendUserBalance(data.telegram_id);
                broadcast({ type: 'rocket_bets_update', bets: rocketState.bets });
            }
            if (data.type === 'rocket_cashout') handleRocketCashout(data.telegram_id);
            if (data.type === 'cancel_rocket_bet') {
                let idx = rocketState.bets.findIndex(b => b.telegram_id === data.telegram_id && !b.cashedOut);
                if (idx !== -1 && rocketState.status === 'waiting') {
                    let bet = rocketState.bets[idx];
                    await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [bet.amount, data.telegram_id]);
                    rocketState.bets.splice(idx, 1);
                    broadcast({ type: 'rocket_bets_update', bets: rocketState.bets });
                    sendUserBalance(data.telegram_id);
                }
            }
            if (data.type === 'roulette_bet') {
                if (rouletteState.status !== 'waiting') return;
                if (rouletteState.hasActiveBet[data.telegram_id]) return;
                const u = await pool.query("SELECT stars FROM users WHERE telegram_id=$1", [data.telegram_id]);
                if (!u.rows[0] || u.rows[0].stars < data.amount) return;
                await pool.query("UPDATE users SET stars=stars-$1 WHERE telegram_id=$2", [data.amount, data.telegram_id]);
                const colors = ['#ff4444', '#3B82F6', '#FFD700', '#00cc66', '#A855F7'];
                rouletteState.bets.push({ telegram_id: data.telegram_id, name: data.name, avatar: data.avatar, amount: data.amount, color: colors[rouletteState.bets.length % colors.length] });
                rouletteState.hasActiveBet[data.telegram_id] = true;
                rouletteState.totalBank += data.amount;
                sendUserBalance(data.telegram_id);
                broadcast({ type: 'roulette_bets_update', bets: rouletteState.bets, total: rouletteState.totalBank });
            }
            if (data.type === 'cancel_roulette_bet') {
                let idx = rouletteState.bets.findIndex(b => b.telegram_id === data.telegram_id);
                if (idx !== -1 && rouletteState.status === 'waiting') {
                    let bet = rouletteState.bets[idx];
                    await pool.query("UPDATE users SET stars=stars+$1 WHERE telegram_id=$2", [bet.amount, data.telegram_id]);
                    rouletteState.totalBank -= bet.amount;
                    rouletteState.bets.splice(idx, 1);
                    delete rouletteState.hasActiveBet[data.telegram_id];
                    broadcast({ type: 'roulette_bets_update', bets: rouletteState.bets, total: rouletteState.totalBank });
                    sendUserBalance(data.telegram_id);
                }
            }
        } catch (e) { console.error(e); }
    });
});

runRocketLoop();
runRouletteLoop();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));