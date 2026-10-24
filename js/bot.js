// Telegram-бот Хобі-плану шле вечірній підсумок дня й неділі — сюди ж і гроші.
// Боту їдуть лише підсумки днів у гривнях (витрати, доходи, суми за категоріями) і бюджет місяця —
// без операцій, рахунків і коментарів. Адреса й ключ — зі спільного bot-settings.json на Google Диску,
// а поки його нема — з Хобі-плану на цьому телефоні: на github.io обидва застосунки на одному origin.

const HOBBY = { url: 'hobby-planner:bot-url', key: 'hobby-planner:bot-key' };
const KEYS = {
  off: 'marnotrat:bot-off', last: 'marnotrat:bot-last', sig: 'marnotrat:bot-sig', error: 'marnotrat:bot-error',
  url: 'marnotrat:bot-url', key: 'marnotrat:bot-key', at: 'marnotrat:bot-at',
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

/** Бот: з Диска (from 'drive') або з Хобі-плану на цьому телефоні (from 'hobby'); null — не підключений. */
export function botConfig() {
  const own = clean(get(KEYS.url), get(KEYS.key));
  if (own.url && own.key) return { ...own, from: 'drive' };
  const hobby = clean(get(HOBBY.url), get(HOBBY.key));
  return hobby.url && hobby.key ? { ...hobby, from: 'hobby' } : null;
}

/**
 * Для спільного файлу на Диску: з часом запису з Диска, а з Хобі-плану — з часом 0,
 * щоб будь-який запис з Диска його переміг. null — бот не підключений.
 */
export function sharedConfig() {
  const cfg = botConfig();
  if (!cfg) return null;
  return { url: cfg.url, key: cfg.key, updated: cfg.from === 'drive' ? Number(get(KEYS.at) || 0) : 0 };
}

/** Новіший запис з Диска. Інша адреса чи ключ — підсумки підуть боту ще раз, не чекаючи пів години. */
export function setSharedConfig(url, key, at) {
  const next = clean(url, key);
  const cur = botConfig();
  set(KEYS.url, next.url || null);
  set(KEYS.key, next.key || null);
  set(KEYS.at, at);
  if (cur?.url !== next.url || cur?.key !== next.key) set(KEYS.sig, null);
}

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
    if (!res.ok) throw new Error(res.status === 401 ? 'Ключ бота не підходить — онови його в Хобі-плані' : `Бот: HTTP ${res.status}`);
    set(KEYS.sig, sig);
    set(KEYS.last, Date.now());
    set(KEYS.error, null);
    return { ok: true };
  } catch (err) {
    set(KEYS.error, err instanceof TypeError ? 'Немає зв’язку з ботом' : err.message);
    throw err;
  } finally {
    running = false;
    if (again) { again = false; scheduleBot(payload, 500); }
  }
}
