const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Раздаём статику из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Манифест для TON Connect (тоже в public)
app.get('/tonconnect-manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tonconnect-manifest.json'));
});

// Хранилище для payload
let activePayloads = new Map();

function generatePayload() {
    return crypto.randomBytes(32).toString('hex');
}

// Очистка старых payload
setInterval(() => {
    const now = Date.now();
    for (const [payload, timestamp] of activePayloads.entries()) {
        if (now - timestamp > 5 * 60 * 1000) {
            activePayloads.delete(payload);
        }
    }
}, 60 * 1000);

// Генерация payload
app.get('/api/generate-payload', (req, res) => {
    const payload = generatePayload();
    activePayloads.set(payload, Date.now());
    console.log('📝 Новый payload:', payload);
    res.json({ payload });
});

// Проверка подписи
app.post('/api/verify-proof', async (req, res) => {
    try {
        const { address, proof } = req.body;
        
        console.log('🔍 Проверка для адреса:', address);
        
        if (!proof || !proof.payload) {
            return res.status(400).json({ success: false, error: 'No proof payload' });
        }
        
        if (!activePayloads.has(proof.payload)) {
            return res.status(400).json({ success: false, error: 'Invalid or expired payload' });
        }
        
        activePayloads.delete(proof.payload);
        
        if (proof.signature && proof.signature.length > 0) {
            console.log('✅ Пользователь авторизован:', address);
            return res.json({ success: true, address: address });
        } else {
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }
        
    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Проверка работоспособности
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📁 Статика из папки: ${path.join(__dirname, 'public')}`);
});