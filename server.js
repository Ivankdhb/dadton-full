const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

app.use(express.json());
app.use(express.static('public'));

// ==================== SUPABASE НАСТРОЙКИ ====================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

console.log('✅ Supabase подключён');

// ==================== КОНСТАНТЫ ====================
const MAX_BET = 5000;
const MIN_BET = 10;

// ==================== API ЭНДПОИНТЫ ====================

// Заявка на пополнение
app.post('/api/deposit-request', (req, res) => {
    const { telegram_id, name, amount, asset, stars } = req.body;
    console.log(`📩 ЗАЯВКА: ${name} (${telegram_id}) хочет пополнить ${amount} ${asset} -> ${stars}⭐`);
    res.json({ success: true });
});

// Заявка на вывод
app.post('/api/withdraw-request', async (req, res) => {
    const { telegram_id, stars_amount, asset, wallet_address } = req.body;
    
    const { data: user } = await supabase
        .from('users')
        .select('stars')
        .eq('telegram_id', telegram_id)
        .single();
    
    if (!user || user.stars < stars_amount) {
        return res.json({ success: false, error: 'Недостаточно звёзд' });
    }
    
    await supabase
        .from('users')
        .update({ stars: user.stars - stars_amount })
        .eq('telegram_id', telegram_id);
    
    await supabase
        .from('user_finance')
        .upsert({ 
            telegram_id: telegram_id, 
            withdrawn: stars_amount 
        }, { onConflict: 'telegram_id' });
    
    console.log(`📩 ЗАЯВКА НА ВЫВОД: ${telegram_id}, ${stars_amount}⭐ -> ${asset}`);
    res.json({ success: true });
});

// Финансовая статистика
app.post('/api/finance-stats', async (req, res) => {
    const { telegram_id } = req.body;
    
    const { data } = await supabase
        .from('user_finance')
        .select('deposited, withdrawn')
        .eq('telegram_id', telegram_id)
        .single();
    
    res.json({ deposited: data?.deposited || 0, withdrawn: data?.withdrawn || 0 });
});

// ==================== РАКЕТА ====================
let rocketState = {
    status: 'waiting',
    currentMultiplier: 1.00,
    crashPoint: 0,
    bets: [],
    countdown: 10
};

let rocketInterval = null;
let countdownInterval = null;
let minesState = new Map();
let rouletteBets = [];
let rouletteIsSpinning = false;

function generateCrashPoint() {
    let r = Math.random();
    if (r < 0.25) return 1.05 + Math.random() * 0.15;
    if (r < 0.50) return 1.20 + Math.random() * 0.30;
    if (r < 0.70) return 1.50 + Math.random() * 0.50;
    if (r < 0.85) return 2.00 + Math.random() * 1.00;
    if (r < 0.95) return 3.00 + Math.random() * 2.00;
    return 5.00 + Math.random() * 3.00;
}

function startRocketCountdown() {
    rocketState.status = 'waiting';
    rocketState.countdown = 10;
    rocketState.bets = [];
    
    io.emit('rocket_countdown', rocketState.countdown);
    io.emit('rocket_bets_clear');
    
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
        rocketState.countdown--;
        io.emit('rocket_countdown', rocketState.countdown);
        if (rocketState.countdown <= 0) {
            clearInterval(countdownInterval);
            startRocketFlying();
        }
    }, 1000);
}

