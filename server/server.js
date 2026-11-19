// Бортовик: сервер кошелька и приёма платежей через ЮKassa.
// Без внешних зависимостей: Node.js 22+ (встроенные http, fetch и node:sqlite).
// Запуск: YK_SHOP_ID=... YK_SECRET_KEY=... RETURN_URL=https://ваш-сайт/#wallet node server.js
//
// Деньги хранятся в копейках (целые числа). Баланс = сумма проведённых записей журнала.
// ВАЖНО: идентификация пользователя здесь упрощена (заголовок X-User-Id).
// Перед запуском замените её на настоящую авторизацию (сессии, JWT, вход по телефону).

"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const CFG = {
  port: Number(process.env.PORT || 8080),
  db: process.env.DB_PATH || "bortovik.db",
  ykApi: process.env.YK_API || "https://api.yookassa.ru/v3",
  shopId: process.env.YK_SHOP_ID || "",
  secretKey: process.env.YK_SECRET_KEY || "",
  payoutAgentId: process.env.YK_PAYOUT_AGENT_ID || "",   // выплаты подключаются отдельным договором
  payoutSecret: process.env.YK_PAYOUT_SECRET || "",
  returnUrl: process.env.RETURN_URL || "http://localhost:8080/#wallet",
  receipts: process.env.YK_RECEIPTS === "1",              // чеки 54-ФЗ через ЮKassa
  corsOrigin: process.env.CORS_ORIGIN || "*",
};

// Каталог на сервере: цены берутся только отсюда, никогда из запроса клиента.
const PRODUCTS = {
  lic:  { name: "Лицензия «Бортовик»", price: 249000, subject: "service",   needVin: true },
  dsp:  { name: "Лицензия DSP",        price: 149000, subject: "service",   needVin: true },
  m1:   { name: "Модуль М1 (USB)",     price: 690000, subject: "commodity" },
  ad:   { name: "Адаптер «без пайки»", price: 190000, subject: "commodity" },
  usb:  { name: "Кабель USB-C, 1,5 м", price:  59000, subject: "commodity" },
  case: { name: "Держатель модуля",    price:  45000, subject: "commodity" },
  kit:  { name: "Комплект «Под ключ»", price: 999000, subject: "commodity", needVin: true },
  inst: { name: "Установка в сервисе", price: 350000, subject: "service" },
};
const DELIVERY = { cdek: 35000, post: 29000, pick: 0 };
const METHODS = new Set(["yoo_money", "sbp", "sberbank", "tinkoff_bank", "bank_card"]);
const LIMITS = { topupMin: 10000, topupMax: 15000000, withdrawMin: 50000 };

// ---------------------------------------------------------------- база
const db = new DatabaseSync(CFG.db);
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, wallet TEXT UNIQUE NOT NULL, email TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,            -- topup | purchase | p2p_in | p2p_out | refund | withdraw | withdraw_revert
  amount INTEGER NOT NULL,       -- копейки, + зачисление, − списание
  status TEXT NOT NULL,          -- ok | pending
  ref TEXT,                      -- id платежа, заказа, выплаты или перевода
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_once ON ledger(kind, ref, user_id) WHERE ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,           -- id платежа в ЮKassa
  user_id TEXT NOT NULL, purpose TEXT NOT NULL, order_id TEXT,
  amount INTEGER NOT NULL, method TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, items TEXT NOT NULL, delivery TEXT, delivery_price INTEGER NOT NULL,
  total INTEGER NOT NULL, from_wallet INTEGER NOT NULL, external INTEGER NOT NULL,
  vin TEXT, email TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
