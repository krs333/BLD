// ─────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*'
}));
app.use(express.json());

// ── PostgreSQL ──────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

// ── Telegram Bot ────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// ── DB Init ─────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id          SERIAL PRIMARY KEY,
      type        VARCHAR(20)  NOT NULL,
      service     VARCHAR(150),
      name        VARCHAR(100) NOT NULL,
      phone       VARCHAR(40)  NOT NULL,
      social      VARCHAR(150) NOT NULL,
      booking_date DATE,
      booking_time TIME,
      status      VARCHAR(20)  NOT NULL DEFAULT 'new',
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  console.log('✅ DB table ready');
}

// ── API: Create booking ─────────────────────
app.post('/api/booking', async (req, res) => {
  const { type, service, name, phone, social, date, time } = req.body;

  if (!type || !name || !phone || !social) {
    return res.status(400).json({ error: 'Заполните обязательные поля' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO bookings (type, service, name, phone, social, booking_date, booking_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [type, service || null, name, phone, social, date || null, time || null]
    );

    const bookingId = result.rows[0].id;

    // Отправить в Telegram
    await notifyTelegram({ id: bookingId, type, service, name, phone, social, date, time });

    res.json({ ok: true, id: bookingId });
  } catch (err) {
    console.error('DB error:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ── Telegram notification ───────────────────
async function notifyTelegram({ id, type, service, name, phone, social, date, time }) {
  if (!ADMIN_CHAT_ID) return;

  const typeLabel = type === 'piercing' ? '💉 Пирсинг' : '🖋 Тату (консультация)';
  const dateStr = date && time
    ? `📅 ${formatDate(date)} в ${time}`
    : date
    ? `📅 ${formatDate(date)}`
    : '';

  const msg = [
    `🔔 *Новая заявка #${id}*`,
    ``,
    `${typeLabel}`,
    service ? `Услуга: *${service}*` : '',
    dateStr,
    ``,
    `👤 Имя: *${name}*`,
    `📞 Телефон: \`${phone}\``,
    `💬 Соцсеть: ${social}`,
    ``,
    `_${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}_`
  ].filter(Boolean).join('\n');

  await bot.sendMessage(ADMIN_CHAT_ID, msg, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Подтвердить', callback_data: `confirm_${id}` },
        { text: '❌ Отменить',   callback_data: `cancel_${id}` }
      ]]
    }
  });
}

// ── Bot: handle button clicks ───────────────
bot.on('callback_query', async (query) => {
  const [action, id] = query.data.split('_');
  const status = action === 'confirm' ? 'confirmed' : 'cancelled';
  const label  = action === 'confirm' ? '✅ Подтверждена' : '❌ Отменена';

  try {
    await pool.query(
      `UPDATE bookings SET status = $1 WHERE id = $2`,
      [status, id]
    );

    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: label, callback_data: 'done' }]] },
      { chat_id: query.message.chat.id, message_id: query.message.message_id }
    );

    await bot.answerCallbackQuery(query.id, { text: `Заявка #${id} обновлена` });
  } catch (err) {
    console.error('Callback error:', err);
  }
});

// ── Bot: /start ─────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👋 Привет! Это бот студии *BLD*.\n\nТвой chat\\_id: \`${msg.chat.id}\`\n\nДобавь его в переменную ADMIN\\_CHAT\\_ID в .env`,
    { parse_mode: 'Markdown' }
  );
});

// ── Bot: /bookings ──────────────────────────
bot.onText(/\/bookings/, async (msg) => {
  if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM bookings ORDER BY created_at DESC LIMIT 10`
    );
    if (!rows.length) {
      return bot.sendMessage(msg.chat.id, 'Заявок пока нет.');
    }
    const text = rows.map(r =>
      `#${r.id} | ${r.type} | ${r.name} | ${r.status}`
    ).join('\n');
    bot.sendMessage(msg.chat.id, `Последние заявки:\n\n${text}`);
  } catch (err) {
    bot.sendMessage(msg.chat.id, 'Ошибка БД');
  }
});

// ── Health check ────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ── Helpers ──────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

// ── Start ────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});
