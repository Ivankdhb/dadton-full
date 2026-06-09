const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { TonProofVerifier } = require('@tonconnect/sdk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// === ВРЕМЕННОЕ ХРАНИЛИЩЕ ДЛЯ PAYLOAD ===
// В продакшене используйте Redis или БД
let activePayloads = new Map(); // payload -> timestamp

// Генерация случайного payload
function generatePayload() {
    return crypto.randomBytes(32).toString('hex');
}

// Очистка старых payload (каждые 5 минут)
setInterval(() => {
    const now = Date.now();
    for (const [payload, timestamp] of activePayloads.entries()) {
        if (now - timestamp > 5 * 60 * 1000) {
            activePayloads.delete(payload);
        }
    }
}, 60 * 1000);

// === ЭНДПОИНТ 1: Генерация payload для подписи ===
app.get('/api/generate-payload', (req, res) => {
    const payload = generatePayload();
    activePayloads.set(payload, Date.now());
    res.json({ payload });
});

// === ЭНДПОИНТ 2: Проверка подписи (Proof Verification) ===
app.post('/api/verify-proof', async (req, res) => {
    try {
        const { address, network, proof, publicKey } = req.body;
        
        console.log('🔍 Получен запрос на верификацию:');
        console.log('  Адрес:', address);
        console.log('  Сеть:', network);
        console.log('  PublicKey:', publicKey);
        
        // Проверяем, существует ли такой payload
        if (!activePayloads.has(proof.payload)) {
            console.log('❌ Payload не найден или истек:', proof.payload);
            return res.status(400).json({ 
                success: false, 
                error: 'Invalid or expired payload' 
            });
        }
        
        // Удаляем использованный payload (одноразовый)
        activePayloads.delete(proof.payload);
        
        // Формируем объект для проверки
        const verificationRequest = {
            address: address,
            network: network,
            proof: {
                timestamp: proof.timestamp,
                domain: {
                    lengthBytes: proof.domain.lengthBytes,
                    value: proof.domain.value
                },
                signature: proof.signature,
                payload: proof.payload,
                stateInit: proof.stateInit
            }
        };
        
        // Используем официальную проверку через TON SDK
        try {
            const isValid = await TonProofVerifier.verify(
                verificationRequest,
                publicKey
            );
            
            if (isValid) {
                console.log('✅ Подпись верна! Пользователь авторизован:', address);
                
                // ТУТ МОЖНО СОЗДАТЬ СЕССИЮ ИЛИ JWT ТОКЕН
                // Пример: генерация JWT токена
                // const jwt = require('jsonwebtoken');
                // const token = jwt.sign({ address, telegram_id: uid }, SECRET, { expiresIn: '7d' });
                
                return res.json({ 
                    success: true, 
                    message: 'Authorized successfully',
                    address: address
                });
            } else {
                console.log('❌ Подпись НЕВЕРНА для адреса:', address);
                return res.status(401).json({ 
                    success: false, 
                    error: 'Signature verification failed' 
                });
            }
        } catch (verifyError) {
            console.error('Ошибка при верификации подписи:', verifyError);
            return res.status(401).json({ 
                success: false, 
                error: 'Signature verification error: ' + verifyError.message 
            });
        }
        
    } catch (error) {
        console.error('Общая ошибка верификации:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Динамический порт для Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`📱 Открой http://localhost:${PORT}`);
});