const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const ADMIN_ID = "1631627984"; // Твой Telegram ID

app.use(express.json());

// Автоматическое определение правильного пути к папке public
let publicPath = path.join(__dirname, 'public');

if (!fs.existsSync(publicPath)) {
    // Если папка public не найдена в корне, проверяем уровень выше (на случай особенностей сборки Render)
    const альтернативныйПуть = path.join(__dirname, '..', 'public');
    if (fs.existsSync(альтернативныйПуть)) {
        publicPath = альтернативныйПуть;
    }
}

console.log(`[СИСТЕМА] Статические файлы будут раздаваться из: ${publicPath}`);
if (fs.existsSync(path.join(publicPath, 'index.html'))) {
    console.log(`[УСПЕХ] Файл index.html найден в папке public!`);
} else {
    console.error(`[ОШИБКА] Файл index.html НЕ НАЙДЕН в ${publicPath}. Проверьте структуру репозитория на GitHub.`);
}

// Раздача статики
app.use(express.static(publicPath));

// Инициализация базы данных SQLite во временной папке контейнера Render
const db = new sqlite3.Database('/tmp/dadton.db', (err) => {
    if (err) console.error('Ошибка подключения к БД:', err);
    else console.log('База данных успешно создана/открыта в /tmp/dadton.db');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY, username TEXT, balance REAL DEFAULT 0, wallet TEXT,
        games_count INTEGER DEFAULT 0, turnover REAL DEFAULT 0, wins_count INTEGER DEFAULT 0,
        is_blocked INTEGER DEFAULT 0, referrer_id TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS game_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT, game_type TEXT,
        bet REAL, multiplier REAL, profit REAL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS withdrawals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT, amount REAL,
        currency TEXT, address TEXT, status TEXT DEFAULT 'PENDING', timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('is_suspended', '0')");
});

let systemSuspended = false;
db.get("SELECT value FROM settings WHERE key = 'is_suspended'", (err, row) => {
    if (row && row.value === '1') systemSuspended = true;
});

let rocketState = { status: 'waiting', multiplier: 1.00, crashPoint: 1.05, timer: 15, bets: [] };
let rouletteState = { status: 'waiting', timer: 15, bets: [], history: [] };

// Манифест для TON Connect
app.get('/tonconnect-manifest.json', (req, res) => {
    const manifestPath = path.join(publicPath, 'tonconnect-manifest.json');
    if (fs.existsSync(manifestPath)) {
        res.sendFile(manifestPath);
    } else {
        res.json({
            "url": "https://dadton-full.onrender.com",
            "name": "DadTon Bot",
            "iconUrl": "https://dadton-full.onrender.com/icon.png"
        });
    }
});

// Жесткий роут для главной страницы (дополнительная страховка от Cannot GET /)
app.get('/', (req, res) => {
    const indexHtmlPath = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexHtmlPath)) {
        res.sendFile(indexHtmlPath);
    } else {
        res.status(404).send(`Ошибка: index.html не найден сервером. Текущая директория поиска: ${publicPath}`);
    }
});

// Синхронизация и авторизация пользователя
app.post('/api/user/sync', (req, res) => {
    if (systemSuspended && req.body.telegram_id !== ADMIN_ID) return res.status(503).json({ error: "Suspended" });
    const { telegram_id, username, referrer_id } = req.body;
    if (!telegram_id) return res.status(400).json({ error: "Missing ID" });

    db.get("SELECT * FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
        if (row) {
            if (row.is_blocked === 1) return res.status(403).json({ error: "Blocked" });
            return res.json(row);
        } else {
            let ref = (referrer_id && referrer_id !== telegram_id) ? referrer_id : null;
            db.run("INSERT INTO users (telegram_id, username, balance, referrer_id) VALUES (?, ?, 100.0, ?)", 
                [telegram_id, username || `User_${telegram_id}`, ref], function() {
                db.get("SELECT * FROM users WHERE telegram_id = ?", [telegram_id], (err, newRow) => res.json(newRow));
            });
        }
    });
});

// Сохранение привязанного кошелька
app.post('/api/user/wallet', (req, res) => {
    db.run("UPDATE users SET wallet = ? WHERE telegram_id = ?", [req.body.wallet, req.body.telegram_id], () => res.json({ success: true }));
});

// Получение таблицы лидеров по обороту
app.get('/api/leaderboard', (req, res) => {
    db.all("SELECT username, telegram_id, turnover FROM users ORDER BY turnover DESC LIMIT 50", (err, rows) => res.json(rows));
});

// Полные данные профиля пользователя
app.get('/api/user/:id/profile', (req, res) => {
    const tid = req.params.id;
    db.get("SELECT * FROM users WHERE telegram_id = ?", [tid], (err, user) => {
        if (!user) return res.status(404).json({ error: "Not Found" });
        db.all("SELECT * FROM game_history WHERE telegram_id = ? ORDER BY id DESC LIMIT 10", [tid], (err, games) => {
            db.all("SELECT * FROM withdrawals WHERE telegram_id = ? ORDER BY id DESC", [tid], (err, finances) => {
                db.all("SELECT telegram_id, username FROM users WHERE referrer_id = ?", [tid], (err, refs) => {
                    res.json({ user, games, finances, referrals: refs });
                });
            });
        });
    });
});

