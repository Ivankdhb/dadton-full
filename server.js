require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// --- ИГРОВОЙ ДВИЖОК: КРАШ-РАКЕТА ---
let rocketState = {
    status: 'waiting', // waiting -> flying -> crashed
    multiplier: 1.00,
    timer: 10,
    crashPoint: 1.00
};

function generateCrashPoint() {
    const rand = Math.random() * 100;
    if (rand < 25) return parseFloat((1.05 + Math.random() * 0.15).toFixed(2)); // 25% -> 1.05 - 1.20
    if (rand < 50) return parseFloat((1.20 + Math.random() * 0.30).toFixed(2)); // 25% -> 1.20 - 1.50
    if (rand < 70) return parseFloat((1.50 + Math.random() * 0.50).toFixed(2)); // 20% -> 1.50 - 2.00
    if (rand < 85) return parseFloat((2.00 + Math.random() * 1.00).toFixed(2)); // 15% -> 2.00 - 3.00
    if (rand < 95) return parseFloat((3.00 + Math.random() * 2.00).toFixed(2)); // 10% -> 3.00 - 5.00
    return parseFloat((5.00 + Math.random() * 3.00).toFixed(2));                // 5%  -> 5.00 - 8.00
}

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function runRocketLoop() {
    rocketState.status = 'waiting';
    rocketState.timer = 10;
    rocketState.multiplier = 1.00;
    rocketState.crashPoint = generateCrashPoint();

    console.log(`[Rocket] Запланирован краш на: ${rocketState.crashPoint}x`);

    const countdown = setInterval(() => {
        rocketState.timer--;
        broadcast({ type: 'rocket_tick', time: rocketState.timer });

        if (rocketState.timer <= 0) {
            clearInterval(countdown);
            startRocketFlight();
        }
    }, 1000);
}

function startRocketFlight() {
    rocketState.status = 'flying';
    
    const flight = setInterval(() => {
        rocketState.multiplier += 0.04; // Скорость роста множителя
        
        if (rocketState.multiplier >= rocketState.crashPoint) {
            clearInterval(flight);
            rocketState.status = 'crashed';
            broadcast({ type: 'rocket_crash', mult: rocketState.crashPoint });
            
            // Перезапуск цикла игры через 4 секунды паузы
            setTimeout(runRocketLoop, 4000);
        } else {
            broadcast({ type: 'rocket_fly', mult: rocketState.multiplier });
        }
    }, 150); // Шаг обновления ~150мс
}

// Запуск игрового цикла Ракеты при старте сервера
runRocketLoop();


// --- МУЛЬТИПЛЕЕРНАЯ РУЛЕТКА (БАКЕНД МЕХАНИКА) ---
let rouletteBets = [];
let rouletteTimer = 15;

setInterval(() => {
    if (rouletteTimer > 0) {
        rouletteTimer--;
    } else {
        // Расчет победителя по весам ставок
        if (rouletteBets.length > 0) {
            let totalBank = rouletteBets.reduce((sum, b) => sum + b.amount, 0);
            let adminFee = totalBank * 0.05; // 5% комиссия
            let winningBank = totalBank - adminFee;

            // Рандом с весами
            let pointer = Math.random() * totalBank;
            let currentSum = 0;
            let winner = rouletteBets[0];

            for (let bet of rouletteBets) {
                currentSum += bet.amount;
                if (pointer <= currentSum) {
                    winner = bet;
                    break;
                }
            }
            console.log(`[Roulette] Победитель: ${winner.username}. Выигрыш: ${winningBank} ⭐`);
            broadcast({ type: 'roulette_end', winner: winner.username, prize: winningBank });
            rouletteBets = []; // Сброс банка
        }
        rouletteTimer = 15; // Сброс таймера
    }
}, 1000);


// --- API ЭНДПОИНТЫ ---
app.post('/api/register', (req, res) => {
    const { telegram_id, name } = req.body;
    // Здесь должна быть запись в БД PostgreSQL / Prisma.
    // Возвращаем мок успешного входа
    res.json({ success: true, message: "User registered premium layout verified" });
});

// Telegram Stars Webhook инвойсов
app.post('/webhook/telegram', (req, res) => {
    const payload = req.body;
    // Проверка успешной оплаты Stars от серверов Telegram
    console.log('[Stars Webhook] Получена оплата:', payload);
    res.sendStatus(200);
});

// Соединение по Вебсокету
wss.on('connection', (ws) => {
    console.log('[WS] Новое премиум-подключение установлено');
    
    // Отправляем текущий стейт новому игроку
    ws.send(JSON.stringify({ type: 'welcome', msg: 'Connected to Premium DadTon Server Backend' }));

    ws.on('close', () => console.log('[WS] Подключение закрыто'));
});

server.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`💎 DADTON SERVER EXECUTED SUCCESSFULLY ON PORT ${PORT}`);
    console.log(`👑 DESIGN STYLE: BLACK & GOLD PREMIAL`);
    console.log(`====================================================`);
});