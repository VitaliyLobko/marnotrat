// Віджет на головному екрані Android (окремий застосунок marnotrat-widget) бере шапку з сервера синхронізації.
// Сюди йдуть лише підсумки: баланс, витрати, бюджет, заплановане — без рахунків, коментарів і тегів.
// Окремо від bot.js: віджет працює й тоді, коли підсумки в Telegram вимкнено.
import * as Bot from './bot.js';

const KEYS = { sig: 'marnotrat:widget-sig', last: 'marnotrat:widget-last' };
// Те саме ще раз не шлемо, але раз на пів години — так: віджет бачить, що дані свіжі
const RESEND_MS = 30 * 60 * 1000;

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function set(k, v) {
  try { localStorage.setItem(k, String(v)); } catch { /* приватний режим */ }
}

let timer = 0;
let running = false;
let again = false;

/** Після змін — за півтори секунди, щоб серія правок пішла одним запитом. head() — шапка зараз. */
export function scheduleWidget(head, ms = 1500) {
  if (!Bot.botConfig()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { pushWidget(head).catch(() => {}); }, ms);
}

async function pushWidget(head) {
  const cfg = Bot.botConfig();
  if (!cfg || Bot.isBadKey(cfg)) return;
  if (running) { again = true; return; }
  running = true;
  try {
    const body = head();
    const sig = JSON.stringify(body);
    if (sig === get(KEYS.sig) && Date.now() - Number(get(KEYS.last) || 0) < RESEND_MS) return;
    // Сервер ще без /api/widget (404) чи без зв'язку — мовчки, наступна зміна спробує знову
    const res = await fetch(`${cfg.url}/api/widget`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
      body: sig,
    });
    if (!res.ok) return;
    set(KEYS.sig, sig);
    set(KEYS.last, Date.now());
  } finally {
    running = false;
    if (again) { again = false; scheduleWidget(head, 500); }
  }
}

/** Посилання з Налаштувань: є застосунок — передати адресу й ключ, немає — Chrome качає APK. */
export const APK_URL = 'https://github.com/VitaliyLobko/marnotrat-widget/releases/latest/download/marnotrat-widget.apk';
const PACKAGE = 'ua.vitaliylobko.marnotrat.widget';

export function setupLink() {
  const cfg = Bot.botConfig();
  if (!cfg) return null;
  const q = new URLSearchParams({ url: cfg.url, key: cfg.key });
  return `intent://setup?${q}#Intent;scheme=marnotrat-widget;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(APK_URL)};end`;
}
