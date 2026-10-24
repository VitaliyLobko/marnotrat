// Синхронізація через Google Диск: один файл marnotrat-sync.json, спільний для всіх телефонів власника.
// Злиття по записах: перемагає новіший (поле updated); видалення — надгробки в meta, щоб запис не воскрес з іншого телефона.
// Вхід — Google Identity Services, OAuth-клієнт той самий, що в shooting-log і hobby-planner (origin спільний).
// Ключ Диска діє годину й у фоні не продовжується — оновлюємо його з натискання, яке людина й так робить.
import * as Bot from './bot.js';
import { sharedToken, shareToken, dropSharedToken, noteEmail, whoIs } from './google-token.js';
import { locate, readJson, writeJson, syncBotFile } from './drive-files.js';

const CLIENT_ID = '252063766250-9hhqp9hdefccgp508bv983usv5h17lsf.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'marnotrat-sync.json';
const KEY = 'marnotrat:drive';
export const STORES = ['coins', 'ops', 'meta'];
// Надгробки старші — прибираємо: за пів року всі телефони вже синхронізувались
const TOMB_TTL = 180 * 24 * 60 * 60 * 1000;
// Спроба тихо оновити ключ не частіше — інакше вікно Google мелькало б на кожне натискання
const RETRY_MS = 10 * 60 * 1000;

export class AuthError extends Error {}

let conf = load();
let tokenClient = null;
let gisLoading = null;
let authWaiter = null;
let lastTry = 0;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

function store() {
  try { localStorage.setItem(KEY, JSON.stringify(conf)); } catch { /* приватний режим */ }
}

export const syncOn = () => Boolean(conf.enabled);
export const lastSync = () => conf.last ?? null;
/** Свій ключ живий — його; ні — спільний з іншого застосунку автора (вхід там годиться й тут). */
export function tokenValid() {
  if (conf.token && conf.expires > Date.now() + 60_000) return true;
  const s = sharedToken(conf);
  if (!s) return false;
  conf.token = s.token;
  conf.expires = s.expires;
  store();
  return true;
}

// ---------- злиття ----------

export const tombId = (name, id) => `del:${name}:${id}`;
export const isTomb = (m) => m.id.startsWith('del:');

/** Надгробки для видалених записів — кладуться в meta тією ж транзакцією, що й видалення. */
export function tombsFor(changes) {
  const out = [];
  for (const [name, { del = [] }] of Object.entries(changes)) {
    if (name === 'meta') continue;
    for (const id of del) out.push({ id: tombId(name, id), store: name, ref: id });
  }
  return out;
}

/**
 * Злиття двох знімків {coins, ops, meta}: по кожному id — запис з більшим updated;
 * запис, видалений пізніше за свою останню зміну, прибирається; надгробок, старіший за сам запис
 * (запис повернули) чи за 180 днів, — теж: він уже нічого не вирішує. Чиста функція.
 */
export function merge(local, remote, now = Date.now()) {
  const out = {};
  for (const name of STORES) {
    const map = new Map();
    for (const rec of [...(local[name] ?? []), ...(remote[name] ?? [])]) {
      const have = map.get(rec.id);
      if (!have || (rec.updated ?? 0) > (have.updated ?? 0)) map.set(rec.id, rec);
    }
    out[name] = map;
  }
  for (const t of [...out.meta.values()].filter(isTomb)) {
    if (now - (t.updated ?? 0) > TOMB_TTL) { out.meta.delete(t.id); continue; }
    const rec = out[t.store]?.get(t.ref);
    if (!rec) continue;
    if ((rec.updated ?? 0) > (t.updated ?? 0)) out.meta.delete(t.id);
    else out[t.store].delete(t.ref);
  }
  return Object.fromEntries(STORES.map((name) => [name, [...out[name].values()]]));
}

/** Відбиток знімка — щоб не перезаписувати однакове. */
export function stamp(data) {
  return STORES.map((name) => (data[name] ?? []).map((r) => `${r.id}@${r.updated ?? 0}`).sort().join(',')).join('|');
}

// ---------- вхід ----------

function loadGis() {
  gisLoading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) { resolve(); return; }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { gisLoading = null; reject(new Error('Немає зв’язку з Google')); };
    document.head.append(script);
  });
  return gisLoading;
}

function finishAuth(error) {
  const waiter = authWaiter;
  authWaiter = null;
  if (error) waiter?.reject(error);
  else waiter?.resolve();
}

function client() {
  if (tokenClient || !window.google?.accounts?.oauth2) return tokenClient;
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) { finishAuth(new Error(resp.error_description || resp.error)); return; }
      conf.token = resp.access_token;
      conf.expires = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
      shareToken(conf.token, conf.expires, conf.email);
      store();
      finishAuth();
    },
    error_callback: (err) => finishAuth(new Error(err?.type === 'popup_closed' ? 'Вхід скасовано' : (err?.message || 'Не вдалося увійти в Google'))),
  });
  return tokenClient;
}

/** Підвантажити Google заздалегідь: вікно входу має відкритися одразу з натискання, інакше браузер його заблокує. */
export function preload() {
  if (navigator.onLine) loadGis().then(client).catch(() => {});
}

/** Лише з обробника натискання. prompt '' — згоду вже дано: вікно мелькне й закриється саме. */
function requestToken(prompt) {
  const c = client();
  if (!c) {
    preload();
    return Promise.reject(new Error('Google ще завантажується — натисни ще раз за секунду'));
  }
  return new Promise((resolve, reject) => {
    authWaiter = { resolve, reject };
    c.requestAccessToken({ prompt, hint: conf.email || undefined });
  });
}

