const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const ADMIN_ID = "1631627984";

// Middleware
app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// Настройка путей статики
let publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
    const alternativePath = path.join(__dirname, '..', 'public');
    if (fs.existsSync(alternativePath)) publicPath = alternativePath;
}
app.use(express.static(publicPath));

// Инициализация базы данных SQLite
const db = new sqlite3.Database('/tmp/dadton_premium.db', (err) => {
    if (err) {
        console.error('❌ КРИТИЧЕСКАЯ ОШИБКА ИНИЦИАЛИЗАЦИИ БД:', err);
    } else {
        console.log('📝 База данных успешно подключена и инициализирована.');
    }
});

// Создание табличной структуры
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        balance REAL DEFAULT 100.0,
        wallet TEXT DEFAULT '',
        avatar_url TEXT DEFAULT 'https://img.icons8.com/sticky/100/user-male-circle.png',
        games_count INTEGER DEFAULT 0,
        turnover REAL DEFAULT 0,
        wins_count INTEGER DEFAULT 0,
        is_blocked INTEGER DEFAULT 0,
        referrer_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS game_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        game_type TEXT,
        bet REAL,
        multiplier REAL,
        profit REAL,
        details TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT,
        amount REAL,
        type TEXT,
        status TEXT DEFAULT 'COMPLETED',
        tx_hash TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Глобальное состояние комнат мультиплеера
let rocketState = {
    status: 'waiting', // waiting, live, crashed
    multiplier: 1.00,
    timer: 10,
    bets: [],
    history: [1.20, 4.50, 1.05, 2.10, 18.40, 1.15, 3.12, 1.67]
};

let rouletteState = {
    status: 'waiting', // waiting, spinning, finished
    timer: 12,
    bets: [],
    winningIndex: -1,
    winningItem: null,
    history: [],
    pool: []
};

// Сетка наград для кейс-рулетки
const ROULETTE_REWARDS = [
    { id: 1, type: 'stars', value: 0, label: '0 ⭐', color: '#555555', chance: 20 },
    { id: 2, type: 'stars', value: 5, label: '5 ⭐', color: '#3b82f6', chance: 35 },
    { id: 3, type: 'stars', value: 20, label: '20 ⭐', color: '#a855f7', chance: 25 },
    { id: 4, type: 'stars', value: 50, label: '50 ⭐', color: '#ec4899', chance: 12 },
    { id: 5, type: 'stars', value: 250, label: '250 ⭐', color: '#eab308', chance: 7 },
    { id: 6, type: 'stars', value: 1000, label: '1000 ⭐', color: '#ef4444', chance: 1 }
];

// --- API РУТЫ ---

// Синхронизация профиля
app.post('/api/user/sync', (req, res) => {
    const { telegram_id, username, referrer_id, avatar_url } = req.body;
    if (!telegram_id) return res.status(400).json({ error: "Отсутствует Telegram ID" });

    db.get("SELECT * FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, row) => {
        if (err) return res.status(500).json({ error: "Внутренняя ошибка базы данных" });

        if (row) {
            if (row.is_blocked === 1) return res.status(403).json({ error: "Доступ к платформе заблокирован администрацией" });
            
            // Динамическое обновление юзернейма или аватарки, если они изменились в ТГ
            let currentAvatar = avatar_url || row.avatar_url;
            let currentName = username || row.username;
            db.run("UPDATE users SET username = ?, avatar_url = ? WHERE telegram_id = ?", [currentName, currentAvatar, String(telegram_id)]);
            
            db.get("SELECT * FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, updatedRow) => {
                return res.json(updatedRow);
            });
        } else {
            let cleanRefId = referrer_id ? String(referrer_id).replace('ref_', '') : null;
            if (cleanRefId === String(telegram_id)) cleanRefId = null;
            
            const defAvatar = avatar_url || `https://api.dicebear.com/7.x/bottts/svg?seed=${telegram_id}`;
            const finalName = username || `Игрок #${telegram_id.slice(-4)}`;

            db.run("INSERT INTO users (telegram_id, username, balance, referrer_id, avatar_url) VALUES (?, ?, 250.0, ?, ?)", 
                [String(telegram_id), finalName, cleanRefId, defAvatar], function(err) {
                if (err) return res.status(500).json({ error: "Не удалось создать учетную запись" });
                
                // Бонус рефереру, если он есть
                if (cleanRefId) {
                    db.run("UPDATE users SET balance = balance + 50.0 WHERE telegram_id = ?", [cleanRefId]);
                }

                db.get("SELECT * FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, newRow) => res.json(newRow));
            });
        }
    });
});

