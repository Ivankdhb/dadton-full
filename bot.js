const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = '8710793985:AAF0RDrfFcTLOcLItyFfdr0jsFVZu0MsZR0';
const APP_URL = 'https://dadton-full.onrender.com';

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const ref = ctx.startPayload ? `?ref=${ctx.startPayload}` : '';
  ctx.reply(
    `🎲 *Добро пожаловать в DadTon!*\n\n` +
    `👋 Привет, ${ctx.from.first_name}!\n` +
    `🎮 Здесь ты можешь играть в:\n` +
    `🚀 Ракету\n` +
    `💣 Мины\n` +
    `🎡 Рулетку\n` +
    `🃏 Покер\n\n` +
    `💰 Пополняй баланс через Gram или Telegram Stars\n` +
    `🎁 Получай и продавай NFT\n\n` +
    `👇 Нажми на кнопку, чтобы открыть приложение!`,
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.webApp('🚀 Открыть DadTon', `${APP_URL}${ref}`)],
        [Markup.button.url('💎 Банк @BankDadTon', 'https://t.me/BankDadTon')],
        [Markup.button.url('📢 Наш канал', 'https://t.me/DadTonChanel')]
      ])
    }
  );
});

bot.launch().then(() => console.log('✅ Бот запущен!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));