/** Підключити Диск (з натискання). Далі — syncNow. */
export async function connect() {
  // Увійшли в іншому застосунку автора менш ніж годину тому — вікно Google не потрібне
  if (!tokenValid()) await requestToken(conf.consented ? '' : 'consent');
  conf.enabled = true;
  conf.consented = true;
  store();
}

export function disconnect() {
  // Вхід у Google не відкликаємо: він спільний з іншими застосунками автора — відключається лише цей
  conf = {};
  store();
}

/** Ключ мертвий — оновити з натискання (не частіше RETRY_MS). true — ключ живий. */
export async function refreshByGesture() {
  if (tokenValid()) return true;
  if (!syncOn() || authWaiter || !navigator.onLine || Date.now() - lastTry < RETRY_MS) return false;
  if (navigator.userActivation && !navigator.userActivation.isActive) return false;
  if (!client()) { preload(); return false; }
  lastTry = Date.now();
  await requestToken('');
  return true;
}

/** Ключ з натискання без обмеження частоти — для кнопки «Зберегти зараз». */
export async function ensureToken() {
  if (!tokenValid()) await requestToken('');
}

// ---------- Диск ----------

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${conf.token}`, ...options.headers } });
  if (res.status === 401) {
    dropSharedToken(conf.token);
    conf.token = null;
    store();
    throw new AuthError('Сесія Google скінчилась — натисни «Зберегти зараз» у розділі Google Диск');
  }
  if (!res.ok) throw Object.assign(new Error(`Google Диск відповів ${res.status}`), { status: res.status });
  return res;
}

/** Записати знімок у marnotrat-sync.json. false — інший телефон щойно завів файл: синхронізуватись ще раз, із ним. */
async function upload(fileId, data) {
  const res = await writeJson(api, { id: fileId, name: FILE_NAME, description: 'Марнотрат — дані для синхронізації', content: JSON.stringify(data) });
  conf.fileId = res.id;
  store();
  return res.written;
}

/** Чий це Диск — запам'ятати раз: без пошти спільний ключ з іншого застосунку не підхоплюємо (див. google-token.js). */
async function learnEmail() {
  if (conf.email) return;
  conf.email = await whoIs(conf.token);
  noteEmail(conf.token, conf.email);
  store();
}

/**
 * Один прохід: забрати файл з Диска, злити з локальним, покласти назад, якщо щось нове.
 * local — знімок {coins, ops, meta}; fresh — на цьому телефоні ще нічого свого (взяти Диск як є, без злиття
 * стартових монет — інакше «Готівка» задвоїлась би). Повертає злитий знімок або null, якщо локально нічого не змінилось.
 */
export async function syncNow(local, { fresh = false, envelope = {} } = {}) {
  if (!tokenValid()) throw new AuthError('Потрібно увійти в Google — натисни «Зберегти зараз» у розділі Google Диск');
  await learnEmail();
  const id = await locate(api, FILE_NAME, conf.fileId);
  conf.fileId = id;
  let remote = null;
  if (id) remote = await readJson(api, id);
  if (remote && remote.app !== 'marnotrat') throw new Error('Файл на Диску — не Марнотрат');
  const merged = remote ? (fresh ? merge({}, remote) : merge(local, remote)) : merge(local, {});
  if (!remote || stamp(remote) !== stamp(merged)) {
    // Інший телефон щойно завів файл — злити з ним, а не затерти його
    if (!(await upload(id, { app: 'marnotrat', ...envelope, synced: new Date().toISOString(), ...merged }))) {
      return syncNow(local, { fresh, envelope });
    }
  }
  conf.last = Date.now();
  store();
  // Налаштування бота — не дані Марнотрату: збій тут синхронізацію не валить
  try {
    await syncBotSettings();
  } catch (err) {
    if (err instanceof AuthError) throw err;
  }
  return stamp(local) === stamp(merged) ? null : merged;
}

/** Копія з Диска для «Відновити з Диска»: вміст marnotrat-sync.json або null — файлу ще нема. */
export async function fetchBackup() {
  if (!tokenValid()) await requestToken('');
  const id = await locate(api, FILE_NAME, conf.fileId);
  return id ? readJson(api, id) : null;
}

// ---------- спільні налаштування бота ----------

/**
 * Лише bot-settings.json, без даних: при відкритті й коли бот відкинув ключ — вставлений на іншому пристрої ключ
 * приходить одразу, а не з добовою копією. Ключ Google мертвий — тихо до наступного разу.
 */
let botRoundBusy = null;
export function botRound() {
  if (!syncOn() || !navigator.onLine || !tokenValid()) return Promise.resolve();
  botRoundBusy ??= learnEmail().then(syncBotSettings).catch(() => {}).finally(() => { botRoundBusy = null; });
  return botRoundBusy;
}

/** Адреса й ключ бота — спільний bot-settings.json (drive-files.js): новіший з Диска — сюди, свій новіший — на Диск. */
async function syncBotSettings() {
  conf.botFileId = await syncBotFile(api, conf.botFileId, {
    mine: Bot.sharedConfig(),
    isBad: Bot.isBadKey,
    apply: (theirs) => {
      Bot.setSharedConfig(theirs.url, theirs.key, theirs.updated);
      window.dispatchEvent(new Event('bot-config'));
    },
  });
  store();
}
