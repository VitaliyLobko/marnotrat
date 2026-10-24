// Telegram-бот Хобі-плану шле вечірній підсумок дня й неділі — сюди ж і гроші.
// Боту їдуть лише підсумки днів у гривнях (витрати, доходи, суми за категоріями) і бюджет місяця —
// без операцій, рахунків і коментарів. Адреса й ключ — спільні для застосунків на пристрої (bot-key.js),
// між пристроями — bot-settings.json на Google Диску.
import * as BK from './bot-key.js';

const KEYS = {
  off: 'marnotrat:bot-off', last: 'marnotrat:bot-last', sig: 'marnotrat:bot-sig', error: 'marnotrat:bot-error',
  url: 'marnotrat:bot-url', key: 'marnotrat:bot-key', at: 'marnotrat:bot-at', declined: 'marnotrat:bot-declined',
};
// Те саме ще раз не шлемо, але раз на пів години — так: бот бачить, що дані свіжі
const RESEND_MS = 30 * 60 * 1000;

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function set(k, v) {
  try {
    if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v));
  } catch { /* приватний режим */ }
}

const clean = (url, key) => ({ url: (url ?? '').trim().replace(/\/+$/, ''), key: (key ?? '').trim() });

/** Бот: адреса й ключ, спільні для застосунків на цьому пристрої (bot-key.js); null — не підключений. */
/** Коли бота від'єднали саме тут (0 — ні): старіші адреса й ключ його назад не підключають. */
export const declinedAt = () => Number(get(KEYS.declined) || 0);

/** «Від'єднати» — лише в Марнотраті на цьому телефоні; Хобі-план і Вага лишаються з ботом. */
export function disconnect() {
  set(KEYS.declined, Date.now());
  set(KEYS.sig, null);
}

export function botConfig() {
  const cfg = BK.current(declinedAt());
  return cfg ? { url: cfg.url, key: cfg.key, from: 'shared' } : null;
}

/** Для bot-settings.json на Диску: лише ключ, який бот уже прийняв; null — нести нічого. */
export const sharedConfig = () => BK.forDrive(declinedAt());

/**
 * Нові адреса й ключ (вставили тут чи прийшли з Диска) — для всіх застосунків на пристрої.
 * Інша адреса чи ключ — підсумки підуть боту ще раз, не чекаючи пів години.
 */
export function setSharedConfig(url, key, at = Date.now()) {
  const next = clean(url, key);
  const cur = botConfig();
  set(KEYS.url, next.url || null);
  set(KEYS.key, next.key || null);
  set(KEYS.at, at);
  set(KEYS.declined, null);
  BK.publish(next.url, next.key, at);
  if (cur?.url !== next.url || cur?.key !== next.key) set(KEYS.sig, null);
}

/** Бот відкинув усі ключі, що є на пристрої: показати «встав новий ключ». */
export const keyProblem = () => BK.keyProblem(declinedAt());
export const isBadKey = BK.isBad;
export const markOk = BK.markOk;
export const markBad = BK.markBad;

export const botOn = () => get(KEYS.off) !== '1';

export function setBotOn(on) {
  set(KEYS.off, on ? null : '1');
  set(KEYS.sig, null);
}

export const lastSent = () => Number(get(KEYS.last) || 0);
export const lastError = () => get(KEYS.error) || '';

let timer = 0;
let running = false;
let again = false;

/** Після змін — за дві секунди, щоб серія правок пішла одним запитом. payload() — що надіслати зараз. */
export function scheduleBot(payload, ms = 2000) {
  if (!botConfig() || !botOn()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { pushBot(payload).catch(() => {}); }, ms);
}

/** Один обмін: підсумки днів від payload.from на заміну тому, що в боті. force — навіть якщо нічого не мінялось. */
export async function pushBot(payload, { force = false } = {}) {
  const cfg = botConfig();
  if (!cfg || !botOn()) return { off: true };
  if (running) { again = true; return { busy: true }; }
  running = true;
  try {
    const body = payload();
    const sig = JSON.stringify(body);
    if (!force && sig === get(KEYS.sig) && Date.now() - lastSent() < RESEND_MS) return { same: true };
    const res = await fetch(`${cfg.url}/api/money`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: sig,
    });
    if (res.status === 401) BK.markBad(cfg);
    else if (res.ok) BK.markOk(cfg);
    if (!res.ok) throw new Error(res.status === 401 ? 'Ключ доступу не підходить — візьми новий командою /key у Telegram-боті' : `Бот: HTTP ${res.status}`);
    set(KEYS.sig, sig);
    set(KEYS.last, Date.now());
    set(KEYS.error, null);
    return { ok: true };
  } catch (err) {
    set(KEYS.error, err instanceof TypeError ? 'Немає зв’язку з сервером' : err.message);
    throw err;
  } finally {
    running = false;
    if (again) { again = false; scheduleBot(payload, 500); }
  }
}
