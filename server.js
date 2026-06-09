const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Доступ к манифесту TON Connect
app.get('/tonconnect-manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'tonconnect-manifest.json'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Инициализация базы данных SQLite
const db = new sqlite3.Database(path.join(__dirname, 'database.db'), (err) => {
    if (err) console.error('Ошибка подключения к БД:', err.message);
    else console.log('Успешное подключение к SQLite БД DadTon.');
});

// Глобальные переменные состояния системы
let isBotPaused = false;
const ADMIN_ID = "1631627984";

// Создание таблиц базы данных
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

// --- СОСТОЯНИЕ И ЛОГИКА ИГРЫ "РАКЕТА" ---
let rocketState = {
    status: 'waiting', // waiting, flying, crashed
    currentMultiplier: 1.00,
    crashPoint: 1.50,
    countdown: 10,
    bets: [] // { telegram_id, name, avatar, amount, status, winMultiplier }
};

function generateRocketCrashPoint() {
    const rand = Math.random() * 100;
    if (rand < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2));
    if (rand < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2));
    if (rand < 70) return parseFloat((1.50 + Math.random() * 0.50).toFixed(2));
    if (rand < 85) return parseFloat((2.00 + Math.random() * 1.00).toFixed(2));
    if (rand < 95) return parseFloat((3.00 + Math.random() * 2.00).toFixed(2));
    return parseFloat((5.00 + Math.random() * 3.00).toFixed(2));
}