// Получение профиля
app.get('/api/user/:id', (req, res) => {
    db.get("SELECT * FROM users WHERE telegram_id = ?", [String(req.params.id)], (err, row) => {
        if (err || !row) return res.status(404).json({ error: "Пользователь не найден" });
        res.json(row);
    });
});

// Сохранение TON кошелька
app.post('/api/user/wallet', (req, res) => {
    const { telegram_id, wallet } = req.body;
    db.run("UPDATE users SET wallet = ? WHERE telegram_id = ?", [wallet, String(telegram_id)], (err) => {
        if (err) return res.status(500).json({ error: "Ошибка сохранения адреса" });
        res.json({ success: true });
    });
});

// Запрос глобальной таблицы лидеров по обороту
app.get('/api/leaderboard', (req, res) => {
    db.all("SELECT username, telegram_id, turnover, avatar_url FROM users ORDER BY turnover DESC LIMIT 100", (err, rows) => {
        if (err) return res.status(500).json({ error: "Не удалось прочитать таблицу лидеров" });
        res.json(rows);
    });
});

// Одиночная игра: МИНЫ (Оборот засчитывается в момент успешного съема средств)
app.post('/api/games/mines/play', (req, res) => {
    const { telegram_id, bet, minesCount, selectedCells } = req.body;
    
    if (!telegram_id || !bet || bet <= 0 || !minesCount || !selectedCells || selectedCells.length === 0) {
        return res.status(400).json({ error: "Некорректные параметры игрового раунда" });
    }

    db.get("SELECT balance FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, user) => {
        if (err || !user) return res.status(404).json({ error: "Пользователь отсутствует" });
        if (user.balance < bet) return res.status(400).json({ error: "Недостаточный баланс для совершения ставки" });

        // Генерация минного поля (0 - безопасно, 1 - мина)
        let grid = Array(25).fill(0);
        let deployedMines = 0;
        while (deployedMines < minesCount) {
            let rIdx = Math.floor(Math.random() * 25);
            if (grid[rIdx] === 0) {
                grid[rIdx] = 1;
                deployedMines++;
            }
        }

        // Проверка нажатых ячеек
        let hitMine = false;
        for (let cell of selectedCells) {
            if (grid[cell] === 1) {
                hitMine = true;
                break;
            }
        }

        // Прогрессивный шаг множителя в зависимости от плотности мин
        let baseStep = 1.00;
        if (minesCount === 3) baseStep = 1.05;
        else if (minesCount === 5) baseStep = 1.14;
        else if (minesCount === 10) baseStep = 1.35;
        else if (minesCount === 15) baseStep = 1.75;
        else baseStep = 2.20;

        let finalMultiplier = hitMine ? 0.00 : Math.pow(baseStep, selectedCells.length);
        if (finalMultiplier > 1000) finalMultiplier = 1000; // Ограничение максимального икса

        let winPayout = bet * finalMultiplier;
        let totalProfit = hitMine ? -bet : (winPayout - bet);
        
        // В оборот идет полная сумма выигрыша (сколько вывел человек, как в ТЗ)[span_0](start_span)[span_0](end_span)
        let addedTurnover = hitMine ? 0 : winPayout; 

        db.serialize(() => {
            db.run(`UPDATE users SET 
                balance = balance + ?, 
                games_count = games_count + 1, 
                turnover = turnover + ?, 
                wins_count = wins_count + ? 
                WHERE telegram_id = ?`, 
                [totalProfit, addedTurnover, hitMine ? 0 : 1, String(telegram_id)]);

            db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit, details) VALUES (?, 'MINES', ?, ?, ?, ?)",
                [String(telegram_id), bet, finalMultiplier, totalProfit, JSON.stringify({ selectedCells, minesCount })]);

            db.get("SELECT balance, turnover FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, upUser) => {
                res.json({
                    hitMine,
                    finalMultiplier: parseFloat(finalMultiplier.toFixed(2)),
                    profit: parseFloat(totalProfit.toFixed(2)),
                    balance: upUser.balance,
                    turnover: upUser.turnover,
                    minesGrid: grid
                });
            });
        });
    });
});

