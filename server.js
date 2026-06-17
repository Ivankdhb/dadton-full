require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── КОНФИГ ──────────────────────────────────────────────────────────────────
const CONFIG = {
  BOT_TOKEN: '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0',
  ADMIN_ID: '1631627984',
  BANK_ACCOUNT_ID: '7339408064',
  APP_URL: 'https://dadton-full.onrender.com'
};

// ── БД ──────────────────────────────────────────────────────────────────────
const pool = new Pool({ 
  connectionString: 'postgresql://dadton_db_user:i3gLm3A1tac4iXu7mUKwJMKKBIQRrDn2@dpg-d8ka6f57vvec73ere1p0-a/dadton_db'
});

async function initDB() {
  // Создаем таблицы
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      avatar TEXT,
      stars BIGINT DEFAULT 0,
      total_wagered BIGINT DEFAULT 0,
      total_deposited BIGINT DEFAULT 0,
      total_withdrawn BIGINT DEFAULT 0,
      games_played INT DEFAULT 0,
      games_won INT DEFAULT 0,
      referral_code TEXT UNIQUE,
      referred_by BIGINT,
      referral_earnings BIGINT DEFAULT 0,
      is_banned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Добавляем колонки, если их нет
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_address TEXT`);
    console.log('✅ Колонка wallet_address добавлена');
  } catch(e) {
    console.log('Колонка wallet_address уже существует или ошибка:', e.message);
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS nft_items (
        id SERIAL PRIMARY KEY,
        owner_id BIGINT REFERENCES users(telegram_id),
        name TEXT NOT NULL,
        image_url TEXT NOT NULL,
        gift_id TEXT,
        on_market BOOLEAN DEFAULT FALSE,
        market_price BIGINT DEFAULT 0,
        acquired_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(telegram_id),
        type TEXT,
        amount BIGINT,
        comment TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(telegram_id),
        amount BIGINT,
        currency TEXT,
        address TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS crash_history (
        id SERIAL PRIMARY KEY,
        multiplier FLOAT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS deposit_invoices (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(telegram_id),
        amount_gram FLOAT,
        amount_stars BIGINT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ Все таблицы созданы');
  } catch(e) {
    console.error('Ошибка создания таблиц:', e.message);
  }
  
  console.log('✅ БД инициализирована');
}

// ── ВСПОМОГАТЕЛЬНЫЕ ─────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function broadcastTo(telegram_id, data) {
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN && c.telegram_id == telegram_id)
      c.send(JSON.stringify(data));
  });
}

async function getUser(telegram_id) {
  const r = await pool.query('SELECT * FROM users WHERE telegram_id=$1', [telegram_id]);
  return r.rows[0];
}

async function addStars(telegram_id, amount, comment = '') {
  await pool.query('UPDATE users SET stars=stars+$1 WHERE telegram_id=$2', [amount, telegram_id]);
  await pool.query('INSERT INTO transactions(user_id,type,amount,comment) VALUES($1,$2,$3,$4)',
    [telegram_id, 'credit', amount, comment]);
}

async function deductStars(telegram_id, amount, comment = '') {
  await pool.query('UPDATE users SET stars=stars-$1 WHERE telegram_id=$2', [amount, telegram_id]);
  await pool.query('INSERT INTO transactions(user_id,type,amount,comment) VALUES($1,$2,$3,$4)',
    [telegram_id, 'debit', amount, comment]);
}

function generateRef() {
  return 'ref_' + Math.random().toString(36).slice(2, 10);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── TONCONNECT MANIFEST ─────────────────────────────────────────────────────
app.get('/tonconnect-manifest.json', (req, res) => {
  res.json({
    url: CONFIG.APP_URL,
    name: 'DadTon',
    iconUrl: `${CONFIG.APP_URL}/icon.png`,
    termsOfUseUrl: `${CONFIG.APP_URL}/terms`,
    privacyPolicyUrl: `${CONFIG.APP_URL}/privacy`
  });
});

// ── API: АВТОРИЗАЦИЯ ──────────────────────────────────────────────────────────
app.post('/api/auth', async (req, res) => {
  try {
    const { telegram_id, username, first_name, avatar, ref, wallet_address } = req.body;
    if (!telegram_id) return res.status(400).json({ error: 'Нет telegram_id' });

    let user = await getUser(telegram_id);
    if (!user) {
      const refCode = generateRef();
      let referredBy = null;
      if (ref) {
        const refUser = await pool.query('SELECT telegram_id FROM users WHERE referral_code=$1', [ref]);
        if (refUser.rows[0]) referredBy = refUser.rows[0].telegram_id;
      }
      await pool.query(
        `INSERT INTO users(telegram_id,username,first_name,avatar,referral_code,referred_by,wallet_address)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [telegram_id, username, first_name, avatar, refCode, referredBy, wallet_address]
      );
      if (referredBy) {
        await pool.query('UPDATE users SET stars=stars+50, referral_earnings=referral_earnings+50 WHERE telegram_id=$1', [referredBy]);
      }
      user = await getUser(telegram_id);
    } else {
      if (username || first_name || avatar || wallet_address) {
        await pool.query(
          `UPDATE users SET username=COALESCE($1,username), first_name=COALESCE($2,first_name), avatar=COALESCE($3,avatar), wallet_address=COALESCE($4,wallet_address) WHERE telegram_id=$5`,
          [username, first_name, avatar, wallet_address, telegram_id]
        );
      }
      user = await getUser(telegram_id);
    }
    res.json({ success: true, user });
  } catch (e) {
    console.error('auth error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── API: ОБНОВЛЕНИЕ КОШЕЛЬКА ───────────────────────────────────────────────
app.post('/api/update-wallet', async (req, res) => {
  try {
    const { telegram_id, wallet_address } = req.body;
    if (!telegram_id || !wallet_address) return res.status(400).json({ error: 'Нет данных' });
    await pool.query('UPDATE users SET wallet_address=$1 WHERE telegram_id=$2', [wallet_address, telegram_id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: БАЛАНС ──────────────────────────────────────────────────────────────
app.get('/api/balance/:telegram_id', async (req, res) => {
  const user = await getUser(req.params.telegram_id);
  if (!user) return res.status(404).json({ error: 'Не найден' });
  res.json({ stars: user.stars });
});

// ── API: ПРОФИЛЬ ─────────────────────────────────────────────────────────────
app.get('/api/profile/:telegram_id', async (req, res) => {
  try {
    const user = await getUser(req.params.telegram_id);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    const txs = await pool.query(
      'SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.params.telegram_id]
    );
    const refs = await pool.query('SELECT COUNT(*) FROM users WHERE referred_by=$1', [req.params.telegram_id]);
    res.json({
      user,
      transactions: txs.rows,
      referral_count: parseInt(refs.rows[0].count)
    });
  } catch (e) {
    console.error('Profile error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── API: ЛИДЕРБОРД ───────────────────────────────────────────────────────────
app.get('/api/leaderboard', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT telegram_id, username, first_name, avatar, total_wagered FROM users ORDER BY total_wagered DESC LIMIT 50'
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ИСТОРИЯ КРАШЕЙ ──────────────────────────────────────────────────────
app.get('/api/crash-history', async (req, res) => {
  const r = await pool.query('SELECT multiplier FROM crash_history ORDER BY id DESC LIMIT 10');
  res.json(r.rows.map(x => x.multiplier));
});

// ── API: МИНЫ (С ПОДКРУТКОЙ) ──────────────────────────────────────────────
const minesSessions = {};

app.post('/api/mines/start', async (req, res) => {
  try {
    const { telegram_id, bet, mines_count } = req.body;
    const user = await getUser(telegram_id);
    if (!user || user.is_banned) return res.status(403).json({ error: 'Запрещено' });
    if (user.stars < bet) return res.status(400).json({ error: 'Недостаточно звёзд' });
    if (bet < 10) return res.status(400).json({ error: 'Минимальная ставка 10⭐' });
    if (![5,10,15,20,24].includes(mines_count)) return res.status(400).json({ error: 'Некорректное кол-во мин' });

    await deductStars(telegram_id, bet, 'Ставка в мины');
    await pool.query('UPDATE users SET games_played=games_played+1 WHERE telegram_id=$1', [telegram_id]);

    // ПОДКРУТКА: делаем мины более "агрессивными"
    const cells = Array.from({ length: 25 }, (_, i) => i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    const minePositions = new Set(cells.slice(0, mines_count));
    
    // Добавляем дополнительную мину если игрок часто выигрывает
    if (user.games_won > user.games_played * 0.3 && mines_count < 24) {
      const extraMine = cells[mines_count];
      if (extraMine !== undefined) minePositions.add(extraMine);
    }

    minesSessions[telegram_id] = {
      bet,
      mines_count: Math.min(minePositions.size, 24),
      minePositions: [...minePositions],
      revealed: [],
      active: true
    };

    broadcastTo(telegram_id, { type: 'balance_update', stars: user.stars - bet });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getMinesMultiplier(safe_opened, mines_count) {
  const total = 25;
  const safe_total = total - mines_count;
  if (safe_total <= 0) return 1;
  let mult = 1;
  for (let i = 0; i < safe_opened; i++) {
    mult *= (safe_total - i) / (total - i);
  }
  // Уменьшаем множитель на 5% для баланса
  return Math.max(1.04, parseFloat((1 / mult * 0.92).toFixed(2)));
}

app.post('/api/mines/open', async (req, res) => {
  try {
    const { telegram_id, cell } = req.body;
    const session = minesSessions[telegram_id];
    if (!session || !session.active) return res.status(400).json({ error: 'Нет активной игры' });
    if (session.revealed.includes(cell)) return res.status(400).json({ error: 'Уже открыта' });

    const isMine = session.minePositions.includes(cell);
    session.revealed.push(cell);

    if (isMine) {
      session.active = false;
      delete minesSessions[telegram_id];
      return res.json({ mine: true, minePositions: session.minePositions });
    }

    const multiplier = getMinesMultiplier(session.revealed.length, session.mines_count);
    res.json({ mine: false, multiplier, revealed: session.revealed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mines/cashout', async (req, res) => {
  try {
    const { telegram_id } = req.body;
    const session = minesSessions[telegram_id];
    if (!session || !session.active) return res.status(400).json({ error: 'Нет активной игры' });
    if (session.revealed.length === 0) return res.status(400).json({ error: 'Нужно открыть хотя бы одну клетку' });

    const multiplier = getMinesMultiplier(session.revealed.length, session.mines_count);
    const win = Math.floor(session.bet * multiplier);
    session.active = false;
    delete minesSessions[telegram_id];

    await addStars(telegram_id, win, `Выигрыш в минах x${multiplier}`);
    await pool.query('UPDATE users SET games_won=games_won+1, total_wagered=total_wagered+$1 WHERE telegram_id=$2',
      [session.bet, telegram_id]);

    const user = await getUser(telegram_id);
    broadcastTo(telegram_id, { type: 'balance_update', stars: user.stars });
    res.json({ success: true, win, multiplier });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ПОКЕР ───────────────────────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankValue(r) { return RANKS.indexOf(r); }

function evaluateHand(cards) {
  const rv = cards.map(c => rankValue(c.r)).sort((a,b)=>b-a);
  const suits = cards.map(c => c.s);
  const flush = suits.every(s => s === suits[0]);
  const unique = [...new Set(rv)];
  const counts = unique.map(v => rv.filter(x=>x===v).length).sort((a,b)=>b-a);
  const straight = unique.length === 5 && (rv[0]-rv[4] === 4 || (rv[0]===12&&rv[1]===3));

  if (flush && straight) return { rank: 8, name: 'Стрит-флеш' };
  if (counts[0]===4) return { rank: 7, name: 'Каре' };
  if (counts[0]===3&&counts[1]===2) return { rank: 6, name: 'Фулл-хаус' };
  if (flush) return { rank: 5, name: 'Флеш' };
  if (straight) return { rank: 4, name: 'Стрит' };
  if (counts[0]===3) return { rank: 3, name: 'Тройка' };
  if (counts[0]===2&&counts[1]===2) return { rank: 2, name: 'Две пары' };
  if (counts[0]===2) return { rank: 1, name: 'Пара' };
  return { rank: 0, name: 'Старшая карта' };
}

const pokerSessions = {};

app.post('/api/poker/start', async (req, res) => {
  try {
    const { telegram_id, bet } = req.body;
    const user = await getUser(telegram_id);
    if (!user || user.is_banned) return res.status(403).json({ error: 'Запрещено' });
    if (user.stars < bet) return res.status(400).json({ error: 'Недостаточно звёзд' });
    if (bet < 10) return res.status(400).json({ error: 'Минимум 10⭐' });

    await deductStars(telegram_id, bet, 'Ставка в покере');
    await pool.query('UPDATE users SET games_played=games_played+1 WHERE telegram_id=$1', [telegram_id]);

    const deck = makeDeck();
    const playerCards = [deck.pop(), deck.pop()];
    const dealerCards = [deck.pop(), deck.pop()];
    const community = [deck.pop(), deck.pop(), deck.pop(), deck.pop(), deck.pop()];

    pokerSessions[telegram_id] = { bet, deck, playerCards, dealerCards, community, active: true };

    const user2 = await getUser(telegram_id);
    broadcastTo(telegram_id, { type: 'balance_update', stars: user2.stars });
    
    // Возвращаем карты: игроку видны его, дилеру скрыты, стол виден
    res.json({ 
      success: true, 
      playerCards, 
      dealerCards: dealerCards.map(() => ({ hidden: true })), // Скрываем карты дилера
      community 
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/poker/fold', async (req, res) => {
  try {
    const { telegram_id } = req.body;
    const session = pokerSessions[telegram_id];
    if (!session || !session.active) return res.status(400).json({ error: 'Нет игры' });
    session.active = false;
    delete pokerSessions[telegram_id];
    res.json({ result: 'fold', message: 'Ты сбросил карты' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/poker/call', async (req, res) => {
  try {
    const { telegram_id } = req.body;
    const session = pokerSessions[telegram_id];
    if (!session || !session.active) return res.status(400).json({ error: 'Нет игры' });

    const { playerCards, dealerCards, community, bet } = session;
    const playerBest = evaluateHand([...playerCards, ...community].slice(0,5));
    const dealerBest = evaluateHand([...dealerCards, ...community].slice(0,5));

    session.active = false;
    delete pokerSessions[telegram_id];

    let result, win = 0;
    if (playerBest.rank > dealerBest.rank) {
      win = bet * 2;
      await addStars(telegram_id, win, `Выигрыш в покере x2`);
      await pool.query('UPDATE users SET games_won=games_won+1, total_wagered=total_wagered+$1 WHERE telegram_id=$2', [bet, telegram_id]);
      result = 'win';
    } else if (playerBest.rank === dealerBest.rank) {
      win = bet;
      await addStars(telegram_id, win, 'Ничья в покере - возврат');
      result = 'draw';
    } else {
      await pool.query('UPDATE users SET total_wagered=total_wagered+$1 WHERE telegram_id=$2', [bet, telegram_id]);
      result = 'lose';
    }

    const user = await getUser(telegram_id);
    broadcastTo(telegram_id, { type: 'balance_update', stars: user.stars });
    res.json({
      result, win,
      playerCards, dealerCards, community,
      playerHand: playerBest.name, dealerHand: dealerBest.name
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: МАРКЕТ ──────────────────────────────────────────────────────────────
app.get('/api/market', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT n.*, u.username, u.first_name, u.avatar
      FROM nft_items n JOIN users u ON n.owner_id=u.telegram_id
      WHERE n.on_market=TRUE ORDER BY n.id DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/market/sell', async (req, res) => {
  try {
    const { telegram_id, nft_id, price } = req.body;
    if (price < 10) return res.status(400).json({ error: 'Минимальная цена 10⭐' });
    const nft = await pool.query('SELECT * FROM nft_items WHERE id=$1 AND owner_id=$2', [nft_id, telegram_id]);
    if (!nft.rows[0]) return res.status(403).json({ error: 'Не ваш NFT' });
    await pool.query('UPDATE nft_items SET on_market=TRUE, market_price=$1 WHERE id=$2', [price, nft_id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/market/buy', async (req, res) => {
  try {
    const { telegram_id, nft_id } = req.body;
    const nft = await pool.query('SELECT * FROM nft_items WHERE id=$1 AND on_market=TRUE', [nft_id]);
    if (!nft.rows[0]) return res.status(404).json({ error: 'NFT не найден' });
    const item = nft.rows[0];
    if (item.owner_id == telegram_id) return res.status(400).json({ error: 'Нельзя купить у себя' });

    const buyer = await getUser(telegram_id);
    if (buyer.stars < item.market_price) return res.status(400).json({ error: 'Недостаточно звёзд' });

    const commission = Math.floor(item.market_price * 0.10);
    const sellerGet = item.market_price - commission;

    await deductStars(telegram_id, item.market_price, `Покупка NFT: ${item.name}`);
    await addStars(item.owner_id, sellerGet, `Продажа NFT: ${item.name}`);
    await pool.query('UPDATE nft_items SET owner_id=$1, on_market=FALSE, market_price=0 WHERE id=$2', [telegram_id, nft_id]);

    const buyer2 = await getUser(telegram_id);
    broadcastTo(telegram_id, { type: 'balance_update', stars: buyer2.stars });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ИНВЕНТАРЬ ───────────────────────────────────────────────────────────
app.get('/api/inventory/:telegram_id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM nft_items WHERE owner_id=$1 ORDER BY id DESC', [req.params.telegram_id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/nft/receive', async (req, res) => {
  try {
    const { telegram_id, gift_id, name, image_url } = req.body;
    const user = await getUser(telegram_id);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    await pool.query(
      'INSERT INTO nft_items(owner_id, name, image_url, gift_id) VALUES($1, $2, $3, $4)',
      [telegram_id, name, image_url, gift_id]
    );
    
    broadcastTo(telegram_id, { type: 'nft_received', name, image_url });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/inventory/withdraw', async (req, res) => {
  try {
    const { telegram_id, nft_id } = req.body;
    const user = await getUser(telegram_id);
    if (user.stars < 15) return res.status(400).json({ error: 'Нужно 15⭐ для вывода' });
    const nft = await pool.query('SELECT * FROM nft_items WHERE id=$1 AND owner_id=$2', [nft_id, telegram_id]);
    if (!nft.rows[0]) return res.status(403).json({ error: 'Не ваш NFT' });

    await deductStars(telegram_id, 15, 'Комиссия за вывод NFT');
    await pool.query('DELETE FROM nft_items WHERE id=$1', [nft_id]);

    await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.BANK_ACCOUNT_ID,
      text: `📤 Запрос на вывод NFT\nПользователь: @${user.username} (${telegram_id})\nNFT: ${nft.rows[0].name}\nGift ID: ${nft.rows[0].gift_id || 'N/A'}`
    }).catch(() => {});

    const user2 = await getUser(telegram_id);
    broadcastTo(telegram_id, { type: 'balance_update', stars: user2.stars });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ВЫВОД СРЕДСТВ ───────────────────────────────────────────────────────
app.post('/api/withdraw', async (req, res) => {
  try {
    const { telegram_id, amount, currency, address } = req.body;
    const user = await getUser(telegram_id);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    if (user.stars < amount) return res.status(400).json({ error: 'Недостаточно звёзд' });
    if (amount < 100) return res.status(400).json({ error: 'Минимум 100⭐' });

    await deductStars(telegram_id, amount, `Запрос вывода: ${currency}`);
    await pool.query(
      'INSERT INTO withdrawals(user_id,amount,currency,address) VALUES($1,$2,$3,$4)',
      [telegram_id, amount, currency, address]
    );

    await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.ADMIN_ID,
      text: `💸 Запрос на вывод\n👤 @${user.username} (${telegram_id})\n💰 ${amount}⭐ → ${currency}\n📍 ${address}`
    }).catch(() => {});

    const user2 = await getUser(telegram_id);
    broadcastTo(telegram_id, { type: 'balance_update', stars: user2.stars });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: СОЗДАНИЕ ИНВОЙСА ДЛЯ ОПЛАТЫ ─────────────────────────────────────
app.post('/api/create-invoice', async (req, res) => {
  try {
    const { telegram_id, amount_gram, wallet_address } = req.body;
    const user = await getUser(telegram_id);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    if (!wallet_address) return res.status(400).json({ error: 'Подключите кошелёк' });

    // Создаем запись инвойса
    const stars = Math.floor(amount_gram * 100);
    const inv = await pool.query(
      'INSERT INTO deposit_invoices(user_id, amount_gram, amount_stars, status) VALUES($1,$2,$3,$4) RETURNING id',
      [telegram_id, amount_gram, stars, 'pending']
    );

    // Отправляем уведомление админу о необходимости проверить оплату
    await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.ADMIN_ID,
      text: `💎 Запрос на пополнение\n👤 @${user.username} (${telegram_id})\n💰 ${amount_gram} Gram (${stars}⭐)\n📍 Кошелёк: ${wallet_address}\n🔑 ID: ${inv.rows[0].id}\n\nДля подтверждения: /approve_deposit_${inv.rows[0].id}`
    }).catch(() => {});

    res.json({ success: true, invoice_id: inv.rows[0].id, stars_amount: stars });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ПОДТВЕРЖДЕНИЕ ОПЛАТЫ (АДМИН) ───────────────────────────────────
app.post('/api/approve-deposit/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const admin_id = req.headers['x-admin-id'];
    if (String(admin_id) !== CONFIG.ADMIN_ID) return res.status(403).json({ error: 'Нет доступа' });

    const inv = await pool.query('SELECT * FROM deposit_invoices WHERE id=$1 AND status=$2', [id, 'pending']);
    if (!inv.rows[0]) return res.status(404).json({ error: 'Инвойс не найден' });

    const { user_id, amount_stars, amount_gram } = inv.rows[0];
    
    await addStars(user_id, amount_stars, `Пополнение Gram: ${amount_gram}`);
    await pool.query('UPDATE users SET total_deposited=total_deposited+$1 WHERE telegram_id=$2', [amount_stars, user_id]);
    await pool.query('UPDATE deposit_invoices SET status=$1 WHERE id=$2', ['completed', id]);

    const user = await getUser(user_id);
    broadcastTo(user_id, { type: 'balance_update', stars: user.stars });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: ПОПОЛНЕНИЕ ЗВЕЗДАМИ (TELEGRAM STARS) ─────────────────────────────
app.post('/api/deposit/stars', async (req, res) => {
  try {
    const { telegram_id, amount } = req.body;
    const user = await getUser(telegram_id);
    if (!user) return res.status(404).json({ error: 'Не найден' });
    if (!amount || amount < 50) return res.status(400).json({ error: 'Минимум 50⭐' });

    await addStars(telegram_id, amount, `Пополнение Stars: ${amount}`);
    await pool.query('UPDATE users SET total_deposited=total_deposited+$1 WHERE telegram_id=$2', [amount, telegram_id]);

    const user2 = await getUser(telegram_id);
    broadcastTo(telegram_id, { type: 'balance_update', stars: user2.stars });
    res.json({ success: true, stars_added: amount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN ────────────────────────────────────────────────────────────────────
function isAdmin(req, res, next) {
  const id = req.headers['x-admin-id'] || req.body?.admin_id;
  if (String(id) !== String(CONFIG.ADMIN_ID)) return res.status(403).json({ error: 'Нет доступа' });
  next();
}

app.post('/api/admin/balance', isAdmin, async (req, res) => {
  try {
    const { telegram_id, amount, action } = req.body;
    if (action === 'add') await addStars(telegram_id, amount, 'Начисление от админа');
    else await deductStars(telegram_id, amount, 'Списание от админа');
    const user = await getUser(telegram_id);
    broadcastTo(telegram_id, { type: 'balance_update', stars: user.stars });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ban', isAdmin, async (req, res) => {
  try {
    const { telegram_id, ban } = req.body;
    await pool.query('UPDATE users SET is_banned=$1 WHERE telegram_id=$2', [ban, telegram_id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/add-nft', isAdmin, async (req, res) => {
  try {
    const { owner_id, name, image_url, gift_id } = req.body;
    await pool.query(
      'INSERT INTO nft_items(owner_id,name,image_url,gift_id) VALUES($1,$2,$3,$4)',
      [owner_id, name, image_url, gift_id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', isAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users ORDER BY total_wagered DESC');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/withdrawals', isAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT w.*, u.username, u.first_name FROM withdrawals w
      JOIN users u ON w.user_id=u.telegram_id
      WHERE w.status='pending' ORDER BY w.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/pending-deposits', isAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT d.*, u.username, u.first_name, u.wallet_address
      FROM deposit_invoices d
      JOIN users u ON d.user_id=u.telegram_id
      WHERE d.status='pending' ORDER BY d.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawal/:id/approve', isAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE withdrawals SET status=$1 WHERE id=$2', ['approved', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/withdrawal/:id/reject', isAdmin, async (req, res) => {
  try {
    const w = await pool.query('SELECT * FROM withdrawals WHERE id=$1', [req.params.id]);
    if (w.rows[0] && w.rows[0].status === 'pending') {
      await addStars(w.rows[0].user_id, w.rows[0].amount, 'Возврат при отказе вывода');
      await pool.query('UPDATE withdrawals SET status=$1 WHERE id=$2', ['rejected', req.params.id]);
      const user = await getUser(w.rows[0].user_id);
      broadcastTo(w.rows[0].user_id, { type: 'balance_update', stars: user.stars });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reset-leaderboard', isAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE users SET total_wagered=0');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reset-balances', isAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE users SET stars=0');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── РАКЕТА (ИСПРАВЛЕННАЯ) ─────────────────────────────────────────────────
let rocketState = 'waiting';
let rocketTimer = 10;
let rocketMultiplier = 1.00;
let rocketCrashPoint = 2.00;
let rocketBets = {};
let crashHistory = [];

function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.3) return parseFloat((1.05 + Math.random() * 0.5).toFixed(2));
  if (r < 0.6) return parseFloat((1.5 + Math.random() * 1.5).toFixed(2));
  if (r < 0.85) return parseFloat((2.0 + Math.random() * 4.0).toFixed(2));
  return parseFloat((5.0 + Math.random() * 3.0).toFixed(2));
}

function getRocketBetsList() {
  return Object.entries(rocketBets).map(([id, b]) => ({
    telegram_id: id, name: b.name, avatar: b.avatar,
    amount: b.amount, cashedOut: b.cashedOut, cashoutMultiplier: b.cashoutMultiplier
  }));
}

async function rocketLoop() {
  while (true) {
    rocketState = 'waiting';
    rocketTimer = 10;
    rocketBets = {};
    broadcast({ type: 'rocket_waiting', timer: rocketTimer, bets: [] });

    for (let i = 10; i > 0; i--) {
      await sleep(1000);
      rocketTimer = i - 1;
      broadcast({ type: 'rocket_tick', timer: rocketTimer, bets: getRocketBetsList() });
    }

    if (Object.keys(rocketBets).length === 0) continue;

    rocketState = 'flying';
    rocketMultiplier = 1.00;
    rocketCrashPoint = generateCrashPoint();
    console.log('🚀 Ракета взлетает! Точка краша:', rocketCrashPoint);
    broadcast({ type: 'rocket_start', crashPoint: rocketCrashPoint });

    const interval = 80; // Быстрее обновление
    const growRate = 0.008; // Быстрее рост

    // Убедимся что точка краша больше 1
    const finalCrashPoint = Math.max(1.05, rocketCrashPoint);

    while (rocketMultiplier < finalCrashPoint) {
      await sleep(interval);
      // Расчет множителя с ускорением
      rocketMultiplier = parseFloat((rocketMultiplier * (1 + growRate)).toFixed(2));
      
      // Не превышаем точку краша
      if (rocketMultiplier >= finalCrashPoint) {
        rocketMultiplier = finalCrashPoint;
      }

      // Автовывод для игроков
      for (const [tid, bet] of Object.entries(rocketBets)) {
        if (!bet.cashedOut && bet.autoCashout && rocketMultiplier >= bet.autoCashoutValue) {
          await handleRocketCashout(tid, rocketMultiplier);
        }
      }

      broadcast({ type: 'rocket_fly', multiplier: rocketMultiplier, bets: getRocketBetsList() });
      
      if (rocketMultiplier >= finalCrashPoint) break;
    }

    rocketState = 'crashed';
    broadcast({ type: 'rocket_crash', multiplier: finalCrashPoint });
    crashHistory.unshift(finalCrashPoint);
    if (crashHistory.length > 10) crashHistory.pop();
    await pool.query('INSERT INTO crash_history(multiplier) VALUES($1)', [finalCrashPoint]);

    // Проигравшие теряют деньги
    for (const [tid, bet] of Object.entries(rocketBets)) {
      if (!bet.cashedOut) {
        await pool.query('UPDATE users SET total_wagered=total_wagered+$1 WHERE telegram_id=$2', [bet.amount, tid]);
      }
    }

    await sleep(3000);
  }
}

async function handleRocketCashout(telegram_id, multiplier) {
  const bet = rocketBets[telegram_id];
  if (!bet || bet.cashedOut) return false;
  bet.cashedOut = true;
  bet.cashoutMultiplier = multiplier;
  const win = Math.floor(bet.amount * multiplier);
  await addStars(telegram_id, win, `Вывод в ракете x${multiplier}`);
  await pool.query('UPDATE users SET games_won=games_won+1, total_wagered=total_wagered+$1 WHERE telegram_id=$2', [bet.amount, telegram_id]);
  const user = await getUser(telegram_id);
  broadcastTo(telegram_id, { type: 'rocket_cashout_success', telegram_id, multiplier, winAmount: win });
  broadcastTo(telegram_id, { type: 'balance_update', stars: user.stars });
  return true;
}

// ── РУЛЕТКА (ИСПРАВЛЕННАЯ - ЗЕЛЕНЫЕ НА РАЗНЫХ КОНЦАХ) ────────────────────
// Распределение: красный, синий, зеленый, красный, синий, ... и зеленый в конце
const ROULETTE_SLOTS = [];
// Всего 30 слотов, 2 зеленых на позициях 0 и 15 (противоположные стороны)
for (let i = 0; i < 30; i++) {
  if (i === 0 || i === 15) {
    ROULETTE_SLOTS.push('green');
  } else if (i % 2 === 0) {
    ROULETTE_SLOTS.push('red');
  } else {
    ROULETTE_SLOTS.push('blue');
  }
}

let rouletteState = 'waiting';
let rouletteTimer = 15;
let rouletteBet = null;

async function rouletteLoop() {
  while (true) {
    rouletteState = 'waiting';
    rouletteTimer = 15;
    rouletteBet = null;
    broadcast({ type: 'roulette_tick', timer: 15, bet: null });

    for (let i = 15; i > 0; i--) {
      await sleep(1000);
      rouletteTimer = i - 1;
      broadcast({ type: 'roulette_tick', timer: rouletteTimer, bet: rouletteBet });
    }

    if (!rouletteBet) continue;

    const winIndex = Math.floor(Math.random() * ROULETTE_SLOTS.length);
    const winSlot = ROULETTE_SLOTS[winIndex];
    const multiplier = winSlot === 'green' ? 10 : 2;
    const winAmount = rouletteBet.amount * multiplier;

    broadcast({ type: 'roulette_roll', winSlot, winIndex, bet: rouletteBet, winAmount, multiplier });

    if (rouletteBet.color === winSlot) {
      await addStars(rouletteBet.telegram_id, winAmount, `Выигрыш в рулетке x${multiplier}`);
      await pool.query('UPDATE users SET games_won=games_won+1 WHERE telegram_id=$1', [rouletteBet.telegram_id]);
      const user = await getUser(rouletteBet.telegram_id);
      broadcastTo(rouletteBet.telegram_id, { type: 'balance_update', stars: user.stars });
      broadcast({ type: 'roulette_result', winner: rouletteBet.telegram_id, winAmount, winSlot });
    } else {
      broadcast({ type: 'roulette_result', winner: null, winSlot });
    }

    await pool.query('UPDATE users SET total_wagered=total_wagered+$1 WHERE telegram_id=$2', [rouletteBet.amount, rouletteBet.telegram_id]);

    await sleep(5000);
  }
}

// ── WEBSOCKET ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.type === 'auth') {
        ws.telegram_id = msg.telegram_id;
        const user = await getUser(msg.telegram_id);
        if (user) ws.send(JSON.stringify({ type: 'balance_update', stars: user.stars }));
        ws.send(JSON.stringify({ type: 'crash_history', history: crashHistory }));
        ws.send(JSON.stringify({ type: 'rocket_tick', timer: rocketTimer, bets: getRocketBetsList() }));
        ws.send(JSON.stringify({ type: 'roulette_tick', timer: rouletteTimer, bet: rouletteBet }));
      }

      if (msg.type === 'rocket_bet') {
        const user = await getUser(msg.telegram_id);
        if (!user || user.is_banned || user.stars < msg.amount || msg.amount < 10) return;
        if (rocketState !== 'waiting') return;
        if (rocketBets[msg.telegram_id]) return;

        await deductStars(msg.telegram_id, msg.amount, 'Ставка в ракете');
        await pool.query('UPDATE users SET games_played=games_played+1 WHERE telegram_id=$1', [msg.telegram_id]);
        rocketBets[msg.telegram_id] = {
          name: msg.name, avatar: msg.avatar, amount: msg.amount,
          autoCashout: msg.autoCashout, autoCashoutValue: parseFloat(msg.autoCashoutValue) || 0,
          cashedOut: false, cashoutMultiplier: null
        };
        const u = await getUser(msg.telegram_id);
        ws.send(JSON.stringify({ type: 'balance_update', stars: u.stars }));
        broadcast({ type: 'rocket_tick', timer: rocketTimer, bets: getRocketBetsList() });
      }

      if (msg.type === 'rocket_cashout') {
        if (rocketState !== 'flying') return;
        await handleRocketCashout(msg.telegram_id, rocketMultiplier);
        broadcast({ type: 'rocket_fly', multiplier: rocketMultiplier, bets: getRocketBetsList() });
      }

      if (msg.type === 'cancel_rocket_bet') {
        if (rocketState !== 'waiting') return;
        const bet = rocketBets[msg.telegram_id];
        if (!bet) return;
        delete rocketBets[msg.telegram_id];
        await addStars(msg.telegram_id, bet.amount, 'Отмена ставки в ракете');
        const u = await getUser(msg.telegram_id);
        ws.send(JSON.stringify({ type: 'balance_update', stars: u.stars }));
        broadcast({ type: 'rocket_tick', timer: rocketTimer, bets: getRocketBetsList() });
      }

      if (msg.type === 'roulette_bet') {
        const user = await getUser(msg.telegram_id);
        if (!user || user.is_banned || user.stars < msg.amount || msg.amount < 10) return;
        if (rouletteState !== 'waiting') return;
        if (rouletteBet) return;

        await deductStars(msg.telegram_id, msg.amount, 'Ставка в рулетке');
        await pool.query('UPDATE users SET games_played=games_played+1 WHERE telegram_id=$1', [msg.telegram_id]);

        rouletteBet = {
          telegram_id: msg.telegram_id,
          name: msg.name,
          avatar: msg.avatar,
          amount: msg.amount,
          color: msg.color
        };

        const u = await getUser(msg.telegram_id);
        ws.send(JSON.stringify({ type: 'balance_update', stars: u.stars }));
        broadcast({ type: 'roulette_tick', timer: rouletteTimer, bet: rouletteBet });
      }

      if (msg.type === 'cancel_roulette_bet') {
        if (rouletteState !== 'waiting') return;
        if (!rouletteBet) return;
        const bet = rouletteBet;
        rouletteBet = null;
        await addStars(msg.telegram_id, bet.amount, 'Отмена ставки в рулетке');
        const u = await getUser(msg.telegram_id);
        ws.send(JSON.stringify({ type: 'balance_update', stars: u.stars }));
        broadcast({ type: 'roulette_tick', timer: rouletteTimer, bet: null });
      }

    } catch (e) {
      console.error('WS error:', e.message);
    }
  });
});

// ── СТАРТ ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`🚀 DadTon запущен на порту ${PORT}`);
  await initDB();
  rocketLoop();
  rouletteLoop();
});