// Логика одиночной игры "Мины"
app.post('/api/games/mines/play', (req, res) => {
    if (systemSuspended) return res.status(503).json({ error: "Suspended" });
    const { telegram_id, bet, minesCount, selectedCells } = req.body;
    db.get("SELECT balance FROM users WHERE telegram_id = ?", [telegram_id], (err, user) => {
        if (!user || user.balance < bet) return res.status(400).json({ error: "Insufficient funds" });

        let cells = Array(25).fill(0);
        let mPlaced = 0;
        while(mPlaced < minesCount) {
            let r = Math.floor(Math.random() * 25);
            if (cells[r] === 0) { cells[r] = 1; mPlaced++; }
        }

        let hitMine = false;
        let clicks = 0;
        for (let cell of selectedCells) {
            if (cells[cell] === 1) { hitMine = true; break; }
            else { clicks++; }
        }

        let step = minesCount === 5 ? 1.04 : minesCount === 10 ? 1.12 : minesCount === 15 ? 1.30 : minesCount === 20 ? 2.00 : 3.00;
        let mult = Math.min(500, Math.pow(step, clicks));
        if (clicks === 0) mult = 0;

        let profit = hitMine ? -bet : (bet * mult) - bet;
        db.serialize(() => {
            db.run("UPDATE users SET balance = balance + ?, games_count = games_count + 1, turnover = turnover + ?, wins_count = wins_count + ? WHERE telegram_id = ?", 
                [profit, bet, (!hitMine && clicks > 0 ? 1 : 0), telegram_id]);
            db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit) VALUES (?, 'MINES', ?, ?, ?)", 
                [telegram_id, bet, hitMine ? 0 : mult, profit]);
            db.get("SELECT balance FROM users WHERE telegram_id = ?", [telegram_id], (err, upd) => {
                res.json({ hitMine, finalMultiplier: mult, profit, balance: upd.balance, minesGrid: cells });
            });
        });
    });
});

// Запрос на вывод средств
app.post('/api/user/withdraw', (req, res) => {
    const { telegram_id, amount, currency, address } = req.body;
    db.get("SELECT balance FROM users WHERE telegram_id = ?", [telegram_id], (err, user) => {
        if (!user || user.balance < amount) return res.status(400).json({ error: "Low balance" });
        db.serialize(() => {
            db.run("UPDATE users SET balance = balance - ? WHERE telegram_id = ?", [amount, telegram_id]);
            db.run("INSERT INTO withdrawals (telegram_id, amount, currency, address) VALUES (?, ?, ?, ?)", [telegram_id, amount, currency, address], () => res.json({ success: true }));
        });
    });
});

// Панель управления администратора
app.post('/api/admin/action', (req, res) => {
    const { admin_id, action, target_id, amount, message } = req.body;
    if (admin_id !== ADMIN_ID) return res.status(403).json({ error: "Unauthorized" });

    switch(action) {
        case 'add_balance': db.run("UPDATE users SET balance = balance + ? WHERE telegram_id = ?", [amount, target_id], () => res.json({ success: true })); break;
        case 'deduct_balance': db.run("UPDATE users SET balance = MAX(0, balance - ?) WHERE telegram_id = ?", [amount, target_id], () => res.json({ success: true })); break;
        case 'block': db.run("UPDATE users SET is_blocked = 1 WHERE telegram_id = ?", [target_id], () => res.json({ success: true })); break;
        case 'unblock': db.run("UPDATE users SET is_blocked = 0 WHERE telegram_id = ?", [target_id], () => res.json({ success: true })); break;
        case 'unlink_wallet': db.run("UPDATE users SET wallet = NULL WHERE telegram_id = ?", [target_id], () => res.json({ success: true })); break;
        case 'suspend_bot': systemSuspended = true; db.run("UPDATE settings SET value = '1' WHERE key = 'is_suspended'", () => res.json({ success: true })); break;
        case 'resume_bot': systemSuspended = false; db.run("UPDATE settings SET value = '0' WHERE key = 'is_suspended'", () => res.json({ success: true })); break;
        case 'broadcast': io.emit('broadcast_message', { text: message }); res.json({ success: true }); break;
        case 'purge_database': db.serialize(() => { db.run("DELETE FROM users"); db.run("DELETE FROM game_history"); db.run("DELETE FROM withdrawals"); res.json({ success: true }); }); break;
        case 'get_withdrawals': db.all("SELECT * FROM withdrawals WHERE status = 'PENDING'", (err, rows) => res.json(rows)); break;
        case 'approve_withdrawal': db.run("UPDATE withdrawals SET status = 'APPROVED' WHERE id = ?", [target_id], () => res.json({ success: true })); break;
    }
});