// Запрос истории последних игр пользователя
app.get('/api/history/:id', (req, res) => {
    db.all("SELECT * FROM game_history WHERE telegram_id = ? ORDER BY id DESC LIMIT 15", [String(req.params.id)], (err, rows) => {
        if (err) return res.status(500).json({ error: "Ошибка запроса истории" });
        res.json(rows);
    });
});

// Имитация депозита/вывода (для автономности и тестов интерфейса)
app.post('/api/wallet/transaction', (req, res) => {
    const { telegram_id, amount, type } = req.body; // type: 'DEPOSIT' или 'WITHDRAW'
    if(!telegram_id || !amount || amount <= 0) return res.status(400).json({ error: "Invalid parameters" });

    db.get("SELECT balance FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, user) => {
        if(!user) return res.status(404).json({ error: "User not found" });

        let change = type === 'DEPOSIT' ? amount : -amount;
        if(type === 'WITHDRAW' && user.balance < amount) return res.status(400).json({ error: "Insufficient funds" });

        db.serialize(() => {
            db.run("UPDATE users SET balance = balance + ? WHERE telegram_id = ?", [change, String(telegram_id)]);
            db.run("INSERT INTO transactions (telegram_id, amount, type, tx_hash) VALUES (?, ?, ?, ?)", 
                [String(telegram_id), amount, type, crypto.randomBytes(16).toString('hex')]);
            db.get("SELECT balance FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, updated) => {
                res.json({ success: true, balance: updated.balance });
            });
        });
    });
});


// --- ЯДРО ИГРОВЫХ ЦИКЛОВ МУЛЬТИПЛЕЕРА (CRASH / CASE ROULETTE) ---

function selectRouletteItem() {
    let roll = Math.random() * 100;
    let sum = 0;
    for (let item of ROULETTE_REWARDS) {
        sum += item.chance;
        if (roll <= sum) return item;
    }
    return ROULETTE_REWARDS[0];
}