function startRocketFlying() {
    let crash = generateCrashPoint();
    
    rocketState = {
        status: 'flying',
        currentMultiplier: 1.00,
        crashPoint: crash,
        bets: rocketState.bets,
        countdown: 0
    };
    
    console.log(`🚀 Ракета взлетела! Краш: ${crash.toFixed(2)}x`);
    io.emit('rocket_start', { crashPoint: crash });
    
    if (rocketInterval) clearInterval(rocketInterval);
    
    let lastTime = Date.now();
    
    rocketInterval = setInterval(() => {
        if (rocketState.status !== 'flying') {
            clearInterval(rocketInterval);
            return;
        }
        
        const now = Date.now();
        const delta = Math.min(100, now - lastTime);
        lastTime = now;
        
        let speed = rocketState.currentMultiplier < 1.5 ? 0.008 : 0.012 + (rocketState.currentMultiplier - 1.5) * 0.003;
        speed = Math.min(speed, 0.035);
        
        rocketState.currentMultiplier += speed * (delta / 100);
        
        for (let bet of rocketState.bets) {
            if (!bet.cashedAt && bet.autoCashout && rocketState.currentMultiplier >= (bet.autoCashout - 0.005)) {
                const winAmount = Math.floor(bet.amount * rocketState.currentMultiplier);
                bet.cashedAt = rocketState.currentMultiplier;
                bet.winAmount = winAmount;
                
                supabase
                    .from('users')
                    .update({ 
                        stars: supabase.raw(`stars + ${winAmount}`),
                        turnover: supabase.raw(`turnover + ${winAmount}`),
                        wins: supabase.raw(`wins + 1`)
                    })
                    .eq('telegram_id', bet.telegram_id);
                
                io.emit('rocket_cashout_done', { 
                    name: bet.name, 
                    multiplier: rocketState.currentMultiplier, 
                    win: winAmount, 
                    amount: bet.amount, 
                    avatar: bet.avatar 
                });
            }
        }
        
        if (rocketState.currentMultiplier >= rocketState.crashPoint) {
            clearInterval(rocketInterval);
            rocketState.status = 'crashed';
            
            console.log(`💥 КРАШ! ${rocketState.currentMultiplier.toFixed(2)}x`);
            io.emit('rocket_crash', rocketState.currentMultiplier);
            
            supabase
                .from('rocket_history')
                .insert([{ multiplier: rocketState.currentMultiplier }]);
            
            setTimeout(startRocketCountdown, 1500);
        } else {
            io.emit('rocket_multiplier', rocketState.currentMultiplier);
        }
    }, 50);
}

function calculateRouletteWinner() {
    let total = rouletteBets.reduce((s, b) => s + b.amount, 0);
    if (total === 0) return null;
    let rand = Math.random() * total;
    let accum = 0;
    for (let bet of rouletteBets) {
        accum += bet.amount;
        if (rand <= accum) return bet;
    }
    return null;
}

