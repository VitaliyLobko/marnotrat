// Синхронізація через Google Диск: один файл marnotrat-sync.json, спільний для всіх телефонів власника.
// Злиття по записах: перемагає новіший (поле updated); видалення — надгробки в meta, щоб запис не воскрес з іншого телефона.
// Вхід — Google Identity Services, OAuth-клієнт той самий, що в shooting-log і hobby-planner (origin спільний).
// Ключ Диска діє годину й у фоні не продовжується — оновлюємо його з натискання, яке людина й так робить.
import * as Bot from './bot.js';

const CLIENT_ID = '252063766250-9hhqp9hdefccgp508bv983usv5h17lsf.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FILE_NAME = 'marnotrat-sync.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const KEY = 'marnotrat:drive';
const STORES = ['coins', 'ops', 'meta'];
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
export const tokenValid = () => Boolean(conf.token) && conf.expires > Date.now() + 60_000;

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
 * запис, видалений пізніше за свою останню зміну, прибирається. Чиста функція.
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
    if (rec && (rec.updated ?? 0) <= (t.updated ?? 0)) out[t.store].delete(t.ref);
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
  await requestToken(conf.consented ? '' : 'consent');
  conf.enabled = true;
  conf.consented = true;
  store();
}

export function disconnect() {
  if (conf.token) window.google?.accounts?.oauth2?.revoke?.(conf.token, () => {});
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

/** Ключ з натискання без обмеження частоти — для кнопки «Синхронізувати». */
export async function ensureToken() {
  if (!tokenValid()) await requestToken('');
}

// ---------- Диск ----------

async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${conf.token}`, ...options.headers } });
  if (res.status === 401) {
    conf.token = null;
    store();
    throw new AuthError('Сесія Google скінчилась — натисни «Синхронізувати»');
  }
  if (!res.ok) throw new Error(`Google Диск відповів ${res.status}`);
  return res;
}

/** Файл синхронізації: збережений id, якщо файл живий; інакше — пошук за назвою (drive.file бачить лише свої файли). */
async function findFile() {
  if (conf.fileId) {
    try {
      const meta = await (await api(`${DRIVE}/files/${conf.fileId}?fields=id,trashed`)).json();
      if (!meta.trashed) return conf.fileId;
    } catch (err) {
      if (err instanceof AuthError) throw err;
    }
  }
  const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
  const { files } = await (await api(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id)`)).json();
  conf.fileId = files?.[0]?.id ?? null;
  store();
  return conf.fileId;
}

/** Один файл, щоразу перезаписується: попередні версії Google Диск тримає сам (до 30 днів). */
async function upload(fileId, data) {
  const content = JSON.stringify(data);
  if (fileId) {
    await api(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content,
    });
    return;
  }
  const boundary = `mt${Date.now()}`;
  const body = [
    `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
    JSON.stringify({ name: FILE_NAME, mimeType: 'application/json', description: 'Марнотрат — дані для синхронізації' }),
    `--${boundary}`, 'Content-Type: application/json', '', content, `--${boundary}--`,
  ].join('\r\n');
  const created = await (await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
  })).json();
  conf.fileId = created.id;
  store();
}

/**
 * Один прохід: забрати файл з Диска, злити з локальним, покласти назад, якщо щось нове.
 * local — знімок {coins, ops, meta}; fresh — на цьому телефоні ще нічого свого (взяти Диск як є, без злиття
 * стартових монет — інакше «Готівка» задвоїлась би). Повертає злитий знімок або null, якщо локально нічого не змінилось.
 */
export async function syncNow(local, { fresh = false, envelope = {} } = {}) {
  if (!tokenValid()) throw new AuthError('Потрібно увійти в Google — натисни «Синхронізувати»');
  const id = await findFile();
  let remote = null;
  if (id) remote = await (await api(`${DRIVE}/files/${id}?alt=media`)).json();
  if (remote && remote.app !== 'marnotrat') throw new Error('Файл на Диску — не Марнотрат');
  const merged = remote ? (fresh ? merge({}, remote) : merge(local, remote)) : merge(local, {});
  if (!remote || stamp(remote) !== stamp(merged)) {
    await upload(id, { app: 'marnotrat', ...envelope, synced: new Date().toISOString(), ...merged });
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

// ---------- спільні налаштування бота ----------

// Адреса й ключ Telegram-бота для всіх застосунків автора (Хобі-план, Вага, Марнотрат): OAuth-клієнт один,
// тож drive.file показує цей файл кожному з них. Перемагає новіший запис (поле updated).
const BOT_FILE = 'bot-settings.json';
const botStamp = (x) => Number(x?.updated) || 0;

/** Звірити адресу й ключ бота з bot-settings.json: новіший з Диска — сюди, свій новіший чи файлу нема — на Диск. */
async function syncBotSettings() {
  let fileId = conf.botFileId;
  if (fileId) {
    try {
      const meta = await (await api(`${DRIVE}/files/${fileId}?fields=id,trashed`)).json();
      if (meta.trashed) fileId = null;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      fileId = null;
    }
  }
  if (!fileId) {
    const q = encodeURIComponent(`name='${BOT_FILE}' and trashed=false`);
    const { files } = await (await api(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id)`)).json();
    fileId = files?.[0]?.id ?? null;
  }
  const remote = fileId ? await (await api(`${DRIVE}/files/${fileId}?alt=media`)).json() : null;
  const mine = Bot.sharedConfig();
  const theirs = remote?.url && remote?.key ? remote : null;
  if (theirs && (!mine || botStamp(theirs) > mine.updated)) {
    Bot.setSharedConfig(theirs.url, theirs.key, botStamp(theirs));
    window.dispatchEvent(new Event('bot-config'));
  } else if (mine && (!theirs || mine.updated > botStamp(theirs))) {
    const content = JSON.stringify({ app: 'bot-settings', format: 1, url: mine.url, key: mine.key, updated: mine.updated || Date.now() });
    if (fileId) {
      await api(`${UPLOAD}/files/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content });
    } else {
      const boundary = `bs${Date.now()}`;
      const body = [
        `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '',
        JSON.stringify({ name: BOT_FILE, mimeType: 'application/json', description: 'Telegram-бот: адреса й ключ для застосунків' }),
        `--${boundary}`, 'Content-Type: application/json', '', content, `--${boundary}--`,
      ].join('\r\n');
      fileId = (await (await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      })).json()).id;
    }
  }
  conf.botFileId = fileId;
  store();
}