function runMultiplayerEngine() {
    // Регулярный тик для проверки состояния ракеты и рулетки кейсов
    setInterval(() => {
        // --- ОБРАБОТКА РАКЕТЫ (CRASH) ---
        if (rocketState.status === 'waiting') {
            rocketState.timer -= 0.1;
            if (rocketState.timer <= 0) {
                rocketState.status = 'live';
                rocketState.multiplier = 1.00;
                // Алгоритм генерации точки взрыва
                let e = Math.random();
                if (e < 0.05) rocketState.crashPoint = 1.00; // Мгновенный краш
                else rocketState.crashPoint = parseFloat((0.96 / (Math.random() * 0.9 + 0.02)).toFixed(2));
                
                if (rocketState.crashPoint > 200) rocketState.crashPoint = parseFloat((50 + Math.random() * 100).toFixed(2));
                if (rocketState.crashPoint < 1.00) rocketState.crashPoint = 1.01;
            }
            io.emit('rocket_state', rocketState);
        } else if (rocketState.status === 'live') {
            // Плавное ускорение роста множителя
            let increment = 0.008 * Math.sqrt(rocketState.multiplier);
            rocketState.multiplier += increment;

            // Проверка авто-выводов игроков в реальном времени
            rocketState.bets.forEach(b => {
                if (!b.cashedOut && b.autoWithdraw > 1.00 && rocketState.multiplier >= b.autoWithdraw && b.autoWithdraw <= rocketState.crashPoint) {
                    b.cashedOut = true;
                    b.finalMultiplier = b.autoWithdraw;
                    let winAmount = b.bet * b.autoWithdraw;
                    
                    db.run("UPDATE users SET balance = balance + ?, turnover = turnover + ?, wins_count = wins_count + 1 WHERE telegram_id = ?", 
                        [winAmount, winAmount, b.telegram_id]);
                    
                    db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit, details) VALUES (?, 'ROCKET', ?, ?, ?, 'AUTO_CASH_OUT')",
                        [b.telegram_id, b.bet, b.autoWithdraw, winAmount - b.bet]);
                        
                    io.emit('rocket_player_cashed', { telegram_id: b.telegram_id, winAmount, multiplier: b.autoWithdraw });
                }
            });

            // Триггер взрыва ракеты
            if (rocketState.multiplier >= rocketState.crashPoint) {
                rocketState.multiplier = rocketState.crashPoint;
                rocketState.status = 'crashed';
                rocketState.history.unshift(rocketState.crashPoint);
                if (rocketState.history.length > 12) rocketState.history.pop();
                
                // Все кто не сняли — проиграли ставку (деньги списаны при входе)
                rocketState.bets.forEach(b => {
                    if(!b.cashedOut) {
                        db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit, details) VALUES (?, 'ROCKET', ?, 0, ?, 'CRASHED')",
                            [b.telegram_id, b.bet, -b.bet]);
                    }
                });

                io.emit('rocket_state', rocketState);

                setTimeout(() => {
                    rocketState.status = 'waiting';
                    rocketState.timer = 8.0;
                    rocketState.bets = [];
                    rocketState.multiplier = 1.00;
                }, 4000);
            }
            io.emit('rocket_state', rocketState);
        }

        // --- ОБРАБОТКА ГОРИЗОНТАЛЬНОЙ РУЛЕТКИ КЕЙСОВ ---
        if (rouletteState.status === 'waiting') {
            rouletteState.timer -= 0.1;
            if (rouletteState.timer <= 0) {
                if (rouletteState.bets.length === 0) {
                    // Перезапуск таймера если никто не поставил, чтобы не крутить впустую
                    rouletteState.timer = 10;
                } else {
                    rouletteState.status = 'spinning';
                    // Заранее генерируем выигрышный элемент и ленту из 60 элементов для анимации
                    rouletteState.winningItem = selectRouletteItem();
                    
                    let generatedPool = [];
                    for(let i=0; i<60; i++) {
                        if(i === 45) { // 45-й элемент будет центральным финишером
                            generatedPool.push(rouletteState.winningItem);
                        } else {
                            let randItem = ROULETTE_REWARDS[Math.floor(Math.random() * ROULETTE_REWARDS.length)];
                            generatedPool.push(randItem);
                        }
                    }
                    rouletteState.pool = generatedPool;
                    
                    // Выплачиваем награду всем участникам раунда рулетки
                    rouletteState.bets.forEach(b => {
                        let rewardValue = rouletteState.winningItem.value;
                        // Расчет: если это чистый выигрыш звезд, начисляем и пишем в оборот сумму выигрыша[span_1](start_span)[span_1](end_span)
                        db.run("UPDATE users SET balance = balance + ?, turnover = turnover + ?, wins_count = wins_count + 1 WHERE telegram_id = ?",
                            [rewardValue, rewardValue, b.telegram_id]);
                        
                        db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit, details) VALUES (?, 'ROULETTE', ?, ?, ?, ?)",
                            [b.telegram_id, b.bet, (rewardValue/b.bet), rewardValue - b.bet, JSON.stringify({ won: rouletteState.winningItem })]);
                    });

                    io.emit('roulette_spin_start', { pool: rouletteState.pool, winningIndex: 45 });
                    
                    // Время прокрутки анимации на клиенте — 6 секунд
                    setTimeout(() => {
                        rouletteState.status = 'finished';
                        rouletteState.history.unshift(rouletteState.winningItem);
                        if(rouletteState.history.length > 10) rouletteState.history.pop();
                        
                        io.emit('roulette_state', rouletteState);

                        setTimeout(() => {
                            rouletteState.status = 'waiting';
                            rouletteState.timer = 12;
                            rouletteState.bets = [];
                            rouletteState.pool = [];
                            rouletteState.winningItem = null;
                            io.emit('roulette_state', rouletteState);
                        }, 3000);

                    }, 6500);
                }
            }
            io.emit('roulette_state', rouletteState);
        }
    }, 100);
}