// ==================== СОКЕТЫ ====================
io.on('connection', (socket) => {
    console.log('👤 Игрок подключился');
    
    socket.on('register', async (data, callback) => {
        const telegram_id = data.telegram_id;
        const name = data.name || 'Игрок';
        const avatar = data.avatar || '👤';
        const referrerId = data.referrer_id || null;
        
        const { data: user } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', telegram_id)
            .single();
        
        if (!user) {
            await supabase
                .from('users')
                .insert([{ telegram_id, name, avatar, referrer_id: referrerId }]);
            
            await supabase
                .from('user_finance')
                .insert([{ telegram_id, deposited: 0, withdrawn: 0 }]);
            
            if (referrerId) {
                await supabase
                    .from('users')
                    .update({ stars: supabase.raw('stars + 100') })
                    .eq('telegram_id', referrerId);
            }
            
            const { data: finance } = await supabase
                .from('user_finance')
                .select('deposited, withdrawn')
                .eq('telegram_id', telegram_id)
                .single();
            
            if (callback) callback({ 
                success: true, 
                stars: 1000, 
                name, 
                telegram_id, 
                avatar, 
                turnover: 0, 
                games_played: 0, 
                wins: 0,
                total_deposited: finance?.deposited || 0,
                total_withdrawn: finance?.withdrawn || 0
            });
        } else {
            const { data: finance } = await supabase
                .from('user_finance')
                .select('deposited, withdrawn')
                .eq('telegram_id', telegram_id)
                .single();
            
            if (callback) callback({ 
                success: true, 
                stars: user.stars, 
                name: user.name, 
                telegram_id, 
                avatar: user.avatar || '👤', 
                turnover: user.turnover || 0, 
                games_played: user.games_played || 0, 
                wins: user.wins || 0,
                total_deposited: finance?.deposited || 0,
                total_withdrawn: finance?.withdrawn || 0
            });
        }
    });
    
    socket.on('get_balance', async (telegram_id, callback) => {
        const { data: user } = await supabase
            .from('users')
            .select('stars, name, avatar, turnover, games_played, wins')
            .eq('telegram_id', telegram_id)
            .single();
        
        if (user) {
            const { data: finance } = await supabase
                .from('user_finance')
                .select('deposited, withdrawn')
                .eq('telegram_id', telegram_id)
                .single();
            
            if (callback) callback({ 
                stars: user.stars, 
                name: user.name, 
                avatar: user.avatar || '👤', 
                turnover: user.turnover || 0, 
                games_played: user.games_played || 0, 
                wins: user.wins || 0,
                total_deposited: finance?.deposited || 0,
                total_withdrawn: finance?.withdrawn || 0
            });
        } else {
            if (callback) callback({ stars: 1000 });
        }
    });
    
    socket.on('get_referral_stats', async (telegram_id, callback) => {
        const { data, count } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: false })
            .eq('referrer_id', telegram_id);
        
        const totalTurnover = data?.reduce((sum, u) => sum + (u.turnover || 0), 0) || 0;
        
        if (callback) callback({ 
            count: count || 0, 
            earned: Math.floor(totalTurnover * 0.1) 
        });
    });
    
    socket.on('get_finance_stats', async (telegram_id, callback) => {
        const { data } = await supabase
            .from('user_finance')
            .select('deposited, withdrawn')
            .eq('telegram_id', telegram_id)
            .single();
        
        if (callback) callback({ deposited: data?.deposited || 0, withdrawn: data?.withdrawn || 0 });
    });
    
    // РАКЕТА
    socket.on('rocket_place_bet', async (data, callback) => {
        if (!data || rocketState.status !== 'waiting') {
            if (callback) callback({ success: false, error: 'Ставки только до взлёта!' });
            return;
        }
        
        const { telegram_id, name, amount, autoCashout, avatar } = data;
        
        if (amount < MIN_BET || amount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        const { data: user } = await supabase
            .from('users')
            .select('stars')
            .eq('telegram_id', telegram_id)
            .single();
        
        if (!user || user.stars < amount) {
            if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
            return;
        }
        
        await supabase
            .from('users')
            .update({ 
                stars: user.stars - amount,
                games_played: supabase.raw('games_played + 1')
            })
            .eq('telegram_id', telegram_id);
        
        rocketState.bets.push({
            telegram_id, name, amount, autoCashout: parseFloat(autoCashout) || 0,
            cashedAt: null, winAmount: null, avatar: avatar || '👤'
        });
        
        io.emit('rocket_bet_placed', { name, amount, autoCashout, avatar: avatar || '👤' });
        if (callback) callback({ success: true });
    });
    
    socket.on('rocket_cancel_bet', async (data, callback) => {
        const { telegram_id } = data;
        const betIndex = rocketState.bets.findIndex(b => b.telegram_id === telegram_id && !b.cashedAt);
        
        if (betIndex === -1) {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
            return;
        }
        
        const bet = rocketState.bets[betIndex];
        
        await supabase
            .from('users')
            .update({ stars: supabase.raw(`stars + ${bet.amount}`) })
            .eq('telegram_id', telegram_id);
        
        rocketState.bets.splice(betIndex, 1);
        io.emit('rocket_bet_cancelled', { telegram_id, name: bet.name });
        if (callback) callback({ success: true, amount: bet.amount });
    });
    
    socket.on('rocket_cashout', async (data, callback) => {
        if (rocketState.status !== 'flying') {
            if (callback) callback({ success: false, error: 'Сейчас нельзя забрать' });
            return;
        }
        
        const { telegram_id, name } = data;
        const bet = rocketState.bets.find(b => b.telegram_id === telegram_id && !b.cashedAt);
        
        if (!bet) {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
            return;
        }
        
        const winAmount = Math.floor(bet.amount * rocketState.currentMultiplier);
        bet.cashedAt = rocketState.currentMultiplier;
        bet.winAmount = winAmount;
        
        await supabase
            .from('users')
            .update({ 
                stars: supabase.raw(`stars + ${winAmount}`),
                turnover: supabase.raw(`turnover + ${winAmount}`),
                wins: supabase.raw('wins + 1')
            })
            .eq('telegram_id', telegram_id);
        
        io.emit('rocket_cashout_done', { name, multiplier: rocketState.currentMultiplier, win: winAmount, amount: bet.amount, avatar: bet.avatar });
        if (callback) callback({ success: true, win: winAmount });
    });
    
    socket.on('rocket_get_history', async () => {
        const { data } = await supabase
            .from('rocket_history')
            .select('multiplier')
            .order('timestamp', { ascending: false })
            .limit(10);
        
        socket.emit('rocket_history_data', data || []);
    });
    
    // МИНЫ
    socket.on('mines_start', async (data, callback) => {
        const { telegram_id, betAmount, minesCount } = data;
        
        if (betAmount < MIN_BET || betAmount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        if (minesCount < 1 || minesCount > 24) {
            if (callback) callback({ success: false, error: 'Мин от 1 до 24' });
            return;
        }
        
        const { data: user } = await supabase
            .from('users')
            .select('stars')
            .eq('telegram_id', telegram_id)
            .single();
        
        if (!user || user.stars < betAmount) {
            if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
            return;
        }
        
        await supabase
            .from('users')
            .update({ 
                stars: user.stars - betAmount,
                games_played: supabase.raw('games_played + 1')
            })
            .eq('telegram_id', telegram_id);
        
        const totalCells = 25;
        const mineIndices = [];
        while (mineIndices.length < minesCount) {
            const idx = Math.floor(Math.random() * totalCells);
            if (!mineIndices.includes(idx)) mineIndices.push(idx);
        }
        
        minesState.set(telegram_id, {
            grid: mineIndices,
            bet: betAmount,
            minesCount: minesCount,
            revealed: 0,
            active: true
        });
        
        if (callback) callback({ success: true, minesCount: minesCount });
    });
    
    socket.on('mines_reveal', async (data, callback) => {
        const { telegram_id, cellIndex } = data;
        const game = minesState.get(telegram_id);
        
        if (!game || !game.active) {
            if (callback) callback({ success: false, error: 'Игра не активна' });
            return;
        }
        
        if (game.grid.includes(cellIndex)) {
            game.active = false;
            minesState.delete(telegram_id);
            await supabase
                .from('users')
                .update({ games_played: supabase.raw('games_played - 1') })
                .eq('telegram_id', telegram_id);
            if (callback) callback({ success: false, exploded: true });
            return;
        }
        
        game.revealed++;
        
        const totalCells = 25;
        const safeCells = totalCells - game.minesCount;
        const multiplier = (safeCells - game.revealed + game.minesCount) / (safeCells - game.revealed);
        const finalMultiplier = Math.min(multiplier, 3.5);
        const winAmount = Math.floor(game.bet * finalMultiplier);
        
        if (callback) callback({ success: true, revealed: game.revealed, multiplier: finalMultiplier.toFixed(2), winAmount });
        
        if (game.revealed === safeCells) {
            await supabase
                .from('users')
                .update({ 
                    stars: supabase.raw(`stars + ${winAmount}`),
                    turnover: supabase.raw(`turnover + ${winAmount}`),
                    wins: supabase.raw('wins + 1')
                })
                .eq('telegram_id', telegram_id);
            
            game.active = false;
            minesState.delete(telegram_id);
            if (callback) callback({ success: true, finished: true, winAmount });
        }
    });
    
    socket.on('mines_cashout', async (data, callback) => {
        const { telegram_id } = data;
        const game = minesState.get(telegram_id);
        
        if (!game || !game.active) {
            if (callback) callback({ success: false, error: 'Игра не активна' });
            return;
        }
        
        const totalCells = 25;
        const safeCells = totalCells - game.minesCount;
        const multiplier = (safeCells - game.revealed + game.minesCount) / (safeCells - game.revealed);
        const finalMultiplier = Math.min(multiplier, 3.5);
        const winAmount = Math.floor(game.bet * finalMultiplier);
        
        await supabase
            .from('users')
            .update({ 
                stars: supabase.raw(`stars + ${winAmount}`),
                turnover: supabase.raw(`turnover + ${winAmount}`),
                wins: supabase.raw('wins + 1')
            })
            .eq('telegram_id', telegram_id);
        
        game.active = false;
        minesState.delete(telegram_id);
        
        if (callback) callback({ success: true, winAmount });
    });
    
    // РУЛЕТКА
    socket.on('roulette_place_bet', async (data, callback) => {
        if (rouletteIsSpinning) {
            if (callback) callback({ success: false, error: 'Рулетка крутится!' });
            return;
        }
        
        const { telegram_id, name, amount, avatar } = data;
        
        if (amount < MIN_BET || amount > MAX_BET) {
            if (callback) callback({ success: false, error: `Ставка от ${MIN_BET} до ${MAX_BET}` });
            return;
        }
        
        if (rouletteBets.length >= 20) {
            if (callback) callback({ success: false, error: 'Достигнут лимит игроков' });
            return;
        }
        
        const { data: user } = await supabase
            .from('users')
            .select('stars')
            .eq('telegram_id', telegram_id)
            .single();
        
        if (!user || user.stars < amount) {
            if (callback) callback({ success: false, error: `Недостаточно звёзд!` });
            return;
        }
        
        await supabase
            .from('users')
            .update({ 
                stars: user.stars - amount,
                games_played: supabase.raw('games_played + 1')
            })
            .eq('telegram_id', telegram_id);
        
        rouletteBets.push({ telegram_id, name, amount, avatar: avatar || '👤' });
        io.emit('roulette_update', [...rouletteBets]);
        if (callback) callback({ success: true });
    });
    
    socket.on('roulette_cancel_bet', async (data, callback) => {
        const { telegram_id } = data;
        const betIndex = rouletteBets.findIndex(b => b.telegram_id === telegram_id);
        
        if (betIndex !== -1) {
            const bet = rouletteBets[betIndex];
            await supabase
                .from('users')
                .update({ stars: supabase.raw(`stars + ${bet.amount}`) })
                .eq('telegram_id', telegram_id);
            rouletteBets.splice(betIndex, 1);
            io.emit('roulette_update', [...rouletteBets]);
            if (callback) callback({ success: true, amount: bet.amount });
        } else {
            if (callback) callback({ success: false, error: 'Ставка не найдена' });
        }
    });
    
    socket.on('roulette_spin', (callback) => {
        if (rouletteIsSpinning || rouletteBets.length < 2) {
            if (callback) callback({ success: false, error: 'Нужно минимум 2 участника!' });
            return;
        }
        
        rouletteIsSpinning = true;
        io.emit('roulette_spinning');
        
        setTimeout(async () => {
            const winner = calculateRouletteWinner();
            const total = rouletteBets.reduce((s, b) => s + b.amount, 0);
            
            if (winner) {
                await supabase
                    .from('users')
                    .update({ 
                        stars: supabase.raw(`stars + ${total}`),
                        turnover: supabase.raw(`turnover + ${total}`),
                        wins: supabase.raw('wins + 1')
                    })
                    .eq('telegram_id', winner.telegram_id);
                io.emit('roulette_result', { winner, total });
            } else {
                io.emit('roulette_result', { winner: null, total });
            }
            
            rouletteBets = [];
            rouletteIsSpinning = false;
            io.emit('roulette_update', []);
            if (callback) callback({ success: true });
        }, 3000);
    });
    
    socket.on('roulette_get_bets', (callback) => {
        if (callback) callback([...rouletteBets]);
    });
    
    socket.on('get_leaderboard', async () => {
        const { data } = await supabase
            .from('users')
            .select('name, avatar, turnover')
            .order('turnover', { ascending: false })
            .limit(50);
        
        io.emit('leaderboard_data', data || []);
    });
});

startRocketCountdown();

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📦 Supabase подключён: ${SUPABASE_URL}`);
});