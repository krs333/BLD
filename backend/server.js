// server.js — BLD Art Studio backend
// Стек: Express + node-telegram-bot-api (WEBHOOK) + pg

import express from 'express';
import cors from 'cors';
import pg from 'pg';
import TelegramBot from 'node-telegram-bot-api';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

const { DATABASE_URL, TG_BOT_TOKEN, TG_CHAT_ID, RENDER_URL, PORT = 3000 } = process.env;

// ─── DB ───────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id           SERIAL PRIMARY KEY,
      type         VARCHAR(20)  NOT NULL,
      service      VARCHAR(100),
      name         VARCHAR(100) NOT NULL,
      phone        VARCHAR(40)  NOT NULL,
      social       VARCHAR(120) NOT NULL,
      booking_date DATE,
      booking_time TIME,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB ready');
}

// ─── TELEGRAM WEBHOOK ─────────────────────────────────────────────────────────
let bot;

async function initTelegram() {
  if (!TG_BOT_TOKEN) {
    console.warn('TG_BOT_TOKEN not set — Telegram disabled');
    return;
  }

  // webHook: false — мы управляем webhook вручную через Express
  bot = new TelegramBot(TG_BOT_TOKEN, { webHook: false });

  if (RENDER_URL) {
    const webhookUrl = `${RENDER_URL}/tg-webhook/${TG_BOT_TOKEN}`;
    try {
      await bot.deleteWebHook();            
      await bot.setWebHook(webhookUrl);
      console.log('Telegram webhook set:', webhookUrl);
    } catch (err) {
      console.error('Failed to set webhook:', err.message);
    }
  } else {
    console.warn('RENDER_URL not set — webhook not registered');
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMessage(data) {
  const emoji = data.type === 'piercing' ? '💎' : '🖤';
  const label = data.type === 'piercing' ? 'Пирсинг' : 'Тату — консультация';
  let msg = `${emoji} <b>Новая заявка — ${label}</b>\n\n`;
  msg += `👤 <b>Имя:</b> ${escapeHtml(data.name)}\n`;
  msg += `📱 <b>Телефон:</b> ${escapeHtml(data.phone)}\n`;
  msg += `💬 <b>Соцсеть:</b> ${escapeHtml(data.social)}\n`;
  if (data.service)      msg += `📍 <b>Услуга:</b> ${escapeHtml(data.service)}\n`;
  if (data.booking_date) msg += `📅 <b>Дата:</b> ${data.booking_date}\n`;
  if (data.booking_time) msg += `🕐 <b>Время:</b> ${data.booking_time}\n`;
  msg += `\n<i>${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}</i>`;
  return msg;
}

async function sendToTelegram(data) {
  if (!bot || !TG_CHAT_ID) return;
  try {
    await bot.sendMessage(TG_CHAT_ID, formatMessage(data), { parse_mode: 'HTML' });
    console.log('Telegram message sent');
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'frontend')));

// ─── TELEGRAM WEBHOOK RECEIVER ────────────────────────────────────────────────
app.post(`/tg-webhook/${TG_BOT_TOKEN || 'disabled'}`, (req, res) => {
  if (bot) bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ─── API ──────────────────────────────────────────────────────────────────────
app.post('/api/booking', async (req, res) => {
  try {
    const { type, service, name, phone, social, date, time } = req.body;

    if (!type || !name || !phone || !social)
      return res.status(400).json({ error: 'Missing required fields' });
    if (!['piercing', 'tattoo'].includes(type))
      return res.status(400).json({ error: 'Invalid type' });

    const { rows } = await pool.query(
      `INSERT INTO bookings (type, service, name, phone, social, booking_date, booking_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [type, service || null, name, phone, social, date || null, time || null]
    );
    const id = rows[0].id;
    console.log(`Booking #${id} saved`);

    await sendToTelegram({ type, service, name, phone, social, booking_date: date, booking_time: time });

    res.json({ ok: true, id });
  } catch (err) {
    console.error('/api/booking error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/bookings', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 100');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', ts: new Date() }));

// ─── START ────────────────────────────────────────────────────────────────────
async function start() {
  await initDB();
  await initTelegram();
  app.listen(PORT, () => console.log(`BLD server on port ${PORT}`));
}

start().catch(err => { console.error('Startup error:', err); process.exit(1); });