// WS Слушатели событий событий
io.on('connection', (socket) => {
    
    socket.on('request_sync', () => {
        socket.emit('rocket_state', rocketState);
        socket.emit('roulette_state', rouletteState);
    });

    // Ставка в ракету
    socket.on('rocket_bet', ({ telegram_id, username, bet, autoWithdraw }) => {
        if (!telegram_id || bet <= 0 || rocketState.status !== 'waiting') return;

        db.get("SELECT balance FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, user) => {
            if (user && user.balance >= bet) {
                // Списываем сразу в момент фиксации ставки
                db.run("UPDATE users SET balance = balance - ?, games_count = games_count + 1 WHERE telegram_id = ?", [bet, String(telegram_id)]);
                
                // Проверяем дубликат ставки в этом раунде
                let existingBet = rocketState.bets.find(b => b.telegram_id === String(telegram_id));
                if (!existingBet) {
                    rocketState.bets.push({
                        telegram_id: String(telegram_id),
                        username: username || "Аноним",
                        bet: parseFloat(bet),
                        autoWithdraw: parseFloat(autoWithdraw || 0),
                        cashedOut: false
                    });
                    io.emit('rocket_state', rocketState);
                }
            } else {
                socket.emit('game_error', { message: "Недостаточно звезд на балансе!" });
            }
        });
    });

    // Ручной съем средств из ракеты во время полета
    socket.on('rocket_cashout', ({ telegram_id }) => {
        if (rocketState.status !== 'live') return;
        
        let playerBet = rocketState.bets.find(b => b.telegram_id === String(telegram_id) && !b.cashedOut);
        if (playerBet) {
            playerBet.cashedOut = true;
            let currentMult = rocketState.multiplier;
            playerBet.finalMultiplier = currentMult;
            let winAmount = playerBet.bet * currentMult;

            db.run("UPDATE users SET balance = balance + ?, turnover = turnover + ?, wins_count = wins_count + 1 WHERE telegram_id = ?", 
                [winAmount, winAmount, String(telegram_id)]);
            
            db.run("INSERT INTO game_history (telegram_id, game_type, bet, multiplier, profit, details) VALUES (?, 'ROCKET', ?, ?, ?, 'MANUAL_CASH_OUT')",
                [String(telegram_id), playerBet.bet, currentMult, winAmount - playerBet.bet]);

            io.emit('rocket_player_cashed', { telegram_id: String(telegram_id), winAmount, multiplier: currentMult });
            io.emit('rocket_state', rocketState);
        }
    });

    // Покупка билета в рулетку кейсов
    socket.on('roulette_join', ({ telegram_id, username, bet }) => {
        if (!telegram_id || bet <= 0 || rouletteState.status !== 'waiting') return;

        db.get("SELECT balance FROM users WHERE telegram_id = ?", [String(telegram_id)], (err, user) => {
            if (user && user.balance >= bet) {
                db.run("UPDATE users SET balance = balance - ?, games_count = games_count + 1 WHERE telegram_id = ?", [bet, String(telegram_id)]);
                
                let alreadyIn = rouletteState.bets.find(b => b.telegram_id === String(telegram_id));
                if(!alreadyIn) {
                    rouletteState.bets.push({ telegram_id: String(telegram_id), username: username || "Игрок", bet: parseFloat(bet) });
                    io.emit('roulette_state', rouletteState);
                }
            } else {
                socket.emit('game_error', { message: "Недостаточно звезд для открытия кейса!" });
            }
        });
    });
});

// Запуск игровых серверов
runMultiplayerEngine();

server.listen(PORT, () => {
    console.log(`🚀 Высокоплотный игровой бэкенд развернут на порту: ${PORT}`);
});