// WebSocket обработка комнат реального времени
io.on('connection', (socket) => {
    socket.emit('rocket_state', rocketState);
    socket.emit('roulette_state', rouletteState);

    socket.on('rocket_bet', ({ telegram_id, username, bet, autoWithdraw }) => {
        if (systemSuspended) return;
        db.get("SELECT balance FROM users WHERE telegram_id = ?", [telegram_id], (err, user) => {
            if (user && user.balance >= bet && rocketState.status === 'waiting') {
                db.run("UPDATE users SET balance = balance - ?, games_count = games_count + 1, turnover = turnover + ? WHERE telegram_id = ?", [bet, bet, telegram_id]);
                rocketState.bets.push({ telegram_id, username, bet, autoWithdraw, cashedOut: false });
                io.emit('rocket_state', rocketState);
            }
        });
    });

    socket.on('roulette_bet', ({ telegram_id, username, bet, color }) => {
        if (systemSuspended) return;
        db.get("SELECT balance FROM users WHERE telegram_id = ?", [telegram_id], (err, user) => {
            if (user && user.balance >= bet && rouletteState.status === 'waiting') {
                db.run("UPDATE users SET balance = balance - ?, games_count = games_count + 1, turnover = turnover + ? WHERE telegram_id = ?", [bet, bet, telegram_id]);
                rouletteState.bets.push({ telegram_id, username, bet, color });
                io.emit('roulette_state', rouletteState);
            }
        });
    });
});

// Игровые циклы
function runRocketLoop() {
    rocketState = { status: 'waiting', multiplier: 1.00, timer: 15, bets: [], crashPoint: (Math.random() * 6.95 + 1.05).toFixed(2) };
    let t = setInterval(() => {
        rocketState.timer--; io.emit('rocket_state', rocketState);
        if (rocketState.timer <= 0) { clearInterval(t); launchRocket(); }
    }, 1000);
}

function launchRocket() {
    rocketState.status = 'live';
    let cur = 1.00;
    let f = setInterval(() => {
        cur += 0.03; rocketState.multiplier = parseFloat(cur.toFixed(2));
        rocketState.bets.forEach(b => {
            if (!b.cashedOut && b.autoWithdraw && rocketState.multiplier >= b.autoWithdraw && rocketState.multiplier <= rocketState.crashPoint) {
                b.cashedOut = true;
                db.run("UPDATE users SET balance = balance + ?, wins_count = wins_count + 1 WHERE telegram_id = ?", [b.bet * b.autoWithdraw, b.telegram_id]);
                db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit) VALUES (?, 'ROCKET', ?, ?, ?)", [b.telegram_id, b.bet, b.autoWithdraw, (b.bet * b.autoWithdraw) - b.bet]);
            }
        });
        io.emit('rocket_state', rocketState);

        if (rocketState.multiplier >= rocketState.crashPoint) {
            clearInterval(f); rocketState.status = 'crashed';
            rocketState.bets.forEach(b => { if (!b.cashedOut) db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit) VALUES (?, 'ROCKET', ?, 0, ?)", [b.telegram_id, b.bet, -b.bet]); });
            io.emit('rocket_state', rocketState);
            setTimeout(runRocketLoop, 5000);
        }
    }, 100);
}

function runRouletteLoop() {
    rouletteState.status = 'waiting'; rouletteState.timer = 15; rouletteState.bets = [];
    let t = setInterval(() => {
        rouletteState.timer--; io.emit('roulette_state', rouletteState);
        if (rouletteState.timer <= 0) { clearInterval(t); spinRoulette(); }
    }, 1000);
}

function spinRoulette() {
    if (rouletteState.bets.length < 2) { rouletteState.timer = 15; setTimeout(runRouletteLoop, 2000); return; }
    rouletteState.status = 'spinning'; io.emit('roulette_state', rouletteState);
    let total = rouletteState.bets.reduce((a, b) => a + b.bet, 0);
    let winTkt = Math.random() * total, sum = 0, winner = rouletteState.bets[0];
    for (let b of rouletteState.bets) { sum += b.bet; if (winTkt <= sum) { winner = b; break; } }
    
    db.serialize(() => {
        db.run("UPDATE users SET balance = balance + ?, wins_count = wins_count + 1 WHERE telegram_id = ?", [total, winner.telegram_id]);
        rouletteState.bets.forEach(b => {
            let p = (b.telegram_id === winner.telegram_id) ? (total - b.bet) : -b.bet;
            db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit) VALUES (?, 'ROULETTE', ?, ?, ?)", [b.telegram_id, b.bet, (b.telegram_id === winner.telegram_id ? total/b.bet : 0), p]);
        });
    });

    setTimeout(() => {
        rouletteState.history.unshift({ winner: winner.username, total });
        io.emit('roulette_result', { winner, total });
        setTimeout(runRouletteLoop, 7000);
    }, 3000);
}

server.listen(PORT, () => { runRocketLoop(); runRouletteLoop(); console.log(`Сервер запущен на порту ${PORT}`); });