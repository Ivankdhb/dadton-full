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

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Конфигурация Telegram
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const ADMIN_ID = '1631627984';
const MERCHANT_WALLET = 'EQYourMerchantWalletAddressHere...'; // Для TON платежей

// Инициализация БД SQLite
const db = new sqlite3.Database('./dadton.db', (err) => {
    if (err) console.error('Ошибка подключения к БД:', err.message);
    else console.log('Успешное подключение к SQLite БД.');
});

// Создание таблиц
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
});

// Глобальное состояние бота и игр
let botPaused = false;
let rocketState = {
    status: 'waiting', // waiting, flying, crashed
    multiplier: 1.00,
    crashPoint: 1.00,
    timer: 10,
    bets: [] // { telegram_id, name, avatar, amount, cashedOut: false, multiplier: 0 }
};

let rouletteState = {
    status: 'waiting', // waiting, rolling, ended
    timer: 15,
    bets: [], // { telegram_id, name, avatar, amount, color }
    totalBank: 0,
    winner: null
};

// Функция отправки сообщений админу в ТГ
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

// Помощник для отправки данных всем клиентам конкретной игры
function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Помощник для точечного обновления баланса
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

// Генератор краш-поинта по ТЗ
function generateCrashPoint() {
    const rand = Math.random() * 100;
    if (rand < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2));
    if (rand < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2));
    if (rand < 70) return parseFloat((1.50 + Math.random() * 0.50).toFixed(2));
    if (rand < 85) return parseFloat((2.00 + Math.random() * 1.00).toFixed(2));
    if (rand < 95) return parseFloat((3.00 + Math.random() * 2.00).toFixed(2));
    return parseFloat((5.00 + Math.random() * 3.00).toFixed(2));
}

