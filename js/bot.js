// Telegram-бот Хобі-плану шле вечірній підсумок дня й неділі — сюди ж і гроші.
// Боту їдуть лише підсумки днів у гривнях (витрати, доходи, суми за категоріями) і бюджет місяця —
// без операцій, рахунків і коментарів. Адреса й ключ — з Хобі-плану: на github.io обидва застосунки на одному origin.

const HOBBY = { url: 'hobby-planner:bot-url', key: 'hobby-planner:bot-key' };
const KEYS = { off: 'marnotrat:bot-off', last: 'marnotrat:bot-last', sig: 'marnotrat:bot-sig', error: 'marnotrat:bot-error' };
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

/** Бот підключено в Хобі-плані: { url, key } або null. */
export function botConfig() {
  const url = (get(HOBBY.url) ?? '').trim().replace(/\/+$/, '');
  const key = (get(HOBBY.key) ?? '').trim();
  return url && key ? { url, key } : null;
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