function broadcastToAll(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function runRocketLoop() {
    if (isBotPaused) {
        setTimeout(runRocketLoop, 2000);
        return;
    }

    // Этап 1: Ожидание ставок
    rocketState.status = 'waiting';
    rocketState.currentMultiplier = 1.00;
    rocketState.countdown = 10;
    rocketState.crashPoint = generateRocketCrashPoint();
    
    let countdownInterval = setInterval(() => {
        rocketState.countdown--;
        broadcastToAll({ type: 'ROCKET_TICK', data: rocketState });
        
        if (rocketState.countdown <= 0) {
            clearInterval(countdownInterval);
            startRocketFlight();
        }
    }, 1000);
}

function startRocketFlight() {
    rocketState.status = 'flying';
    let startTime = Date.now();
    
    let flightInterval = setInterval(() => {
        if (isBotPaused) {
            clearInterval(flightInterval);
            handleRocketCrash();
            return;
        }

        let elapsed = (Date.now() - startTime) / 1000;
        // Экспоненциальный рост скорости изменения множителя
        rocketState.currentMultiplier = parseFloat((1.00 + Math.pow(elapsed, 1.2) * 0.06).toFixed(2));

        // Логика автоматического вывода средств игроков (Auto-cashout)
        rocketState.bets.forEach(bet => {
            if (bet.status === 'pending' && bet.autoCashout && rocketState.currentMultiplier >= bet.autoCashoutValue) {
                if (bet.autoCashoutValue <= rocketState.crashPoint) {
                    bet.status = 'won';
                    bet.winMultiplier = bet.autoCashoutValue;
                    let winAmount = Math.floor(bet.amount * bet.winMultiplier);
                    
                    db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1 WHERE telegram_id = ?`, 
                        [winAmount, bet.amount, bet.telegram_id]);
                }
            }
        });

        if (rocketState.currentMultiplier >= rocketState.crashPoint) {
            rocketState.currentMultiplier = rocketState.crashPoint;
            clearInterval(flightInterval);
            handleRocketCrash();
        } else {
            broadcastToAll({ type: 'ROCKET_TICK', data: rocketState });
        }
    }, 80);
}

function handleRocketCrash() {
    rocketState.status = 'crashed';
    
    // Обработка всех не успевших забрать игроков -> они проигрывают
    rocketState.bets.forEach(bet => {
        if (bet.status === 'pending') {
            bet.status = 'lost';
            db.run(`UPDATE users SET turnover = turnover + ?, games_played = games_played + 1 WHERE telegram_id = ?`, [bet.amount, bet.telegram_id]);
        }
    });

    db.run(`INSERT INTO rocket_history (multiplier) VALUES (?)`, [rocketState.crashPoint]);
    broadcastToAll({ type: 'ROCKET_TICK', data: rocketState });

    setTimeout(() => {
        rocketState.bets = [];
        runRocketLoop();
    }, 1500);
}

// Инициализация цикла ракеты при запуске
runRocketLoop();


// --- СОСТОЯНИЕ И ЛОГИКА ИГРЫ "РУЛЕТКА" ---
let rouletteBets = []; // { telegram_id, name, avatar, amount }
let rouletteTimer = null;
let rouletteCountdown = 15;
let rouletteStatus = 'waiting'; // waiting, spinning

function runRouletteTimer() {
    if (rouletteTimer) return;
    
    rouletteCountdown = 15;
    rouletteTimer = setInterval(() => {
        rouletteCountdown--;
        broadcastToAll({ type: 'ROULETTE_TICK', data: { status: rouletteStatus, countdown: rouletteCountdown, bets: rouletteBets } });
        
        if (rouletteCountdown <= 0) {
            clearInterval(rouletteTimer);
            rouletteTimer = null;
            spinRoulette();
        }
    }, 1000);
}

function spinRoulette() {
    if (rouletteBets.length < 2) {
        rouletteCountdown = 15;
        rouletteStatus = 'waiting';
        broadcastToAll({ type: 'ROULETTE_TICK', data: { status: rouletteStatus, countdown: rouletteCountdown, bets: rouletteBets } });
        return;
    }

    rouletteStatus = 'spinning';
    let totalBank = rouletteBets.reduce((sum, b) => sum + b.amount, 0);
    let randomPoint = Math.random() * totalBank;
    
    let currentSum = 0;
    let winner = rouletteBets[0];
    
    for (let bet of rouletteBets) {
        currentSum += bet.amount;
        if (randomPoint <= currentSum) {
            winner = bet;
            break;
        }
    }

    // Начисление выигрыша
    db.run(`UPDATE users SET stars = stars + ?, wins = wins + 1 WHERE telegram_id = ?`, [totalBank, winner.telegram_id]);
    
    // Запись статистики для всех участников
    rouletteBets.forEach(b => {
        db.run(`UPDATE users SET turnover = turnover + ?, games_played = games_played + 1 WHERE telegram_id = ?`, [b.amount, b.telegram_id]);
    });

    broadcastToAll({ type: 'ROULETTE_RESULT', data: { winner, totalBank, bets: rouletteBets } });

    setTimeout(() => {
        rouletteBets = [];
        rouletteStatus = 'waiting';
        rouletteCountdown = 15;
        broadcastToAll({ type: 'ROULETTE_TICK', data: { status: rouletteStatus, countdown: rouletteCountdown, bets: rouletteBets } });
    }, 4000);
}


// --- WEB_SOCKET ПОДКЛЮЧЕНИЯ ---
wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'ROCKET_TICK', data: rocketState }));
    ws.send(JSON.stringify({ type: 'ROULETTE_TICK', data: { status: rouletteStatus, countdown: rouletteCountdown, bets: rouletteBets } }));
});


// --- ПОЛЬЗОВАТЕЛЬСКИЕ API ЭНДПОИНТЫ ---

// Регистрация или авторизация пользователя
app.post('/api/register', (req, res) => {
    const { telegram_id, name, avatar, username, referrer_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Missing telegram_id' });

    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, row) => {
        if (row) {
            if (row.banned === 1) return res.json({ banned: true });
            return res.json({ success: true, user: row });
        } else {
            const initialStars = 1000; // Стартовый приветственный баланс
            db.run(`INSERT INTO users (telegram_id, name, avatar, username, stars, referrer_id) VALUES (?, ?, ?, ?, ?, ?)`,
                [telegram_id, name, avatar || '👤', username || '', initialStars, referrer_id || null], function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    db.run(`INSERT INTO user_finance (telegram_id) VALUES (?)`, [telegram_id]);
                    
                    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, newUser) => {
                        res.json({ success: true, user: newUser });
                    });
                });
        }
    });
});

// Получить актуальный баланс и профиль
app.post('/api/get-balance', (req, res) => {
    const { telegram_id } = req.body;
    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, user) => {
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.banned === 1) return res.json({ banned: true });
        
        db.get(`SELECT * FROM user_finance WHERE telegram_id = ?`, [telegram_id], (err, fin) => {
            db.all(`SELECT * FROM withdraw_requests WHERE telegram_id = ? ORDER BY id DESC`, [telegram_id], (err, withdraws) => {
                db.all(`SELECT name, username, turnover FROM users WHERE referrer_id = ?`, [telegram_id], (err, refs) => {
                    res.json({
                        success: true,
                        user,
                        finance: fin || { deposited: 0, withdrawn: 0, admin_added: 0 },
                        withdraws: withdraws || [],
                        referrals: refs || []
                    });
                });
            });
        });
    });
});

// Ставка в ракете
app.post('/api/rocket/bet', (req, res) => {
    if (isBotPaused) return res.status(400).json({ error: 'Платформа временно приостановлена' });
    const { telegram_id, amount, autoCashout, autoCashoutValue } = req.body;

    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, user) => {
        if (!user || user.banned === 1) return res.status(403).json({ error: 'Access denied' });
        if (user.stars < amount) return res.status(400).json({ error: 'Недостаточно средств' });
        if (rocketState.status !== 'waiting') return res.status(400).json({ error: 'Раунд уже начался' });

        db.run(`UPDATE users SET stars = stars - ? WHERE telegram_id = ?`, [amount, telegram_id], () => {
            rocketState.bets.push({
                telegram_id,
                name: user.name,
                avatar: user.avatar,
                amount: parseInt(amount),
                autoCashout: !!autoCashout,
                autoCashoutValue: parseFloat(autoCashoutValue),
                status: 'pending'
            });
            broadcastToAll({ type: 'ROCKET_TICK', data: rocketState });
            res.json({ success: true });
        });
    });
});

// Забрать ставку в ракете (Cashout вручную)
app.post('/api/rocket/cashout', (req, res) => {
    const { telegram_id } = req.body;
    if (rocketState.status !== 'flying') return res.status(400).json({ error: 'Ракета не летит' });

    let bet = rocketState.bets.find(b => b.telegram_id === telegram_id && b.status === 'pending');
    if (!bet) return res.status(400).json({ error: 'Ставка не найдена или уже обналичена' });

    bet.status = 'won';
    bet.winMultiplier = rocketState.currentMultiplier;
    let winAmount = Math.floor(bet.amount * bet.winMultiplier);

    db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1, games_played = games_played + 1 WHERE telegram_id = ?`, 
        [winAmount, bet.amount, telegram_id], () => {
            broadcastToAll({ type: 'ROCKET_TICK', data: rocketState });
            res.json({ success: true, winAmount });
        });
});

// Отмена ставки в ракете до взлета
app.post('/api/rocket/cancel', (req, res) => {
    const { telegram_id } = req.body;
    if (rocketState.status !== 'waiting') return res.status(400).json({ error: 'Раунд уже запущен' });

    let idx = rocketState.bets.findIndex(b => b.telegram_id === telegram_id);
    if (idx === -1) return res.status(400).json({ error: 'Ставка не найдена' });

    let bet = rocketState.bets[idx];
    db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [bet.amount, telegram_id], () => {
        rocketState.bets.splice(idx, 1);
        broadcastToAll({ type: 'ROCKET_TICK', data: rocketState });
        res.json({ success: true });
    });
});

// --- ИГРА МИНЫ (SERVER-SIDE) ---
let activeMineGames = {}; // Кэш активных игр в памяти: { telegram_id: { mines: [], grid: [], bet, safeCount } }

app.post('/api/mines/start', (req, res) => {
    if (isBotPaused) return res.status(400).json({ error: 'Платформа приостановлена' });
    const { telegram_id, amount, count } = req.body;
    const mineCount = parseInt(count);

    db.get(`SELECT stars, banned FROM users WHERE telegram_id = ?`, [telegram_id], (err, user) => {
        if (!user || user.banned === 1) return res.status(403).json({ error: 'Запрещено' });
        if (user.stars < amount) return res.status(400).json({ error: 'Недостаточно звезд' });

        // Генерация мин на поле 5х5 (25 ячеек)
        let cells = Array.from({ length: 25 }, (_, i) => i);
        let mines = [];
        while (mines.length < mineCount) {
            let randIndex = Math.floor(Math.random() * cells.length);
            mines.push(cells.splice(randIndex, 1)[0]);
        }

        db.run(`UPDATE users SET stars = stars - ? WHERE telegram_id = ?`, [amount, telegram_id], () => {
            activeMineGames[telegram_id] = {
                bet: parseInt(amount),
                mineCount: mineCount,
                mines: mines,
                opened: [],
                safeCount: 0
            };
            res.json({ success: true });
        });
    });
});

app.post('/api/mines/step', (req, res) => {
    const { telegram_id, index } = req.body;
    const game = activeMineGames[telegram_id];
    if (!game) return res.status(400).json({ error: 'Активная игра не найдена' });
    if (game.opened.includes(index)) return res.status(400).json({ error: 'Ячейка уже открыта' });

    game.opened.push(index);

    if (game.mines.includes(index)) {
        // Взрыв! Проигрыш
        let betAmount = game.bet;
        delete activeMineGames[telegram_id];
        db.run(`UPDATE users SET games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?`, [betAmount, telegram_id]);
        return res.json({ status: 'boom', mines: game.mines });
    } else {
        game.safeCount++;
        let multiplier = parseFloat(Math.pow(1 + (game.mineCount * 0.016), game.safeCount).toFixed(2));
        
        // Проверка на абсолютную победу (открыты все безопасные ячейки)
        if (game.safeCount === (25 - game.mineCount)) {
            let winAmount = Math.floor(game.bet * multiplier);
            delete activeMineGames[telegram_id];
            db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1, games_played = games_played + 1 WHERE telegram_id = ?`,
                [winAmount, game.bet, telegram_id]);
            return res.json({ status: 'win', winAmount, multiplier, mines: game.mines });
        }

        return res.json({ status: 'safe', multiplier });
    }
});

app.post('/api/mines/cashout', (req, res) => {
    const { telegram_id } = req.body;
    const game = activeMineGames[telegram_id];
    if (!game || game.safeCount === 0) return res.status(400).json({ error: 'Нечего забирать' });

    let multiplier = parseFloat(Math.pow(1 + (game.mineCount * 0.016), game.safeCount).toFixed(2));
    let winAmount = Math.floor(game.bet * multiplier);
    let betAmount = game.bet;

    delete activeMineGames[telegram_id];

    db.run(`UPDATE users SET stars = stars + ?, turnover = turnover + ?, wins = wins + 1, games_played = games_played + 1 WHERE telegram_id = ?`,
        [winAmount, betAmount, telegram_id], () => {
            res.json({ success: true, winAmount, mines: game.mines });
        });
});

// --- СТАВКИ В РУЛЕТКУ ---
app.post('/api/roulette/bet', (req, res) => {
    if (isBotPaused) return res.status(400).json({ error: 'Платформа приостановлена' });
    const { telegram_id, amount } = req.body;

    db.get(`SELECT * FROM users WHERE telegram_id = ?`, [telegram_id], (err, user) => {
        if (!user || user.banned === 1) return res.status(403).json({ error: 'Запрещено' });
        if (user.stars < amount) return res.status(400).json({ error: 'Недостаточно средств' });
        if (rouletteStatus !== 'waiting') return res.status(400).json({ error: 'Колесо уже вращается' });
        if (rouletteBets.some(b => b.telegram_id === telegram_id)) return res.status(400).json({ error: 'Вы уже сделали ставку' });

        db.run(`UPDATE users SET stars = stars - ? WHERE telegram_id = ?`, [amount, telegram_id], () => {
            rouletteBets.push({
                telegram_id,
                name: user.name,
                avatar: user.avatar,
                amount: parseInt(amount)
            });
            runRouletteTimer();
            broadcastToAll({ type: 'ROULETTE_TICK', data: { status: rouletteStatus, countdown: rouletteCountdown, bets: rouletteBets } });
            res.json({ success: true });
        });
    });
});

app.post('/api/roulette/cancel', (req, res) => {
    const { telegram_id } = req.body;
    if (rouletteStatus !== 'waiting') return res.status(400).json({ error: 'Нельзя отменить во время игры' });

    let idx = rouletteBets.findIndex(b => b.telegram_id === telegram_id);
    if (idx === -1) return res.status(400).json({ error: 'Ставка не найдена' });

    let bet = rouletteBets[idx];
    db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [bet.amount, telegram_id], () => {
        rouletteBets.splice(idx, 1);
        broadcastToAll({ type: 'ROULETTE_TICK', data: { status: rouletteStatus, countdown: rouletteCountdown, bets: rouletteBets } });
        res.json({ success: true });
    });
});

app.post('/api/roulette/force-spin', (req, res) => {
    const { telegram_id } = req.body;
    if (rouletteBets.length >= 2) {
        clearInterval(rouletteTimer);
        rouletteTimer = null;
        spinRoulette();
        return res.json({ success: true });
    }
    res.status(400).json({ error: 'Нужно минимум 2 игрока' });
});

// --- TON CONNECT И СЕРВЕРНАЯ ПРИВЯЗКА КОШЕЛЬКОВ (ИЗОЛИРОВАННАЯ) ---
app.post('/api/verify-proof', (req, res) => {
    const { telegram_id, address } = req.body;
    if (!telegram_id || !address) return res.status(400).json({ error: 'Missing params' });

    db.run(`UPDATE users SET wallet_address = ? WHERE telegram_id = ?`, [address, telegram_id], () => {
        res.json({ success: true, wallet: address });
    });
});

app.post('/api/disconnect-wallet', (req, res) => {
    const { telegram_id } = req.body;
    db.run(`UPDATE users SET wallet_address = NULL WHERE telegram_id = ?`, [telegram_id], () => {
        res.json({ success: true });
    });
});


// --- ФИНАНСОВЫЕ ОПЕРАЦИИ (ПОПОЛНЕНИЯ И ВЫВОДЫ) ---

app.post('/api/withdraw-request', (req, res) => {
    const { telegram_id, amount, asset, wallet } = req.body;
    const intAmount = parseInt(amount);

    if (intAmount < 100) return res.status(400).json({ error: 'Минимальный вывод от 100 звезд' });

    db.get(`SELECT stars, name FROM users WHERE telegram_id = ?`, [telegram_id], (err, user) => {
        if (!user || user.stars < intAmount) return res.status(400).json({ error: 'Недостаточно баланса для вывода' });

        db.run(`UPDATE users SET stars = stars - ? WHERE telegram_id = ?`, [intAmount, telegram_id], () => {
            db.run(`INSERT INTO withdraw_requests (telegram_id, name, amount, asset, wallet) VALUES (?, ?, ?, ?, ?)`,
                [telegram_id, user.name, intAmount, asset, asset === 'STARS' ? 'Telegram' : wallet], () => {
                    
                    db.run(`UPDATE user_finance SET withdrawn = withdrawn + ? WHERE telegram_id = ?`, [intAmount, telegram_id]);
                    
                    console.log(`🔴 НОВАЯ ЗАЯВКА НА ВЫВОД\n👤 Имя: ${user.name}\n🆔 ID: ${telegram_id}\n⭐ Сумма: ${intAmount}\n💳 Валюта: ${asset}`);
                    res.json({ success: true, amount: intAmount, fee: Math.floor(intAmount * 0.15) });
                });
        });
    });
});

// Момуляция успешного платежа через TON/USDT/Stars
app.post('/api/create-crypto-invoice', (req, res) => {
    const { telegram_id, amount, asset } = req.body;
    let multiplier = asset === 'TON' ? 100 : 50;
    let starsToCredit = Math.floor(parseFloat(amount) * multiplier);

    db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [starsToCredit, telegram_id], () => {
        db.run(`UPDATE user_finance SET deposited = deposited + ? WHERE telegram_id = ?`, [starsToCredit, telegram_id], () => {
            
            // Начисление реферальной премии 5% пригласителю (при наличии)
            db.get(`SELECT referrer_id FROM users WHERE telegram_id = ?`, [telegram_id], (err, user) => {
                if (user && user.referrer_id) {
                    let refEarned = Math.floor(starsToCredit * 0.05);
                    db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [refEarned, user.referrer_id]);
                    db.run(`INSERT INTO referrals_log (referrer_id, referred_id, amount, earned) VALUES (?, ?, ?, ?)`,
                        [user.referrer_id, telegram_id, starsToCredit, refEarned]);
                }
            });

            res.json({ success: true, credited: starsToCredit });
        });
    });
});

// --- ЛИДЕРБОРД (Топ 50) ---
app.get('/api/leaderboard', (req, res) => {
    db.all(`SELECT name, avatar, turnover FROM users ORDER BY turnover DESC LIMIT 50`, (err, rows) => {
        res.json({ success: true, leaders: rows || [] });
    });
});


// --- КАНАЛЫ АДМИНИСТРАТОРА (СТРОГАЯ ПРОВЕРКА ADMIN_ID) ---

app.post('/api/admin/get-users', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    db.all(`SELECT * FROM users`, (err, rows) => res.json({ users: rows }));
});

app.post('/api/admin/get-withdraw-requests', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    db.all(`SELECT * FROM withdraw_requests WHERE status = 'pending'`, (err, rows) => res.json({ requests: rows }));
});

app.post('/api/admin/add-stars', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    const { target_id, amount } = req.body;
    db.run(`UPDATE users SET stars = stars + ? WHERE telegram_id = ?`, [amount, target_id], () => {
        db.run(`UPDATE user_finance SET admin_added = admin_added + ? WHERE telegram_id = ?`, [amount, target_id], () => {
            res.json({ success: true });
        });
    });
});

app.post('/api/admin/remove-stars', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    const { target_id, amount } = req.body;
    db.run(`UPDATE users SET stars = MAX(0, stars - ?) WHERE telegram_id = ?`, [amount, target_id], () => {
        res.json({ success: true });
    });
});

app.post('/api/admin/ban-user', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    db.run(`UPDATE users SET banned = 1 WHERE telegram_id = ?`, [req.body.target_id], () => res.json({ success: true }));
});

app.post('/api/admin/unban-user', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    db.run(`UPDATE users SET banned = 0 WHERE telegram_id = ?`, [req.body.target_id], () => res.json({ success: true }));
});

app.post('/api/admin/clear-wallet', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    db.run(`UPDATE users SET wallet_address = NULL WHERE telegram_id = ?`, [req.body.target_id], () => res.json({ success: true }));
});

app.post('/api/admin/clear-wallets', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    db.run(`UPDATE users SET wallet_address = NULL`, () => res.json({ success: true }));
});

app.post('/api/admin/pause-bot', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    isBotPaused = true;
    res.json({ success: true, isBotPaused });
});

app.post('/api/admin/resume-bot', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    isBotPaused = false;
    res.json({ success: true, isBotPaused });
});

app.post('/api/admin/approve-withdraw', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    db.run(`UPDATE withdraw_requests SET status = 'approved' WHERE id = ?`, [req.body.request_id], () => {
        res.json({ success: true });
    });
});

app.post('/api/admin/clear-database', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Forbidden' });
    db.serialize(() => {
        db.run(`DELETE FROM users`);
        db.run(`DELETE FROM rocket_history`);
        db.run(`DELETE FROM user_finance`);
        db.run(`DELETE FROM withdraw_requests`);
        db.run(`DELETE FROM referrals_log`);
        db.run(`DELETE FROM pending_payments`);
        res.json({ success: true });
    });
});

// Слушаем указанный хост
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Backend платформы DadTon запущен на порту ${PORT}`);
});