// Логика цикла Ракеты
function runRocketLoop() {
    if (rocketState.status === 'waiting') {
        if (rocketState.timer > 0) {
            rocketState.timer--;
            broadcast({ type: 'rocket_tick', timer: rocketState.timer, bets: rocketState.bets });
            setTimeout(runRocketLoop, 1000);
        } else {
            if (botPaused) {
                rocketState.timer = 10;
                broadcast({ type: 'rocket_msg', msg: 'Бот временно приостановлен админом' });
                setTimeout(runRocketLoop, 3000);
                return;
            }
            rocketState.status = 'flying';
            rocketState.multiplier = 1.00;
            rocketState.crashPoint = generateCrashPoint();
            broadcast({ type: 'rocket_start', crashPoint: rocketState.crashPoint });
            setTimeout(runRocketLoop, 100);
        }
    } else if (rocketState.status === 'flying') {
        if (rocketState.multiplier >= rocketState.crashPoint) {
            rocketState.status = 'crashed';
            db.run("INSERT INTO rocket_history (multiplier) VALUES (?)", [rocketState.multiplier]);
            broadcast({ type: 'rocket_crash', multiplier: rocketState.multiplier });
            
            // Обработка проигравших
            rocketState.bets.forEach(b => {
                if (!b.cashedOut) {
                    db.run("UPDATE users SET turnover = turnover + ? WHERE telegram_id = ?", [b.amount, b.telegram_id]);
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
            
            // Проверка автовыводов
            rocketState.bets.forEach(b => {
                if (!b.cashedOut && b.autoCashout && rocketState.multiplier >= b.autoCashoutValue) {
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
        db.run("UPDATE users SET stars = stars + ?, turnover = turnover + ?, games_played = games_played + 1, wins = wins + 1 WHERE telegram_id = ?", [winAmount, bet.amount, tgId]);
        sendUserBalance(tgId);
    });
    broadcast({ type: 'rocket_cashout_success', telegram_id: tgId, multiplier: bet.multiplier, winAmount });
}

// Логика Рулетки
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
            rouletteState.timer = 15; // Сброс таймера если игроков < 2
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
            // Начисление банка победителю
            db.run("UPDATE users SET stars = stars + ?, wins = wins + 1, games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", [rouletteState.totalBank, winnerBet.amount, winnerBet.telegram_id]);
            // Обновление оборота проигравшим
            rouletteState.bets.forEach(b => {
                if (b.telegram_id !== winnerBet.telegram_id) {
                    db.run("UPDATE users SET games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", [b.amount, b.telegram_id]);
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

// Хендлеры API Эндпоинтов
app.post('/api/register', (req, res) => {
    const { telegram_id, name, avatar, username, referrer_id } = req.body;
    db.get("SELECT * FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
        if (row) {
            // Обновляем аватарку и имя, если они изменились в ТГ
            db.run("UPDATE users SET name = ?, avatar = ?, username = ? WHERE telegram_id = ?", [name, avatar, username]);
            return res.json({ success: true, user: { ...row, avatar, name, username } });
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

// Мины API (Логика сессий перенесена на сервер, чтобы исключить накрутки)
let activeMineGames = {}; // tgId -> { bet, minesCount, board, state: 'active', winFactor: 1.0 }
app.post('/api/games/mines/start', (req, res) => {
    const { telegram_id, amount, minesCount } = req.body;
    db.get("SELECT stars, banned FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
        if (!row || row.banned || row.stars < amount) return res.json({ success: false, msg: 'Ошибка баланса или блокировка' });
        
        // Создаём карту 5x5
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
            res.json({ success: true, msg: 'Игра началась' });
        });
    });
});

app.post('/api/games/mines/reveal', (req, res) => {
    const { telegram_id, index } = req.body;
    let game = activeMineGames[telegram_id];
    if (!game || game.status !== 'active') return res.json({ success: false });

    if (game.board[index]) {
        // Взрыв
        game.status = 'lost';
        db.run("UPDATE users SET games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", [game.bet, telegram_id]);
        delete activeMineGames[telegram_id];
        sendUserBalance(telegram_id);
        return res.json({ success: true, hitMine: true, board: game.board });
    } else {
        if (!game.revealed.includes(index)) game.revealed.push(index);
        
        // Рассчёт множителя по формулам ТЗ
        let base = 1.04;
        if (game.minesCount === 10) base = 1.12;
        if (game.minesCount === 15) base = 1.30;
        if (game.minesCount === 20) base = 2.00;
        if (game.minesCount === 24) base = 3.00;

        let currentMultiplier = parseFloat(Math.pow(base, game.revealed.length).toFixed(2));
        let maxSafe = 25 - game.minesCount;

        if (game.revealed.length === maxSafe) {
            // Авто-выигрыш, открыты все чистые поля
            let winAmount = Math.floor(game.bet * currentMultiplier);
            db.run("UPDATE users SET stars = stars + ?, wins = wins + 1, games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", [winAmount, game.bet, telegram_id]);
            delete activeMineGames[telegram_id];
            sendUserBalance(telegram_id);
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

    db.run("UPDATE users SET stars = stars + ?, wins = wins + 1, games_played = games_played + 1, turnover = turnover + ? WHERE telegram_id = ?", [winAmount, game.bet, telegram_id]);
    delete activeMineGames[telegram_id];
    sendUserBalance(telegram_id);
    res.json({ success: true, winAmount, multiplier: currentMultiplier });
});

// Роуты вывода денег и ТГ оповещений админа
app.post('/api/withdraw-request', (req, res) => {
    const { telegram_id, name, username, amount, asset, wallet } = req.body;
    db.get("SELECT stars FROM users WHERE telegram_id = ?", [telegram_id], (err, row) => {
        if (!row || row.stars < amount) return res.json({ success: false, msg: 'Недостаточно звёзд' });
        
        db.serialize(() => {
            db.run("UPDATE users SET stars = stars - ? WHERE telegram_id = ?", [amount, telegram_id]);
            db.run("INSERT INTO withdraw_requests (telegram_id, name, username, amount, asset, wallet) VALUES (?, ?, ?, ?, ?, ?)",
                [telegram_id, name, username, amount, asset, wallet]);
            db.run("UPDATE user_finance SET withdrawn = withdrawn + ? WHERE telegram_id = ?", [amount, telegram_id]);
            
            sendUserBalance(telegram_id);

            // Нативное уведомление админу по ТЗ
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

// Генерация ссылки инвойса на оплату Telegram Stars
app.post('/api/create-invoice', async (req, res) => {
    const { telegram_id, amount } = req.body;
    try {
        const response = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            title: `Пополнение баланса DadTon`,
            description: `Зачисление ${amount} звёзд на игровой аккаунт`,
            payload: `stars_deposit_${telegram_id}_${Date.now()}`,
            provider_token: "", // Пусто для Telegram Stars
            currency: "XTR",
            prices: [{ label: `${amount} Stars`, amount: parseInt(amount) }]
        });
        if (response.data && response.data.ok) {
            res.json({ success: true, invoice_link: response.data.result });
        } else {
            res.json({ success: false, error: 'Ошибка Telegram API' });
        }
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// Вебхук от ТГ для подтверждения транзакций Stars
app.post('/webhook/telegram', (req, res) => {
    const update = req.body;
    if (update.pre_checkout_query) {
        // Отвечаем ТГ, что всё ок, готовы принять платеж
        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
            pre_checkout_query_id: update.pre_checkout_query.id,
            ok: true
        });
        return res.sendStatus(200);
    }

    if (update.message && update.message.successful_payment) {
        const payment = update.message.successful_payment;
        const payload = payment.invoice_payload;
        if (payload.startsWith('stars_deposit_')) {
            const parts = payload.split('_');
            const tgId = parts[2];
            const amount = payment.total_amount;

            db.serialize(() => {
                db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [amount, tgId]);
                db.run("UPDATE user_finance SET deposited = deposited + ? WHERE telegram_id = ?", [amount, tgId]);
                
                // Начисление 5% рефереру
                db.get("SELECT referrer_id FROM users WHERE telegram_id = ?", [tgId], (err, uRow) => {
                    if (uRow && uRow.referrer_id) {
                        let refBonus = Math.floor(amount * 0.05);
                        db.run("UPDATE users SET stars = stars + ? WHERE telegram_id = ?", [refBonus, uRow.referrer_id]);
                        sendUserBalance(uRow.referrer_id);
                    }
                });
                sendUserBalance(tgId);
            });
        }
    }
    res.sendStatus(200);
});

// Админ-панель API
app.post('/api/admin/get-users', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    db.all("SELECT * FROM users", [], (err, rows) => { res.json(rows); });
});

app.post('/api/admin/get-withdraw-requests', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    db.all("SELECT * FROM withdraw_requests WHERE status = 'pending'", [], (err, rows) => { res.json(rows); });
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
    botPaused = true; res.json({ success: true });
});

app.post('/api/admin/resume-bot', (req, res) => {
    if (req.body.admin_id !== ADMIN_ID) return res.status(403).json({ error: 'Access denied' });
    botPaused = false; res.json({ success: true });
});

// WebSocket роутинг
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'auth') {
                ws.telegram_id = data.telegram_id;
            }
            if (data.type === 'rocket_bet') {
                if (rocketState.status !== 'waiting') return ws.send(JSON.stringify({ type: 'err', msg: 'Раунд уже идёт!' }));
                db.get("SELECT stars FROM users WHERE telegram_id = ?", [data.telegram_id], (err, row) => {
                    if (row && row.stars >= data.amount) {
                        db.run("UPDATE users SET stars = stars - ? WHERE telegram_id = ?", [data.amount, data.telegram_id], () => {
                            rocketState.bets.push({
                                telegram_id: data.telegram_id,
                                name: data.name,
                                avatar: data.avatar || '',
                                amount: data.amount,
                                autoCashout: data.autoCashout,
                                autoCashoutValue: parseFloat(data.autoCashoutValue),
                                cashedOut: false
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
            if (data.type === 'roulette_bet') {
                if (rouletteState.status !== 'waiting') return;
                db.get("SELECT stars FROM users WHERE telegram_id = ?", [data.telegram_id], (err, row) => {
                    if (row && row.stars >= data.amount) {
                        db.run("UPDATE users SET stars = stars - ? WHERE telegram_id = ?", [data.amount, data.telegram_id], () => {
                            const colors = ['#ff4444', '#00cc66', '#3B82F6', '#FFD700', '#A855F7'];
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
        } catch (e) { console.error(e); }
    });
});

// Запуск фоновых циклов
runRocketLoop();
runRouletteLoop();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));