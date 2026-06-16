const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Подключение к БД
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ===== TON CONNECT =====
const TON_CONNECT_MANIFEST = {
    url: process.env.SERVER_URL || 'https://dadton-full.onrender.com',
    name: 'DadTon',
    iconUrl: 'https://dadton-full.onrender.com/icon.png',
    termsOfUseUrl: 'https://dadton-full.onrender.com/terms',
    privacyPolicyUrl: 'https://dadton-full.onrender.com/privacy'
};

// Хранилище сессий TonConnect
const tonSessions = new Map();

// Эндпоинты для TonConnect
app.get('/tonconnect-manifest.json', (req, res) => {
    res.json(TON_CONNECT_MANIFEST);
});

app.post('/tonconnect/connect', async (req, res) => {
    try {
        const { address, publicKey, walletName } = req.body;
        
        // Проверка подписи (упрощенная, для реального использования нужна полноценная верификация)
        const sessionId = crypto.randomBytes(32).toString('hex');
        const session = {
            address,
            publicKey,
            walletName,
            connectedAt: Date.now()
        };
        
        tonSessions.set(sessionId, session);
        
        res.json({
            success: true,
            sessionId,
            address,
            balance: await getTonBalance(address)
        });
    } catch (error) {
        console.error('TonConnect error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/tonconnect/disconnect', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId && tonSessions.has(sessionId)) {
        tonSessions.delete(sessionId);
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, error: 'Session not found' });
    }
});

