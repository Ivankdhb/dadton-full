const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Хранилище для payload
let activePayloads = new Map();

function generatePayload() {
    return crypto.randomBytes(32).toString('hex');
}

// Очистка каждые 5 минут
setInterval(() => {
    const now = Date.now();
    for (const [payload, timestamp] of activePayloads.entries()) {
        if (now - timestamp > 5 * 60 * 1000) activePayloads.delete(payload);
    }
}, 60 * 1000);

// Генерация payload
app.get('/api/generate-payload', (req, res) => {
    const payload = generatePayload();
    activePayloads.set(payload, Date.now());
    res.json({ payload });
});

// Проверка подписи (упрощённая)
app.post('/api/verify-proof', async (req, res) => {
    try {
        const { address, proof } = req.body;
        
        if (!activePayloads.has(proof.payload)) {
            return res.status(400).json({ success: false, error: 'Invalid or expired payload' });
        }
        
        activePayloads.delete(proof.payload);
        
        // Базовая проверка: payload существует, подпись есть
        if (proof.signature && proof.signature.length > 0) {
            console.log(`✅ Пользователь авторизован: ${address}`);
            return res.json({ success: true, address });
        } else {
            return res.status(401).json({ success: false, error: 'Invalid signature' });
        }
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер на порту ${PORT}`));