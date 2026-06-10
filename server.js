const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const db = new sqlite3.Database('./dadton.db', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to SQLite database.');
});

// Инициализация БД
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY, username TEXT, balance REAL DEFAULT 1000, 
        is_banned INTEGER DEFAULT 0, referral_id INTEGER, total_turnover REAL DEFAULT 0, 
        wins_count INTEGER DEFAULT 0, games_count INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY, user_id INTEGER, name TEXT, rarity TEXT, price REAL, on_market INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS market (
        id TEXT PRIMARY KEY, seller_id INTEGER, gift_id TEXT, price REAL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS cashout_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount REAL, currency TEXT, address TEXT, status TEXT DEFAULT 'pending'
    )`);
    
    // Добавление дефолтного админа
    db.run(`INSERT OR IGNORE INTO users (id, username, balance) VALUES (?, 'Admin', 50000)`, [process.env.ADMIN_ID]);
});

// Состояния глобальных мультиплеерных игр
let rocketState = { stage: 'timer', timer: 10, multiplier: 1.0, crashPoint: 1.0, bets: [] };
let rouletteState = { stage: 'timer', timer: 15, bets: [], totalBank: 0 };
let pokerRooms = {}; // Хранилище сессий покера

// Генерация краш-поинта (По ТЗ)
function generateCrashPoint() {
    const r = Math.random() * 100;
    if (r < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2));
    if (r < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2));
    if (r < 70) return parseFloat((1.50 + Math.random() * 0.50).toFixed(2));
    if (r < 85) return parseFloat((2.00 + Math.random() * 1.00).toFixed(2));
    if (r < 95) return parseFloat((3.00 + Math.random() * 2.00).toFixed(2));
    return parseFloat((5.00 + Math.random() * 3.00).toFixed(2));
}

// Рассылка WS сообщений всем
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
    });
}

// Цикл игры РАКЕТА
setInterval(() => {
    if (rocketState.stage === 'timer') {
        rocketState.timer -= 0.1;
        broadcast({ type: 'rocket_tick', timer: Math.max(0, rocketState.timer).toFixed(1), bets: rocketState.bets });
        if (rocketState.timer <= 0) {
            rocketState.stage = 'fly';
            rocketState.crashPoint = generateCrashPoint();
            rocketState.multiplier = 1.00;
            broadcast({ type: 'rocket_start', crashPoint: rocketState.crashPoint });
        }
    } else if (rocketState.stage === 'fly') {
        rocketState.multiplier += 0.02;
        broadcast({ type: 'rocket_fly', multiplier: rocketState.multiplier.toFixed(2) });
        
        // Проверка автовыводов
        rocketState.bets.forEach(b => {
            if (!b.cashedOut && b.autoCashout && rocketState.multiplier >= b.autoCashout) {
                cashoutUserRocket(b.userId, b.autoCashout);
            }
        });

        if (rocketState.multiplier >= rocketState.crashPoint) {
            rocketState.stage = 'crash';
            broadcast({ type: 'rocket_crash', multiplier: rocketState.multiplier.toFixed(2) });
            setTimeout(() => {
                rocketState = { stage: 'timer', timer: 10, multiplier: 1.0, crashPoint: 1.0, bets: [] };
            }, 4000);
        }
    }
}, 150);

function cashoutUserRocket(userId, multiplier) {
    const bet = rocketState.bets.find(b => b.userId === userId && !b.cashedOut);
    if (!bet) return;
    bet.cashedOut = true;
    const win = Math.floor(bet.amount * multiplier);
    db.run(`UPDATE users SET balance = balance + ?, wins_count = wins_count + 1 WHERE id = ?`, [win, userId]);
    broadcast({ type: 'rocket_cashout_success', userId, winAmount: win, multiplier });
}

// Цикл РУЛЕТКИ
setInterval(() => {
    if (rouletteState.stage === 'timer') {
        rouletteState.timer--;
        broadcast({ type: 'roulette_tick', timer: rouletteState.timer });
        if (rouletteState.timer <= 0) {
            rouletteState.stage = 'rolling';
            determineRouletteWinner();
        }
    }
}, 1000);

function determineRouletteWinner() {
    if (rouletteState.bets.length === 0) {
        rouletteState = { stage: 'timer', timer: 15, bets: [], totalBank: 0 };
        return;
    }
    const rand = Math.random() * rouletteState.totalBank;
    let currentSum = 0;
    let winner = rouletteState.bets[0];
    
    for (let bet of rouletteState.bets) {
        currentSum += bet.amount;
        if (rand <= currentSum) {
            winner = bet;
            break;
        }
    }
    
    const adminFee = rouletteState.totalBank * 0.05;
    const winAmount = rouletteState.totalBank - adminFee;
    
    db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [winAmount, winner.userId]);
    broadcast({ type: 'roulette_winner', winner: winner.username, amount: winAmount, bets: rouletteState.bets });
    
    setTimeout(() => {
        rouletteState = { stage: 'timer', timer: 15, bets: [], totalBank: 0 };
    }, 5000);
}

// API Эндпоинты
app.post('/api/register', (req, res) => {
    const { id, username, ref } = req.body;
    db.run(`INSERT OR IGNORE INTO users (id, username, referral_id) VALUES (?, ?, ?)`, [id, username, ref], () => {
        db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, row) => res.json(row));
    });
});

app.post('/api/get-balance', (req, res) => {
    db.get(`SELECT balance, is_banned FROM users WHERE id = ?`, [req.body.id], (err, row) => res.json(row));
});

// МИНЫ API
app.post('/api/games/mines/start', (req, res) => {
    const { userId, bet, minesCount } = req.body;
    db.get(`SELECT balance FROM users WHERE id = ?`, [userId], (err, user) => {
        if (!user || user.balance < bet) return res.json({ error: 'Недостаточно средств' });
        
        // Генерация мин на сервере (Provably Fair Скрыто от глаз клиента)
        let field = Array(25).fill(false);
        let placed = 0;
        while(placed < minesCount) {
            let idx = Math.floor(Math.random() * 25);
            if(!field[idx]) { field[idx] = true; placed++; }
        }
        
        db.run(`UPDATE users SET balance = balance - ?, games_count = games_count + 1, total_turnover = total_turnover + ? WHERE id = ?`, [bet, bet, userId]);
        
        // Храним игровую сессию в глобальной переменной для простоты
        if (!global.minesSessions) global.minesSessions = {};
        global.minesSessions[userId] = { field, bet, count: minesCount, opened: 0 };
        
        res.json({ success: true });
    });
});

app.post('/api/games/mines/reveal', (req, res) => {
    const { userId, index } = req.body;
    const sess = global.minesSessions?.[userId];
    if (!sess) return res.json({ error: 'Сессия не найдена' });
    
    if (sess.field[index]) {
        delete global.minesSessions[userId];
        return res.json({ status: 'lose', field: sess.field });
    }
    
    sess.opened++;
    const base = sess.count === 5 ? 1.04 : sess.count === 10 ? 1.12 : 1.30;
    const currentMult = Math.pow(base, sess.opened);
    
    res.json({ status: 'safe', multiplier: currentMult.toFixed(2), opened: sess.opened });
});

app.post('/api/games/mines/cashout', (req, res) => {
    const { userId } = req.body;
    const sess = global.minesSessions?.[userId];
    if (!sess) return res.json({ error: 'Нет активной игры' });
    
    const base = sess.count === 5 ? 1.04 : sess.count === 10 ? 1.12 : 1.30;
    const mult = Math.pow(base, sess.opened);
    const win = Math.floor(sess.bet * mult);
    
    db.run(`UPDATE users SET balance = balance + ?, wins_count = wins_count + 1 WHERE id = ?`, [win, userId]);
    delete global.minesSessions[userId];
    res.json({ success: true, win });
});

// Пополнение через Telegram Stars Webhook
app.post('/webhook/telegram', (req, res) => {
    const payload = req.body;
    if (payload.successful_payment) {
        const userId = payload.successful_payment.invoice_payload.split(':')[1];
        const amount = payload.successful_payment.total_amount;
        db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [amount, userId]);
    }
    res.sendStatus(200);
});

// АДМИН ПАНЕЛЬ
app.post('/api/admin/add-stars', (req, res) => {
    const { adminId, userId, amount } = req.body;
    if (adminId.toString() !== process.env.ADMIN_ID) return res.sendStatus(403);
    db.run(`UPDATE users SET balance = balance + ? WHERE id = ?`, [amount, userId], () => res.json({ success: true }));
});

app.post('/api/admin/ban-user', (req, res) => {
    const { adminId, userId, action } = req.body;
    if (adminId.toString() !== process.env.ADMIN_ID) return res.sendStatus(403);
    db.run(`UPDATE users SET is_banned = ? WHERE id = ?`, [action === 'ban' ? 1 : 0, userId], () => res.json({ success: true }));
});

// REST API для Магазина NFT, инвентаря и вывода заявок
app.get('/api/leaderboard', (req, res) => {
    db.all(`SELECT id, username, total_turnover FROM users ORDER BY total_turnover DESC LIMIT 50`, [], (err, rows) => res.json(rows));
});

// Запуск сервера
server.listen(process.env.PORT || 3000, () => console.log(`Server started on port ${process.env.PORT || 3000}`));