`);
const now = () => Date.now();

function tx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}
const q = {
  user: db.prepare("SELECT * FROM users WHERE id = ?"),
  userByWallet: db.prepare("SELECT * FROM users WHERE wallet = ?"),
  addUser: db.prepare("INSERT INTO users (id, wallet, email, created_at) VALUES (?, ?, ?, ?)"),
  balance: db.prepare("SELECT COALESCE(SUM(amount),0) AS b FROM ledger WHERE user_id = ? AND (status = 'ok' OR (status = 'pending' AND amount < 0))"),
  addEntry: db.prepare("INSERT INTO ledger (user_id, kind, amount, status, ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  history: db.prepare("SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 200"),
  addPayment: db.prepare("INSERT INTO payments (id, user_id, purpose, order_id, amount, method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  payment: db.prepare("SELECT * FROM payments WHERE id = ?"),
  setPayment: db.prepare("UPDATE payments SET status = ? WHERE id = ?"),
  addOrder: db.prepare("INSERT INTO orders (user_id, items, delivery, delivery_price, total, from_wallet, external, vin, email, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  order: db.prepare("SELECT * FROM orders WHERE id = ?"),
  setOrder: db.prepare("UPDATE orders SET status = ? WHERE id = ?"),
  orders: db.prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100"),
  setEntry: db.prepare("UPDATE ledger SET status = ? WHERE kind = ? AND ref = ? AND user_id = ?"),
};
// Списание с резервом: pending-списания уже уменьшают доступный баланс.
const balanceOf = (userId) => Number(q.balance.get(userId).b);

function ensureUser(id, email) {
  let u = q.user.get(id);
  if (!u) {
    let wallet;
    do { wallet = `4100-${rand4()}-${rand4()}`; } while (q.userByWallet.get(wallet));
    q.addUser.run(id, wallet, email || null, now());
    u = q.user.get(id);
  }
  return u;
}
const rand4 = () => String(crypto.randomInt(1000, 10000));

// ---------------------------------------------------------------- ЮKassa
function ykAuth(id, secret) { return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"); }
async function yk(method, path, body, { payouts = false, idemKey } = {}) {
  const auth = payouts ? ykAuth(CFG.payoutAgentId, CFG.payoutSecret) : ykAuth(CFG.shopId, CFG.secretKey);
  const headers = { Authorization: auth, "Content-Type": "application/json" };
  if (method === "POST") headers["Idempotence-Key"] = idemKey || crypto.randomUUID();
  const res = await fetch(CFG.ykApi + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpErr(502, `ЮKassa ответила ${res.status}: ${data.description || data.code || "ошибка"}`);
  return data;
}
const kopToValue = (k) => (k / 100).toFixed(2);
const valueToKop = (v) => Math.round(Number(v) * 100);

async function createPayment({ user, amount, method, purpose, orderId, description, receiptItems, email }) {
  const body = {
    amount: { value: kopToValue(amount), currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: CFG.returnUrl },
    payment_method_data: { type: method },
    description: description.slice(0, 128),
    metadata: { user_id: user.id, purpose, order_id: orderId ? String(orderId) : "" },
  };
  if (CFG.receipts) {
    body.receipt = {
      customer: { email: email || user.email },
      items: receiptItems || [{ description: description.slice(0, 128), quantity: "1.00",
        amount: { value: kopToValue(amount), currency: "RUB" }, vat_code: 1,
        payment_mode: "full_prepayment", payment_subject: "payment" }],
    };
  }
  const p = await yk("POST", "/payments", body);
  q.addPayment.run(p.id, user.id, purpose, orderId ? String(orderId) : null, amount, method, p.status, now());
  return { paymentId: p.id, confirmationUrl: p.confirmation && p.confirmation.confirmation_url, status: p.status };
}

// Применение успешного платежа. Идемпотентно: повторный вебхук ничего не изменит.
function applySucceeded(pay) {
  return tx(() => {
    const local = q.payment.get(pay.id);
    if (!local || local.status === "succeeded") return false;
    if (valueToKop(pay.amount.value) !== local.amount || pay.amount.currency !== "RUB") {
      throw httpErr(409, "Сумма платежа не совпадает с ожидаемой");
    }
    q.setPayment.run("succeeded", pay.id);
    q.addEntry.run(local.user_id, "topup", local.amount, "ok", pay.id,
      local.purpose === "order" ? `Оплата заказа № ${local.order_id}` : "Пополнение кошелька", now());
    if (local.purpose === "order") {
      const o = q.order.get(Number(local.order_id));
      if (o && o.status === "awaiting_payment") {
        // часть с кошелька уже зарезервирована при создании заказа; списываем внешнюю часть и проводим резерв
        q.addEntry.run(o.user_id, "purchase", -o.external, "ok", `order:${o.id}:ext`, `Заказ № ${o.id}`, now());
        q.setEntry.run("ok", "purchase", `order:${o.id}:wallet`, o.user_id);
        q.setOrder.run("paid", o.id);
      }
    }
    return true;
  });
}
function applyCanceled(pay) {
  return tx(() => {
    const local = q.payment.get(pay.id);
    if (!local || local.status === "canceled" || local.status === "succeeded") return false;
    q.setPayment.run("canceled", pay.id);
    if (local.purpose === "order") {
      const o = q.order.get(Number(local.order_id));
      if (o && o.status === "awaiting_payment") {
        // снимаем резерв с кошелька
        q.setEntry.run("void", "purchase", `order:${o.id}:wallet`, o.user_id);
        q.setOrder.run("canceled", o.id);
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------- обработчики
const routes = {
  // Профиль, баланс, история
  "GET /api/wallet": async (req) => {
    const u = ensureUser(req.userId);
    return { wallet: u.wallet, balance: balanceOf(u.id), history: q.history.all(u.id), orders: q.orders.all(u.id) };
  },

  // Пополнение через ЮKassa
  "POST /api/topup": async (req, b) => {
    const u = ensureUser(req.userId, b.email);
    const amount = toKop(b.amount);
    if (amount < LIMITS.topupMin || amount > LIMITS.topupMax) throw httpErr(400, "Сумма от 100 до 150 000 ₽");
    if (!METHODS.has(b.method)) throw httpErr(400, "Неизвестный способ оплаты");
    return createPayment({ user: u, amount, method: b.method, purpose: "topup", description: `Пополнение кошелька ${u.wallet}`, email: b.email });
  },

  // Заказ: оплата с баланса, внешним способом или смешанно
  "POST /api/orders": async (req, b) => {
    const u = ensureUser(req.userId, b.email);
    const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({ id: String(i.id), qty: Math.floor(Number(i.qty)) }));
    if (!items.length || items.some((i) => !PRODUCTS[i.id] || !(i.qty >= 1 && i.qty <= 20))) throw httpErr(400, "Проверьте состав корзины");
    const needVin = items.some((i) => PRODUCTS[i.id].needVin);
    const vin = needVin ? String(b.vin || "").toUpperCase() : null;
    if (needVin && !/^[A-HJ-NPR-Z0-9]{7}$/.test(vin)) throw httpErr(400, "Нужны последние 7 знаков VIN");
    const physical = items.some((i) => PRODUCTS[i.id].subject === "commodity");
    const delivery = physical ? String(b.delivery || "") : "pick";
    if (!(delivery in DELIVERY)) throw httpErr(400, "Неизвестный способ доставки");
    const goods = items.reduce((a, i) => a + PRODUCTS[i.id].price * i.qty, 0);
    const total = goods + DELIVERY[delivery];

    const { order, external } = tx(() => {
      const fromWallet = b.useWallet ? Math.max(0, Math.min(balanceOf(u.id), total)) : 0;
      const external = total - fromWallet;
      const r = q.addOrder.run(u.id, JSON.stringify(items), delivery, DELIVERY[delivery], total, fromWallet, external,
        vin, b.email || null, external > 0 ? "awaiting_payment" : "paid", now());
      const id = Number(r.lastInsertRowid);
      if (fromWallet > 0) {
        q.addEntry.run(u.id, "purchase", -fromWallet, external > 0 ? "pending" : "ok", `order:${id}:wallet`, `Заказ № ${id}`, now());
      }
      return { order: q.order.get(id), external };
    });

    if (external === 0) return { orderId: order.id, status: "paid" };
    if (!METHODS.has(b.method)) { applyCanceledLocal(order); throw httpErr(400, "Выберите способ доплаты"); }
    const receiptItems = CFG.receipts ? buildReceipt(items, delivery, order) : undefined;
    try {
      const p = await createPayment({ user: u, amount: external, method: b.method, purpose: "order", orderId: order.id,
        description: `Заказ № ${order.id}`, receiptItems, email: b.email });
      return { orderId: order.id, ...p, paymentStatus: p.status, status: "awaiting_payment" };
    } catch (e) { applyCanceledLocal(order); throw e; }
  },

  // Отмена оплаченного заказа: деньги возвращаются на баланс кошелька
  "POST /api/orders/cancel": async (req, b) => {
    const u = ensureUser(req.userId);
    return tx(() => {
      const o = q.order.get(Number(b.orderId));
      if (!o || o.user_id !== u.id) throw httpErr(404, "Заказ не найден");
      if (o.status !== "paid") throw httpErr(409, "Этот заказ уже нельзя отменить");
      q.addEntry.run(u.id, "refund", o.total, "ok", `order:${o.id}`, `Возврат по заказу № ${o.id}`, now());
      q.setOrder.run("refunded", o.id);
      return { ok: true, balance: balanceOf(u.id) };
    });
  },

  // Перевод между кошельками магазина
  "POST /api/transfer": async (req, b) => {
    const u = ensureUser(req.userId);
    const amount = toKop(b.amount);
    if (amount <= 0) throw httpErr(400, "Сумма должна быть больше нуля");
    const ref = `p2p:${crypto.randomUUID()}`;
    return tx(() => {
      const to = q.userByWallet.get(String(b.toWallet || ""));
      if (!to) throw httpErr(404, "Кошелёк получателя не найден");
      if (to.id === u.id) throw httpErr(400, "Нельзя перевести самому себе");
      if (balanceOf(u.id) < amount) throw httpErr(409, "Недостаточно средств");
      const note = String(b.note || "").slice(0, 140);
      q.addEntry.run(u.id, "p2p_out", -amount, "ok", ref, `→ ${to.wallet}${note ? " · " + note : ""}`, now());
      q.addEntry.run(to.id, "p2p_in", amount, "ok", ref, `← ${u.wallet}${note ? " · " + note : ""}`, now());
      return { ok: true, balance: balanceOf(u.id) };
    });
  },

  // Вывод на кошелёк ЮMoney через выплаты ЮKassa
  "POST /api/withdraw": async (req, b) => {
    const u = ensureUser(req.userId);
    const amount = toKop(b.amount);
    const account = String(b.account || "").replace(/\D/g, "");
    if (amount < LIMITS.withdrawMin) throw httpErr(400, "Минимум 500 ₽");
    if (!/^\d{11,20}$/.test(account)) throw httpErr(400, "Укажите номер кошелька ЮMoney");
    if (!CFG.payoutAgentId) throw httpErr(503, "Выплаты не подключены");
    const ref = `wd:${crypto.randomUUID()}`;
    tx(() => {
      if (balanceOf(u.id) < amount) throw httpErr(409, "Недостаточно средств");
      q.addEntry.run(u.id, "withdraw", -amount, "pending", ref, `ЮMoney ${account}`, now());
    });
    try {
      const p = await yk("POST", "/payouts", {
        amount: { value: kopToValue(amount), currency: "RUB" },
        payout_destination_data: { type: "yoo_money", account_number: account },
        description: `Вывод из кошелька ${u.wallet}`,
        metadata: { user_id: u.id, ref },
      }, { payouts: true, idemKey: ref });
      if (p.status === "canceled") throw httpErr(502, "Выплата отклонена");
      q.setEntry.run(p.status === "succeeded" ? "ok" : "pending", "withdraw", ref, u.id);
      return { ok: true, payoutId: p.id, status: p.status };
    } catch (e) {
      tx(() => { q.setEntry.run("void", "withdraw", ref, u.id); });
      throw e;
    }
  },

  // Уведомления ЮKassa. Укажите этот адрес в личном кабинете: Интеграция → HTTP-уведомления.
  "POST /api/yookassa/webhook": async (req, b) => {
    const id = b && b.object && b.object.id;
    if (!id) throw httpErr(400, "Пустое уведомление");
    // Не доверяем телу уведомления: запрашиваем актуальный статус платежа у ЮKassa.
    if (String(b.event || "").startsWith("payout.")) return handlePayoutEvent(b);
    const pay = await yk("GET", `/payments/${encodeURIComponent(id)}`);
    if (pay.status === "succeeded") applySucceeded(pay);
    else if (pay.status === "canceled") applyCanceled(pay);
    return { ok: true };
  },
};

async function handlePayoutEvent(b) {
  const p = await yk("GET", `/payouts/${encodeURIComponent(b.object.id)}`, null, { payouts: true });
  const userId = p.metadata && p.metadata.user_id, ref = p.metadata && p.metadata.ref;
  if (!userId || !ref) return { ok: true };
  tx(() => q.setEntry.run(p.status === "succeeded" ? "ok" : p.status === "canceled" ? "void" : "pending", "withdraw", ref, userId));
  return { ok: true };
}
function applyCanceledLocal(o) {
  tx(() => { q.setEntry.run("void", "purchase", `order:${o.id}:wallet`, o.user_id); q.setOrder.run("canceled", o.id); });
}
function buildReceipt(items, delivery, order) {
  // Позиции чека на внешнюю часть оплаты. При смешанной оплате долю кошелька лучше
  // оформлять как зачёт предоплаты: уточните схему с вашей бухгалтерией и ЮKassa.
  const scale = order.external / order.total;
  const lines = items.map((i) => ({
    description: PRODUCTS[i.id].name, quantity: i.qty.toFixed(2),
    amount: { value: kopToValue(Math.round(PRODUCTS[i.id].price * scale)), currency: "RUB" },
    vat_code: 1, payment_mode: "full_payment", payment_subject: PRODUCTS[i.id].subject,
  }));
  if (DELIVERY[delivery]) lines.push({ description: "Доставка", quantity: "1.00",
    amount: { value: kopToValue(Math.round(DELIVERY[delivery] * scale)), currency: "RUB" },
    vat_code: 1, payment_mode: "full_payment", payment_subject: "service" });
  // подгоняем копейки округления к сумме платежа
  const sum = lines.reduce((a, l) => a + valueToKop(l.amount.value) * Number(l.quantity), 0);
  const diff = order.external - sum;
  if (diff !== 0) { const l = lines[lines.length - 1]; const qn = Number(l.quantity);
    if (qn === 1) l.amount.value = kopToValue(valueToKop(l.amount.value) + diff); }
  return lines;
}

// ---------------------------------------------------------------- HTTP
function toKop(v) { const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? Math.round(n * 100) : 0; }
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 1e6) { reject(httpErr(413, "Слишком большой запрос")); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(httpErr(400, "Некорректный JSON")); } });
  });
}
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": CFG.corsOrigin, "Access-Control-Allow-Headers": "Content-Type, X-User-Id" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const path = new URL(req.url, "http://x").pathname;
  const h = routes[`${req.method} ${path}`];
  if (!h) return send(res, 404, { error: "Не найдено" });
  try {
    const body = req.method === "POST" ? await readJson(req) : {};
    if (!path.startsWith("/api/yookassa/")) {
      req.userId = String(req.headers["x-user-id"] || "");             // ← замените на авторизацию
      if (!/^[\w-]{6,64}$/.test(req.userId)) throw httpErr(401, "Требуется вход");
    }
    send(res, 200, await h(req, body));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || "Ошибка сервера" });
  }
});

if (require.main === module) {
  if (!CFG.shopId || !CFG.secretKey) console.warn("YK_SHOP_ID и YK_SECRET_KEY не заданы: платежи работать не будут.");
  server.listen(CFG.port, () => console.log(`Бортовик API: http://localhost:${CFG.port}`));
}
module.exports = { server, db, CFG };
