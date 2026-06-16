const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ===== TON CONNECT =====
const TON_CONNECT_MANIFEST = {
    url: 'https://dadton-full.onrender.com',
    name: 'DadTon',
    iconUrl: 'https://dadton-full.onrender.com/icon.png'
};

app.get('/tonconnect-manifest.json', (req, res) => {
    res.json(TON_CONNECT_MANIFEST);
});

app.get('/tonconnect/balance/:address', async (req, res) => {
    try {
        const response = await axios.get(
            `https://tonapi.io/v1/account/getBalance?account=${req.params.address}`,
            { headers: { 'Authorization': `Bearer ${process.env.TON_API_KEY}` } }
        );
        res.json({ balance: response.data.balance / 1e9 });
    } catch (error) {
        res.json({ balance: 0 });
    }
});

// ===== ИНИЦИАЛИЗАЦИЯ БД =====
async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                telegram_id BIGINT PRIMARY KEY,
                username VARCHAR(255),
                avatar TEXT,
                stars BIGINT DEFAULT 0,
                ton_address VARCHAR(255),
                total_bet BIGINT DEFAULT 0,
                total_win BIGINT DEFAULT 0,
                games_played INTEGER DEFAULT 0,
                wins INTEGER DEFAULT 0,
                banned BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS nft_items (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255),
                image_url TEXT,
                rarity VARCHAR(50) DEFAULT 'common',
                price BIGINT,
                seller_id BIGINT,
                owner_id BIGINT,
                for_sale BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS bet_history (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT,
                game VARCHAR(50),
                amount BIGINT,
                win BIGINT,
                multiplier DECIMAL(10,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS withdrawal_requests (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT,
                amount BIGINT,
                address VARCHAR(255),
                currency VARCHAR(50),
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Database initialized');
    } catch (error) {
        console.error('❌ Database init error:', error);
    } finally {
        client.release();
    }
}
initDB();

// ===== СОСТОЯНИЯ =====
let rocketState = {
    status: 'waiting',
    timer: 10,
    multiplier: 1.00,
    crashPoint: 1.05,
    bets: [],
    history: []
};

let rouletteState = {
    status: 'waiting',
    timer: 15,
    bets: [],
    total: 0
};

// Цвета рулетки: чередование с зелеными по краям
const rouletteColors = [];
// Добавляем зеленые по краям
rouletteColors.push('green');
rouletteColors.push('green');
// Чередуем красный и синий
for (let i = 0; i < 14; i++) {
    rouletteColors.push(i % 2 === 0 ? 'red' : 'blue');
}
// Добавляем зеленые по краям
rouletteColors.push('green');
rouletteColors.push('green');

// ===== WEBSOCKET =====
const wss = new WebSocket.Server({ port: 8080 });
const clients = new Map();

// ===== ФУНКЦИИ БД =====
async function createUser(telegramId, username, avatar) {
    const result = await pool.query(
        `INSERT INTO users (telegram_id, username, avatar, stars) VALUES ($1, $2, $3, 0)
         ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username, avatar = EXCLUDED.avatar
         RETURNING *`,
        [telegramId, username, avatar]
    );
    return result.rows[0];
}

async function getUser(telegramId) {
    const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    return result.rows[0];
}

async function updateStars(telegramId, amount) {
    const result = await pool.query(
        'UPDATE users SET stars = stars + $1 WHERE telegram_id = $2 RETURNING stars',
        [amount, telegramId]
    );
    return result.rows[0]?.stars;
}

async function updateStats(telegramId, game, amount, win, multiplier) {
    await pool.query(
        `UPDATE users SET total_bet = total_bet + $1, total_win = total_win + $2,
         games_played = games_played + 1, wins = wins + CASE WHEN $2 > 0 THEN 1 ELSE 0 END
         WHERE telegram_id = $3`,
        [amount, win, telegramId]
    );
    await pool.query(
        'INSERT INTO bet_history (telegram_id, game, amount, win, multiplier) VALUES ($1, $2, $3, $4, $5)',
        [telegramId, game, amount, win, multiplier]
    );
}

async function getNFTsForSale() {
    const result = await pool.query(
        `SELECT n.*, u.username as seller_name, u.avatar as seller_avatar
         FROM nft_items n
         JOIN users u ON n.seller_id = u.telegram_id
         WHERE n.for_sale = TRUE AND n.owner_id IS NULL
         ORDER BY n.created_at DESC`
    );
    return result.rows;
}

async function getUserNFTs(telegramId) {
    const result = await pool.query(
        'SELECT * FROM nft_items WHERE owner_id = $1 ORDER BY created_at DESC',
        [telegramId]
    );
    return result.rows;
}

async function addNFT(name, imageUrl, rarity, price, sellerId) {
    const result = await pool.query(
        `INSERT INTO nft_items (name, image_url, rarity, price, seller_id, for_sale)
         VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING *`,
        [name, imageUrl, rarity, price, sellerId]
    );
    return result.rows[0];
}

async function buyNFT(nftId, buyerId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const nftResult = await client.query('SELECT * FROM nft_items WHERE id = $1 AND for_sale = TRUE', [nftId]);
        if (nftResult.rows.length === 0) throw new Error('NFT not found');
        const nft = nftResult.rows[0];
        const userResult = await client.query('SELECT stars FROM users WHERE telegram_id = $1', [buyerId]);
        if (userResult.rows[0].stars < nft.price) throw new Error('Insufficient balance');
        await client.query('UPDATE users SET stars = stars - $1 WHERE telegram_id = $2', [nft.price, buyerId]);
        const commission = Math.floor(nft.price * 0.1);
        await client.query('UPDATE users SET stars = stars + $1 WHERE telegram_id = $2', [nft.price - commission, nft.seller_id]);
        await client.query('UPDATE nft_items SET owner_id = $1, for_sale = FALSE WHERE id = $2', [buyerId, nftId]);
        await client.query('COMMIT');
        return nft;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function sellNFT(nftId, sellerId, price) {
    const result = await pool.query(
        `UPDATE nft_items SET price = $1, for_sale = TRUE, seller_id = $2, owner_id = NULL
         WHERE id = $3 AND owner_id = $2 RETURNING *`,
        [price, sellerId, nftId]
    );
    return result.rows[0];
}

async function withdrawNFT(nftId, userId) {
    const result = await pool.query(
        'DELETE FROM nft_items WHERE id = $1 AND owner_id = $2 RETURNING *',
        [nftId, userId]
    );
    return result.rows[0];
}

async function getLeaders() {
    const result = await pool.query(
        `SELECT telegram_id, username, avatar, total_bet as turnover, total_win, games_played, wins, stars
         FROM users ORDER BY total_bet DESC LIMIT 100`
    );
    return result.rows;
}

async function addWithdrawalRequest(telegramId, amount, address, currency) {
    const result = await pool.query(
        `INSERT INTO withdrawal_requests (telegram_id, amount, address, currency)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [telegramId, amount, address, currency]
    );
    return result.rows[0];
}

// ===== WEBSOCKET ОБРАБОТЧИКИ =====
wss.on('connection', (ws) => {
    ws.id = Date.now();
    clients.set(ws.id, ws);

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'auth': {
                    const user = await createUser(data.telegram_id, data.username, data.avatar);
                    ws.user = user;
                    ws.send(JSON.stringify({ type: 'auth_success', user: { ...user, stars: user.stars } }));
                    broadcastRocketState();
                    broadcastRouletteState();
                    break;
                }
                case 'rocket_bet': {
                    const user = await getUser(data.telegram_id);
                    if (!user || user.banned || (rocketState.status !== 'countdown' && rocketState.status !== 'waiting')) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Ставки недоступны' }));
                        return;
                    }
                    if (data.amount < 10 || data.amount > user.stars) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Некорректная сумма' }));
                        return;
                    }
                    await updateStars(data.telegram_id, -data.amount);
                    rocketState.bets.push({
                        telegram_id: data.telegram_id,
                        name: data.name || user.username,
                        avatar: data.avatar || user.avatar,
                        amount: data.amount,
                        autoCashout: data.autoCashout || false,
                        autoCashoutValue: data.autoCashoutValue || 0,
                        cashedOut: false
                    });
                    const newBalance = await getUser(data.telegram_id);
                    ws.send(JSON.stringify({ type: 'balance_update', stars: newBalance.stars }));
                    broadcastRocketState();
                    break;
                }
                case 'rocket_cashout': {
                    const bet = rocketState.bets.find(b => b.telegram_id === data.telegram_id && !b.cashedOut);
                    if (!bet) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Ставка не найдена' }));
                        return;
                    }
                    const winAmount = Math.floor(bet.amount * rocketState.multiplier);
                    await updateStars(data.telegram_id, winAmount);
                    await updateStats(data.telegram_id, 'rocket', bet.amount, winAmount, rocketState.multiplier);
                    bet.cashedOut = true;
                    bet.winAmount = winAmount;
                    bet.multiplier = rocketState.multiplier;
                    const newBalance = await getUser(data.telegram_id);
                    ws.send(JSON.stringify({ type: 'balance_update', stars: newBalance.stars }));
                    ws.send(JSON.stringify({ type: 'rocket_cashout_success', multiplier: rocketState.multiplier, winAmount }));
                    broadcastRocketState();
                    break;
                }
                case 'cancel_rocket_bet': {
                    const idx = rocketState.bets.findIndex(b => b.telegram_id === data.telegram_id && !b.cashedOut);
                    if (idx !== -1) {
                        await updateStars(data.telegram_id, rocketState.bets[idx].amount);
                        rocketState.bets.splice(idx, 1);
                        const newBalance = await getUser(data.telegram_id);
                        ws.send(JSON.stringify({ type: 'balance_update', stars: newBalance.stars }));
                        broadcastRocketState();
                    }
                    break;
                }
                case 'roulette_bet': {
                    const user = await getUser(data.telegram_id);
                    if (!user || user.banned || rouletteState.status !== 'waiting') {
                        ws.send(JSON.stringify({ type: 'error', message: 'Ставки недоступны' }));
                        return;
                    }
                    if (data.amount < 10 || data.amount > user.stars) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Некорректная сумма' }));
                        return;
                    }
                    await updateStars(data.telegram_id, -data.amount);
                    rouletteState.bets.push({
                        telegram_id: data.telegram_id,
                        name: data.name || user.username,
                        avatar: data.avatar || user.avatar,
                        amount: data.amount,
                        color: data.color || 'red'
                    });
                    rouletteState.total += data.amount;
                    const newBalance = await getUser(data.telegram_id);
                    ws.send(JSON.stringify({ type: 'balance_update', stars: newBalance.stars }));
                    broadcastRouletteState();
                    break;
                }
                case 'cancel_roulette_bet': {
                    const idx = rouletteState.bets.findIndex(b => b.telegram_id === data.telegram_id);
                    if (idx !== -1) {
                        await updateStars(data.telegram_id, rouletteState.bets[idx].amount);
                        rouletteState.total -= rouletteState.bets[idx].amount;
                        rouletteState.bets.splice(idx, 1);
                        const newBalance = await getUser(data.telegram_id);
                        ws.send(JSON.stringify({ type: 'balance_update', stars: newBalance.stars }));
                        broadcastRouletteState();
                    }
                    break;
                }
                case 'get_leaders': {
                    const leaders = await getLeaders();
                    ws.send(JSON.stringify({ type: 'leaders_list', leaders }));
                    break;
                }
                case 'get_inventory': {
                    const nfts = await getUserNFTs(data.telegram_id);
                    ws.send(JSON.stringify({ type: 'inventory_list', nfts }));
                    break;
                }
                case 'buy_nft': {
                    try {
                        await buyNFT(data.nft_id, data.telegram_id);
                        const user = await getUser(data.telegram_id);
                        ws.send(JSON.stringify({ type: 'balance_update', stars: user.stars }));
                        ws.send(JSON.stringify({ type: 'nft_bought' }));
                        broadcastMarketUpdate();
                    } catch (error) {
                        ws.send(JSON.stringify({ type: 'error', message: error.message }));
                    }
                    break;
                }
                case 'sell_nft': {
                    await sellNFT(data.nft_id, data.seller_id, data.price);
                    ws.send(JSON.stringify({ type: 'nft_sold' }));
                    broadcastMarketUpdate();
                    break;
                }
                case 'withdraw_nft': {
                    const user = await getUser(data.telegram_id);
                    if (user.stars < 15) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Нужно 15⭐' }));
                        return;
                    }
                    await updateStars(data.telegram_id, -15);
                    await withdrawNFT(data.nft_id, data.telegram_id);
                    const updatedUser = await getUser(data.telegram_id);
                    ws.send(JSON.stringify({ type: 'balance_update', stars: updatedUser.stars }));
                    ws.send(JSON.stringify({ type: 'nft_withdrawn' }));
                    break;
                }
                case 'get_market': {
                    const nfts = await getNFTsForSale();
                    ws.send(JSON.stringify({ type: 'market_list', nfts }));
                    break;
                }
                case 'withdraw_request': {
                    const user = await getUser(data.telegram_id);
                    if (data.amount > user.stars) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно средств' }));
                        return;
                    }
                    await addWithdrawalRequest(data.telegram_id, data.amount, data.address, data.currency);
                    await updateStars(data.telegram_id, -data.amount);
                    const updatedUser = await getUser(data.telegram_id);
                    ws.send(JSON.stringify({ type: 'balance_update', stars: updatedUser.stars }));
                    ws.send(JSON.stringify({ type: 'withdrawal_created' }));
                    break;
                }
                case 'deposit_stars': {
                    const newBalance = await updateStars(data.telegram_id, data.amount);
                    ws.send(JSON.stringify({ type: 'balance_update', stars: newBalance }));
                    break;
                }
                case 'update_ton_address': {
                    await pool.query(
                        'UPDATE users SET ton_address = $1 WHERE telegram_id = $2',
                        [data.address, data.telegram_id]
                    );
                    ws.send(JSON.stringify({ type: 'ton_address_updated', address: data.address }));
                    break;
                }
            }
        } catch (error) {
            console.error('WebSocket error:', error);
            ws.send(JSON.stringify({ type: 'error', message: error.message }));
        }
    });

    ws.on('close', () => {
        clients.delete(ws.id);
    });
});

// ===== BROADCAST =====
function broadcastRocketState() {
    const msg = JSON.stringify({ type: 'rocket_state', state: rocketState });
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcastRouletteState() {
    const msg = JSON.stringify({ type: 'roulette_state', state: rouletteState });
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

async function broadcastMarketUpdate() {
    const nfts = await getNFTsForSale();
    const msg = JSON.stringify({ type: 'market_list', nfts });
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ===== ЛОГИКА РАКЕТЫ =====
function startRocketCountdown() {
    if (rocketState.status === 'flying' || rocketState.status === 'crashed') return;
    rocketState.status = 'countdown';
    rocketState.timer = 10;
    rocketState.bets = [];
    broadcastRocketState();
    const interval = setInterval(() => {
        rocketState.timer--;
        if (rocketState.timer <= 0) {
            clearInterval(interval);
            startRocketFlight();
        }
        broadcastRocketState();
    }, 1000);
}

function startRocketFlight() {
    rocketState.status = 'flying';
    rocketState.multiplier = 1.00;
    rocketState.crashPoint = 1.05 + Math.random() * 7;
    broadcastRocketState();
    const interval = setInterval(() => {
        rocketState.multiplier += 0.01;
        rocketState.bets.forEach(bet => {
            if (bet.autoCashout && !bet.cashedOut && rocketState.multiplier >= bet.autoCashoutValue) {
                const winAmount = Math.floor(bet.amount * rocketState.multiplier);
                updateStars(bet.telegram_id, winAmount);
                updateStats(bet.telegram_id, 'rocket', bet.amount, winAmount, rocketState.multiplier);
                bet.cashedOut = true;
                bet.winAmount = winAmount;
                bet.multiplier = rocketState.multiplier;
                clients.forEach(c => {
                    if (c.user && c.user.telegram_id === bet.telegram_id) {
                        c.send(JSON.stringify({ type: 'rocket_cashout_success', multiplier: rocketState.multiplier, winAmount }));
                    }
                });
            }
        });
        if (rocketState.multiplier >= rocketState.crashPoint) {
            clearInterval(interval);
            rocketState.status = 'crashed';
            rocketState.history.push(rocketState.crashPoint);
            if (rocketState.history.length > 50) rocketState.history.shift();
            broadcastRocketState();
            setTimeout(() => {
                rocketState.status = 'waiting';
                startRocketCountdown();
            }, 5000);
        }
        broadcastRocketState();
    }, 100);
}

// ===== ЛОГИКА РУЛЕТКИ =====
function startRouletteCountdown() {
    if (rouletteState.status === 'rolling') return;
    rouletteState.status = 'waiting';
    rouletteState.timer = 15;
    rouletteState.bets = [];
    rouletteState.total = 0;
    broadcastRouletteState();
    const interval = setInterval(() => {
        rouletteState.timer--;
        if (rouletteState.timer <= 0) {
            clearInterval(interval);
            rollRoulette();
        }
        broadcastRouletteState();
    }, 1000);
}

function rollRoulette() {
    if (rouletteState.bets.length === 0) {
        startRouletteCountdown();
        return;
    }
    rouletteState.status = 'rolling';
    const totalWeight = rouletteState.bets.reduce((sum, b) => sum + b.amount, 0);
    let random = Math.random() * totalWeight;
    let winner = null;
    for (const bet of rouletteState.bets) {
        random -= bet.amount;
        if (random <= 0) { winner = bet; break; }
    }
    if (!winner) winner = rouletteState.bets[0];
    const resultColor = rouletteColors[Math.floor(Math.random() * rouletteColors.length)];
    let winAmount = 0, multiplier = 0;
    if (winner.color === resultColor) {
        multiplier = (resultColor === 'red' || resultColor === 'blue') ? 2 : 10;
        winAmount = winner.amount * multiplier;
        updateStars(winner.telegram_id, winAmount);
        updateStats(winner.telegram_id, 'roulette', winner.amount, winAmount, multiplier);
    }
    const fee = Math.floor(rouletteState.total * 0.05);
    const result = { winner, color: resultColor, multiplier, winAmount, fee };
    clients.forEach(c => {
        c.send(JSON.stringify({ type: 'roulette_roll', result, bets: rouletteState.bets }));
        if (c.user) {
            getUser(c.user.telegram_id).then(user => {
                if (user) c.send(JSON.stringify({ type: 'balance_update', stars: user.stars }));
            });
        }
    });
    setTimeout(startRouletteCountdown, 5000);
}

// ===== ЗАПУСК =====
setTimeout(startRocketCountdown, 1000);
setTimeout(startRouletteCountdown, 2000);

app.listen(port, () => {
    console.log(`✅ Server on port ${port}`);
    console.log(`✅ WebSocket on port 8080`);
});