app.get('/tonconnect/balance/:address', async (req, res) => {
    try {
        const balance = await getTonBalance(req.params.address);
        res.json({ balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Функция получения баланса TON
async function getTonBalance(address) {
    try {
        const response = await axios.get(
            `https://tonapi.io/v1/account/getBalance?account=${address}`,
            { headers: { 'Authorization': `Bearer ${process.env.TON_API_KEY}` } }
        );
        return response.data.balance / 1e9; // конвертация в TON
    } catch (error) {
        console.error('Balance fetch error:', error);
        return 0;
    }
}

// ===== ИНИЦИАЛИЗАЦИЯ БД =====
async function initDB() {
    const client = await pool.connect();
    try {
        // Пользователи
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

        // NFT
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

        // История ставок
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

        // Заявки на вывод
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

        // Транзакции TON
        await client.query(`
            CREATE TABLE IF NOT EXISTS ton_transactions (
                id SERIAL PRIMARY KEY,
                telegram_id BIGINT,
                amount DECIMAL(20,9),
                tx_hash VARCHAR(255),
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

// ===== СОСТОЯНИЯ ИГР =====

// Ракета
let rocketState = {
    status: 'waiting',
    timer: 10,
    multiplier: 1.00,
    crashPoint: 1.05,
    bets: [],
    history: []
};

// Рулетка
let rouletteState = {
    status: 'waiting',
    timer: 15,
    bets: [],
    total: 0,
    history: []
};

// Цвета рулетки
const rouletteColors = [];
for (let i = 0; i < 14; i++) rouletteColors.push('red');
for (let i = 0; i < 14; i++) rouletteColors.push('blue');
for (let i = 0; i < 2; i++) rouletteColors.push('green');

// ===== WEBSOCKET =====
const wss = new WebSocket.Server({ port: 8080 });
const clients = new Map();

// ===== ФУНКЦИИ БД =====

async function createUser(telegramId, username, avatar) {
    const query = `
        INSERT INTO users (telegram_id, username, avatar, stars)
        VALUES ($1, $2, $3, 0)
        ON CONFLICT (telegram_id) 
        DO UPDATE SET username = EXCLUDED.username, avatar = EXCLUDED.avatar
        RETURNING *
    `;
    const result = await pool.query(query, [telegramId, username, avatar]);
    return result.rows[0];
}

async function getUser(telegramId) {
    const query = 'SELECT * FROM users WHERE telegram_id = $1';
    const result = await pool.query(query, [telegramId]);
    return result.rows[0];
}

async function updateStars(telegramId, amount) {
    const query = `
        UPDATE users 
        SET stars = stars + $1 
        WHERE telegram_id = $2 
        RETURNING stars
    `;
    const result = await pool.query(query, [amount, telegramId]);
    return result.rows[0]?.stars;
}

async function updateTonAddress(telegramId, address) {
    const query = `
        UPDATE users 
        SET ton_address = $1 
        WHERE telegram_id = $2 
        RETURNING *
    `;
    const result = await pool.query(query, [address, telegramId]);
    return result.rows[0];
}

async function updateStats(telegramId, game, amount, win, multiplier) {
    const query = `
        UPDATE users 
        SET total_bet = total_bet + $1,
            total_win = total_win + $2,
            games_played = games_played + 1,
            wins = wins + CASE WHEN $2 > 0 THEN 1 ELSE 0 END
        WHERE telegram_id = $3
    `;
    await pool.query(query, [amount, win, telegramId]);

    const historyQuery = `
        INSERT INTO bet_history (telegram_id, game, amount, win, multiplier)
        VALUES ($1, $2, $3, $4, $5)
    `;
    await pool.query(historyQuery, [telegramId, game, amount, win, multiplier]);
}

async function getNFTsForSale() {
    const query = `
        SELECT n.*, u.username as seller_name 
        FROM nft_items n
        JOIN users u ON n.seller_id = u.telegram_id
        WHERE n.for_sale = TRUE AND n.owner_id IS NULL
        ORDER BY n.created_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function getUserNFTs(telegramId) {
    const query = 'SELECT * FROM nft_items WHERE owner_id = $1 ORDER BY created_at DESC';
    const result = await pool.query(query, [telegramId]);
    return result.rows;
}

async function addNFT(name, imageUrl, rarity, price, sellerId) {
    const query = `
        INSERT INTO nft_items (name, image_url, rarity, price, seller_id, for_sale)
        VALUES ($1, $2, $3, $4, $5, TRUE)
        RETURNING *
    `;
    const result = await pool.query(query, [name, imageUrl, rarity, price, sellerId]);
    return result.rows[0];
}

async function buyNFT(nftId, buyerId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        const nftQuery = 'SELECT * FROM nft_items WHERE id = $1 AND for_sale = TRUE';
        const nftResult = await client.query(nftQuery, [nftId]);
        if (nftResult.rows.length === 0) throw new Error('NFT not found');
        
        const nft = nftResult.rows[0];
        
        const userQuery = 'SELECT stars FROM users WHERE telegram_id = $1';
        const userResult = await client.query(userQuery, [buyerId]);
        if (userResult.rows[0].stars < nft.price) throw new Error('Insufficient balance');
        
        await client.query('UPDATE users SET stars = stars - $1 WHERE telegram_id = $2', [nft.price, buyerId]);
        
        const commission = Math.floor(nft.price * 0.1);
        const sellerAmount = nft.price - commission;
        await client.query('UPDATE users SET stars = stars + $1 WHERE telegram_id = $2', [sellerAmount, nft.seller_id]);
        
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
    const query = `
        UPDATE nft_items 
        SET price = $1, for_sale = TRUE, seller_id = $2, owner_id = NULL
        WHERE id = $3 AND owner_id = $2
        RETURNING *
    `;
    const result = await pool.query(query, [price, sellerId, nftId]);
    return result.rows[0];
}

async function withdrawNFT(nftId, userId) {
    const query = `
        DELETE FROM nft_items 
        WHERE id = $1 AND owner_id = $2
        RETURNING *
    `;
    const result = await pool.query(query, [nftId, userId]);
    return result.rows[0];
}

async function getLeaders() {
    const query = `
        SELECT telegram_id, username, avatar, 
               total_bet as turnover,
               total_win,
               games_played,
               wins,
               stars
        FROM users
        ORDER BY total_bet DESC
        LIMIT 100
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function addWithdrawalRequest(telegramId, amount, address, currency) {
    const query = `
        INSERT INTO withdrawal_requests (telegram_id, amount, address, currency)
        VALUES ($1, $2, $3, $4)
        RETURNING *
    `;
    const result = await pool.query(query, [telegramId, amount, address, currency]);
    return result.rows[0];
}

// ===== ОБРАБОТЧИКИ WEBSOCKET =====

wss.on('connection', (ws, req) => {
    ws.id = Date.now();
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            
            switch (data.type) {
                case 'auth':
                    await handleAuth(ws, data);
                    break;
                case 'rocket_bet':
                    await handleRocketBet(ws, data);
                    break;
                case 'rocket_cashout':
                    await handleRocketCashout(ws, data);
                    break;
                case 'cancel_rocket_bet':
                    await handleCancelRocketBet(ws, data);
                    break;
                case 'roulette_bet':
                    await handleRouletteBet(ws, data);
                    break;
                case 'cancel_roulette_bet':
                    await handleCancelRouletteBet(ws, data);
                    break;
                case 'get_leaders':
                    await handleGetLeaders(ws);
                    break;
                case 'get_inventory':
                    await handleGetInventory(ws, data);
                    break;
                case 'buy_nft':
                    await handleBuyNFT(ws, data);
                    break;
                case 'sell_nft':
                    await handleSellNFT(ws, data);
                    break;
                case 'withdraw_nft':
                    await handleWithdrawNFT(ws, data);
                    break;
                case 'get_market':
                    await handleGetMarket(ws);
                    break;
                case 'withdraw_request':
                    await handleWithdrawRequest(ws, data);
                    break;
                case 'deposit_stars':
                    await handleDepositStars(ws, data);
                    break;
                case 'update_ton_address':
                    await handleUpdateTonAddress(ws, data);
                    break;
                default:
                    console.log('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: error.message
            }));
        }
    });

    ws.on('close', () => {
        clients.delete(ws.id);
    });
});

// ===== ОБРАБОТЧИКИ СОБЫТИЙ =====

async function handleAuth(ws, data) {
    try {
        const user = await createUser(data.telegram_id, data.username, data.avatar);
        ws.user = user;
        clients.set(ws.id, ws);
        
        ws.send(JSON.stringify({
            type: 'auth_success',
            user: {
                telegram_id: user.telegram_id,
                username: user.username,
                avatar: user.avatar,
                stars: user.stars,
                ton_address: user.ton_address,
                total_bet: user.total_bet,
                total_win: user.total_win,
                games_played: user.games_played,
                wins: user.wins
            }
        }));

        broadcastRocketState();
        broadcastRouletteState();
    } catch (error) {
        console.error('Auth error:', error);
        ws.send(JSON.stringify({
            type: 'auth_error',
            message: 'Ошибка авторизации'
        }));
    }
}

async function handleRocketBet(ws, data) {
    try {
        const user = await getUser(data.telegram_id);
        if (!user || user.banned) {
            ws.send(JSON.stringify({ type: 'error', message: 'Пользователь забанен или не найден' }));
            return;
        }

        if (rocketState.status !== 'countdown' && rocketState.status !== 'waiting') {
            ws.send(JSON.stringify({ type: 'error', message: 'Ставки уже приняты' }));
            return;
        }

        if (data.amount < 10) {
            ws.send(JSON.stringify({ type: 'error', message: 'Минимальная ставка 10⭐' }));
            return;
        }

        if (data.amount > user.stars) {
            ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно средств' }));
            return;
        }

        await updateStars(data.telegram_id, -data.amount);
        
        const bet = {
            telegram_id: data.telegram_id,
            name: data.name || user.username,
            avatar: data.avatar || user.avatar,
            amount: data.amount,
            autoCashout: data.autoCashout || false,
            autoCashoutValue: data.autoCashoutValue || 0,
            cashedOut: false,
            joinedAt: Date.now()
        };
        
        rocketState.bets.push(bet);
        
        const newBalance = await getUser(data.telegram_id);
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: newBalance.stars
        }));

        broadcastRocketState();
    } catch (error) {
        console.error('Rocket bet error:', error);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
}

async function handleRocketCashout(ws, data) {
    try {
        const user = await getUser(data.telegram_id);
        if (!user) return;

        const betIndex = rocketState.bets.findIndex(b => b.telegram_id === data.telegram_id && !b.cashedOut);
        if (betIndex === -1) {
            ws.send(JSON.stringify({ type: 'error', message: 'Ставка не найдена' }));
            return;
        }

        const bet = rocketState.bets[betIndex];
        const winAmount = Math.floor(bet.amount * rocketState.multiplier);
        
        await updateStars(data.telegram_id, winAmount);
        await updateStats(data.telegram_id, 'rocket', bet.amount, winAmount, rocketState.multiplier);
        
        bet.cashedOut = true;
        bet.winAmount = winAmount;
        bet.multiplier = rocketState.multiplier;

        const newBalance = await getUser(data.telegram_id);
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: newBalance.stars
        }));

        ws.send(JSON.stringify({
            type: 'rocket_cashout_success',
            multiplier: rocketState.multiplier,
            winAmount: winAmount
        }));

        broadcastRocketState();
    } catch (error) {
        console.error('Rocket cashout error:', error);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
}

async function handleCancelRocketBet(ws, data) {
    try {
        const betIndex = rocketState.bets.findIndex(b => b.telegram_id === data.telegram_id && !b.cashedOut);
        if (betIndex === -1) return;

        const bet = rocketState.bets[betIndex];
        await updateStars(data.telegram_id, bet.amount);
        
        rocketState.bets.splice(betIndex, 1);

        const newBalance = await getUser(data.telegram_id);
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: newBalance.stars
        }));

        broadcastRocketState();
    } catch (error) {
        console.error('Cancel rocket bet error:', error);
    }
}

async function handleRouletteBet(ws, data) {
    try {
        const user = await getUser(data.telegram_id);
        if (!user || user.banned) {
            ws.send(JSON.stringify({ type: 'error', message: 'Пользователь забанен или не найден' }));
            return;
        }

        if (rouletteState.status !== 'waiting') {
            ws.send(JSON.stringify({ type: 'error', message: 'Ставки уже приняты' }));
            return;
        }

        if (data.amount < 10) {
            ws.send(JSON.stringify({ type: 'error', message: 'Минимальная ставка 10⭐' }));
            return;
        }

        if (data.amount > user.stars) {
            ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно средств' }));
            return;
        }

        await updateStars(data.telegram_id, -data.amount);
        
        const bet = {
            telegram_id: data.telegram_id,
            name: data.name || user.username,
            avatar: data.avatar || user.avatar,
            amount: data.amount,
            color: data.color || 'red'
        };
        
        rouletteState.bets.push(bet);
        rouletteState.total += data.amount;

        const newBalance = await getUser(data.telegram_id);
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: newBalance.stars
        }));

        broadcastRouletteState();
    } catch (error) {
        console.error('Roulette bet error:', error);
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
}

async function handleCancelRouletteBet(ws, data) {
    try {
        const betIndex = rouletteState.bets.findIndex(b => b.telegram_id === data.telegram_id);
        if (betIndex === -1) return;

        const bet = rouletteState.bets[betIndex];
        await updateStars(data.telegram_id, bet.amount);
        rouletteState.total -= bet.amount;
        rouletteState.bets.splice(betIndex, 1);

        const newBalance = await getUser(data.telegram_id);
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: newBalance.stars
        }));

        broadcastRouletteState();
    } catch (error) {
        console.error('Cancel roulette bet error:', error);
    }
}

async function handleGetLeaders(ws) {
    try {
        const leaders = await getLeaders();
        ws.send(JSON.stringify({
            type: 'leaders_list',
            leaders: leaders
        }));
    } catch (error) {
        console.error('Get leaders error:', error);
    }
}

async function handleGetInventory(ws, data) {
    try {
        const nfts = await getUserNFTs(data.telegram_id);
        ws.send(JSON.stringify({
            type: 'inventory_list',
            nfts: nfts
        }));
    } catch (error) {
        console.error('Get inventory error:', error);
    }
}

async function handleBuyNFT(ws, data) {
    try {
        const nft = await buyNFT(data.nft_id, data.telegram_id);
        const user = await getUser(data.telegram_id);
        
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: user.stars
        }));
        
        ws.send(JSON.stringify({
            type: 'nft_bought',
            nft: nft
        }));
        
        showToast(`✅ Вы купили ${nft.name} за ${nft.price}⭐`, 'success');
        broadcastMarketUpdate();
    } catch (error) {
        console.error('Buy NFT error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: error.message
        }));
    }
}

async function handleSellNFT(ws, data) {
    try {
        const nft = await sellNFT(data.nft_id, data.seller_id, data.price);
        ws.send(JSON.stringify({
            type: 'nft_sold',
            nft: nft
        }));
        
        showToast(`✅ ${nft.name} выставлен на продажу за ${nft.price}⭐`, 'success');
        broadcastMarketUpdate();
    } catch (error) {
        console.error('Sell NFT error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: error.message
        }));
    }
}

async function handleWithdrawNFT(ws, data) {
    try {
        const user = await getUser(data.telegram_id);
        if (user.stars < 15) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Недостаточно звезд для вывода (нужно 15⭐)'
            }));
            return;
        }
        
        await updateStars(data.telegram_id, -15);
        const nft = await withdrawNFT(data.nft_id, data.telegram_id);
        
        if (!nft) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'NFT не найден'
            }));
            return;
        }
        
        const updatedUser = await getUser(data.telegram_id);
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: updatedUser.stars
        }));
        
        ws.send(JSON.stringify({
            type: 'nft_withdrawn',
            nft: nft
        }));
        
        showToast(`✅ ${nft.name} выведен в банк`, 'success');
    } catch (error) {
        console.error('Withdraw NFT error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: error.message
        }));
    }
}

async function handleGetMarket(ws) {
    try {
        const nfts = await getNFTsForSale();
        ws.send(JSON.stringify({
            type: 'market_list',
            nfts: nfts
        }));
    } catch (error) {
        console.error('Get market error:', error);
    }
}

async function handleWithdrawRequest(ws, data) {
    try {
        const user = await getUser(data.telegram_id);
        if (!user) {
            ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));
            return;
        }
        
        if (data.amount > user.stars) {
            ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно средств' }));
            return;
        }
        
        // Создаем заявку на вывод
        const request = await addWithdrawalRequest(
            data.telegram_id,
            data.amount,
            data.address,
            data.currency
        );
        
        // Блокируем сумму
        await updateStars(data.telegram_id, -data.amount);
        
        ws.send(JSON.stringify({
            type: 'withdrawal_created',
            request: request
        }));
        
        // Уведомляем админа в Telegram
        await notifyAdmin(`📤 Новая заявка на вывод!\n👤 ${user.username}\n💰 ${data.amount} ${data.currency}\n📭 ${data.address}`);
        
        const updatedUser = await getUser(data.telegram_id);
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: updatedUser.stars
        }));
        
        showToast('✅ Заявка на вывод отправлена', 'success');
    } catch (error) {
        console.error('Withdraw request error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: error.message
        }));
    }
}

async function handleDepositStars(ws, data) {
    try {
        const amount = data.amount;
        const user = await getUser(data.telegram_id);
        
        // Здесь должна быть проверка оплаты через TON
        // Пока просто начисляем для теста
        const newBalance = await updateStars(data.telegram_id, amount);
        
        ws.send(JSON.stringify({
            type: 'balance_update',
            stars: newBalance
        }));
        
        showToast(`✅ Пополнено на ${amount}⭐`, 'success');
    } catch (error) {
        console.error('Deposit stars error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: error.message
        }));
    }
}

async function handleUpdateTonAddress(ws, data) {
    try {
        const user = await updateTonAddress(data.telegram_id, data.address);
        ws.send(JSON.stringify({
            type: 'ton_address_updated',
            address: data.address
        }));
        
        showToast('✅ TON адрес обновлен', 'success');
    } catch (error) {
        console.error('Update TON address error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: error.message
        }));
    }
}

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

function broadcastRocketState() {
    const message = JSON.stringify({
        type: 'rocket_state',
        state: rocketState
    });
    
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

function broadcastRouletteState() {
    const message = JSON.stringify({
        type: 'roulette_state',
        state: rouletteState
    });
    
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

async function broadcastMarketUpdate() {
    const nfts = await getNFTsForSale();
    const message = JSON.stringify({
        type: 'market_list',
        nfts: nfts
    });
    
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

async function notifyAdmin(message) {
    try {
        const botToken = process.env.BOT_TOKEN;
        const adminId = process.env.ADMIN_ID;
        
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: adminId,
            text: message,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error('Notify admin error:', error);
    }
}

function showToast(message, type = 'info') {
    const toast = {
        type: 'toast',
        message: message,
        toastType: type
    };
    
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(toast));
        }
    });
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
    rocketState.crashPoint = 1.05 + Math.random() * 7; // 1.05 - 8.05
    
    broadcastRocketState();
    
    const interval = setInterval(() => {
        rocketState.multiplier += 0.01;
        
        // Проверка автовывода
        rocketState.bets.forEach(bet => {
            if (bet.autoCashout && !bet.cashedOut && rocketState.multiplier >= bet.autoCashoutValue) {
                // Автовывод
                const winAmount = Math.floor(bet.amount * rocketState.multiplier);
                updateStars(bet.telegram_id, winAmount);
                updateStats(bet.telegram_id, 'rocket', bet.amount, winAmount, rocketState.multiplier);
                bet.cashedOut = true;
                bet.winAmount = winAmount;
                bet.multiplier = rocketState.multiplier;
                
                // Уведомление игроку
                clients.forEach((client) => {
                    if (client.user && client.user.telegram_id === bet.telegram_id) {
                        client.send(JSON.stringify({
                            type: 'rocket_cashout_success',
                            multiplier: rocketState.multiplier,
                            winAmount: winAmount
                        }));
                    }
                });
            }
        });
        
        // Проверка краша
        if (rocketState.multiplier >= rocketState.crashPoint) {
            clearInterval(interval);
            rocketState.status = 'crashed';
            
            // Запись в историю
            rocketState.history.push(rocketState.crashPoint);
            if (rocketState.history.length > 50) {
                rocketState.history.shift();
            }
            
            broadcastRocketState();
            
            // Запуск нового цикла через 5 секунд
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
    
    // Выбор победителя (с учетом веса ставок)
    const totalWeight = rouletteState.bets.reduce((sum, bet) => sum + bet.amount, 0);
    let random = Math.random() * totalWeight;
    let winner = null;
    
    for (const bet of rouletteState.bets) {
        random -= bet.amount;
        if (random <= 0) {
            winner = bet;
            break;
        }
    }
    
    if (!winner) winner = rouletteState.bets[0];
    
    // Выбор цвета
    const colorIndex = Math.floor(Math.random() * rouletteColors.length);
    const resultColor = rouletteColors[colorIndex];
    
    // Проверка выигрыша
    let winAmount = 0;
    let multiplier = 0;
    
    if (winner.color === resultColor) {
        if (resultColor === 'red' || resultColor === 'blue') {
            multiplier = 2;
        } else {
            multiplier = 10;
        }
        winAmount = winner.amount * multiplier;
        
        // Начисление выигрыша
        updateStars(winner.telegram_id, winAmount);
        updateStats(winner.telegram_id, 'roulette', winner.amount, winAmount, multiplier);
    }
    
    // Комиссия
    const fee = Math.floor(rouletteState.total * 0.05);
    
    // Результат
    const result = {
        winner: winner,
        color: resultColor,
        multiplier: multiplier,
        winAmount: winAmount,
        fee: fee
    };
    
    // Рассылка результата
    clients.forEach((client) => {
        client.send(JSON.stringify({
            type: 'roulette_roll',
            result: result,
            bets: rouletteState.bets
        }));
    });
    
    // Обновление балансов
    clients.forEach((client) => {
        if (client.user) {
            getUser(client.user.telegram_id).then(user => {
                if (user) {
                    client.send(JSON.stringify({
                        type: 'balance_update',
                        stars: user.stars
                    }));
                }
            });
        }
    });
    
    // Запуск нового цикла
    setTimeout(() => {
        startRouletteCountdown();
    }, 5000);
}

// ===== ЗАПУСК =====

// Запуск ракеты
setTimeout(startRocketCountdown, 1000);

// Запуск рулетки
setTimeout(startRouletteCountdown, 2000);

// ===== HTTP СЕРВЕР =====

app.listen(port, () => {
    console.log(`✅ Server running on port ${port}`);
    console.log(`✅ WebSocket running on port 8080`);
});

console.log('🚀 DadTon server started!');