// Марнотрат: головна з монетами, екран суми, стрічка, звіти, налаштування.
import { loadAll, write, uid, replaceAll, putFile, getFile, dropFilesExcept } from './db.js';
import { slAvailable, readJournal, addRecord, patchRecord, removeRecord, unlinkJournal } from './journal.js';
import * as M from './model.js';
import * as Sync from './sync.js';
import * as Bot from './bot.js';
import * as Widget from './widget.js';
import { cursors, exchange } from './cloud.js';
import { CHANGES, changesSince } from './changes.js';
import * as Csv from './csv.js';
import { initLock, lockOn, lockDelay, lockAvailable, enableLock, disableLock, setLockDelay, LOCK_DELAYS } from './lock.js';
import { $, h, icon, hasIcon, toast, sheet, closeSheet, chips, swipeStep, vibrate } from './ui.js';

const state = { coins: [], ops: [], meta: [] };
let view = 'main';
// Стрічка однієї монети (тап по монеті) — її id; інакше null
let feedCoin = null;
let feedDays = 60;
// Стрічка: скільки днів малюємо одразу і скільки — за кожну наступну порцію
const FEED_FIRST = 8;
const FEED_CHUNK = 10;
// Порціями — лише коли стрічку щойно відкрили чи відфільтрували: після збереження чи «Показати ще» сторінка
// мусить одразу мати повну висоту, інакше браузер зрізав би прокрутку і список стрибнув би вгору
let feedLazy = false;
// Пошук і тип у стрічці: живуть, поки застосунок відкритий
let feedQuery = '';
let feedType = 'all';
let reportKind = 'expense';
// Період звіту — ключ «РРРР-ММ» місяця, у якому він починається (див. periodOf); стан ще не завантажено — календарний
let reportMonth = M.monthOf(M.ymd());
let reportPick = null;
// Звіт «Загальний»: свій період і рахунки (фільтр), розбивка за тегами замість монет
const reportFilter = { from: '', to: '', accounts: null };
let reportTags = false;
let dayDate = M.ymd();
// Рядок «Сьогодні» на головній згорнутий, поки його не потягнуть униз
let todayOpen = false;
// Оновлення застосунку: реєстрація service worker і нова версія, що чекає
const upd = { reg: null, worker: null, checked: '' };

// Ключі localStorage — з префіксом: origin спільний із shooting-log, weight-log, hobby-planner
const PREFIX = 'marnotrat:';

function remember(key, value) {
  try { localStorage.setItem(PREFIX + key, value ?? ''); } catch { /* приватний режим */ }
}

function recall(key) {
  try { return localStorage.getItem(PREFIX + key); } catch { return null; }
}

// ---------- кеш підрахунків ----------

// save() і синхронізація не правлять масиви state, а підміняють їх — тож кеш живий, доки ті самі масиви
let memo = { ops: null, coins: null, meta: null, data: {} };

function cached(key, build) {
  const { ops, coins, meta } = state;
  if (memo.ops !== ops || memo.coins !== coins || memo.meta !== meta) memo = { ops, coins, meta, data: {} };
  if (!(key in memo.data)) memo.data[key] = build();
  return memo.data[key];
}

const coin = (id) => cached('byId', () => {
  const byId = new Map();
  for (const c of state.coins) if (!byId.has(c.id)) byId.set(c.id, c);
  return byId;
}).get(id);
// Режим «Редагування» головної (довге натискання на монету): ✕ і ✎ на монетах, перестановка перетягуванням
const editing = () => view === 'edit';
const onMain = () => view === 'main' || view === 'edit';
const MISSING = { name: 'Видалено', kind: 'expense', currency: 'UAH', icon: 'box' };
const coinOr = (id) => coin(id) ?? MISSING;
const coinsOf = (kind) => state.coins.filter((c) => c.kind === kind && !c.archived).sort((a, b) => a.order - b.order);

/** Курси до гривні: { USD, EUR } — з НБУ раз на день або свої. */
const DEFAULT_RATES = { USD: 41.5, EUR: 48 };
const ratesMeta = () => state.meta.find((m) => m.id === 'rates') ?? { id: 'rates', ...DEFAULT_RATES, date: '', manual: false };
const rate = (cur) => (cur === 'UAH' ? 1 : ratesMeta()[cur] || DEFAULT_RATES[cur] || 1);
const toUah = (v, cur) => v * rate(cur);

/** Що операція робить: income — дохід на рахунок, expense — витрата, transfer — між рахунками. */
function opType(op) {
  if (coinOr(op.from).kind === 'income') return 'income';
  if (coinOr(op.to).kind === 'expense') return 'expense';
  return 'transfer';
}
// Сума в валюті «куди»: у різних валютах її вводять окремо
const amountIn = (op) => op.amountTo ?? op.amount;

async function save(changes, { redraw = true } = {}) {
  // Видалення лишає надгробок — інакше синхронізація повернула б запис з іншого телефона
  const tombs = Sync.tombsFor(changes);
  if (tombs.length) changes = { ...changes, meta: { ...changes.meta, put: [...(changes.meta?.put ?? []), ...tombs] } };
  await write(changes);
  for (const [name, { put = [], del = [] }] of Object.entries(changes)) {
    const ids = new Set([...del, ...put.map((x) => x.id)]);
    state[name] = [...state[name].filter((x) => !ids.has(x.id)), ...put];
  }
  if (redraw) render();
  scheduleSync();
  scheduleCloud();
  Bot.scheduleBot(botPayload);
}

// ---------- підсумки в Telegram (бот Хобі-плану) ----------

// Скільки днів віддаємо боту: тиждень, минулий тиждень для порівняння й запас на день без зв'язку
const BOT_DAYS = 35;

/**
 * Що бачить бот: за кожен день від from — витрати й доходи в гривнях і витрати за категоріями (найбільші спершу),
 * плюс бюджет поточного місяця обліку, як «Лишилось» у шапці.
 */
function botPayload() {
  const from = M.addDays(M.ymd(), -(BOT_DAYS - 1));
  const days = new Map();
  for (const op of state.ops) {
    if (op.date < from) continue;
    const t = opType(op);
    if (t === 'transfer') continue;
    let d = days.get(op.date);
    if (!d) days.set(op.date, (d = { date: op.date, expense: 0, income: 0, cats: new Map() }));
    if (t === 'income') { d.income += toUah(op.amount, coinOr(op.from).currency); continue; }
    const c = coinOr(op.to);
    const v = toUah(amountIn(op), c.currency);
    d.expense += v;
    d.cats.set(c.name, (d.cats.get(c.name) ?? 0) + v);
  }
  const round = (v) => M.round2(v);
  const plan = planTotal();
  return {
    from,
    days: [...days.values()].map((d) => ({
      date: d.date, expense: round(d.expense), income: round(d.income),
      cats: [...d.cats].sort((a, b) => b[1] - a[1]).map(([name, v]) => [name, round(v)]),
    })),
    budget: plan ? { plan: round(plan), left: round(plan - totals(currentPeriod()).expense) } : null,
    big: bigOps(from),
    noSpend: { date: M.ymd(), streak: freeStreak(M.ymd()), days: [...Array(BOT_DAYS).keys()].map((i) => M.addDays(from, i)).filter(isFreeDay) },
  };
}

/**
 * Великі витрати від from для бота: категорія, сума в гривнях і в скільки разів більша за звичайну покупку
 * в цій категорії за 90 днів до неї. Рахунків і коментарів бот не отримує.
 */
function bigOps(from) {
  const out = [];
  for (const op of state.ops) {
    if (op.date < from || opType(op) !== 'expense' || isRegular(op)) continue;
    const v = expenseUah(op);
    if (!isBig(v)) continue;
    const since = M.addDays(op.date, -90);
    let sum = 0;
    let n = 0;
    for (const o of state.ops) {
      if (o.to !== op.to || o.id === op.id || o.date < since || o.date > op.date) continue;
      sum += expenseUah(o);
      n += 1;
    }
    out.push({ id: op.id, date: op.date, cat: coinOr(op.to).name, v: M.round2(v), ratio: n ? M.round2(v / (sum / n)) : null });
  }
  return out.sort((a, b) => b.v - a.v).slice(0, 20);
}

/** Бот відкидає ключ — на головній: інакше операції тихо не їдуть на інші телефони. */
function keyNote() {
  if (!Bot.keyProblem()) return null;
  return h('div', { class: 'key-note', role: 'alert' },
    h('b', {}, 'Ключ доступу не підходить'),
    h('span', {}, ' — операції не йдуть на інші телефони. Візьми новий ключ командою /key у Telegram-боті й встав у будь-якому застосунку: Хобі-план, Вага чи тут. '),
    h('button', { type: 'button', class: 'btn primary', onClick: () => { remember('fold-sync', 'open'); go('settings'); } }, 'Вставити ключ'));
}

/** Адреса сервера й ключ доступу: вставлені тут, у Хобі-плані чи Вазі на цьому телефоні — одні на всіх. */
function botKeyForm(cfg) {
  const url = h('input', { type: 'url', placeholder: 'https://….workers.dev', value: cfg?.url ?? '' });
  const key = h('input', { type: 'password', placeholder: 'команда /key у Telegram-боті', value: cfg?.key ?? '' });
  const save = () => {
    const u = url.value.trim();
    const k = key.value.trim();
    if (!u.startsWith('https://') || !k) { toast('Вкажи адресу https://… і ключ'); return; }
    Bot.setSharedConfig(u, k);
    cloud.error = '';
    scheduleCloud(0);
    Bot.scheduleBot(botPayload, 0);
    toast('Ключ збережено — перевіряю');
    render();
  };
  const form = h('div', { class: 'form' },
    h('label', {}, 'Адреса сервера', url),
    h('label', {}, 'Ключ доступу', key),
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn primary', onClick: save }, icon('check'), 'Зберегти'),
      cfg ? h('button', { type: 'button', class: 'btn', onClick: () => { Bot.disconnect(); toast('Синхронізацію вимкнено лише тут'); render(); } }, icon('close'), 'Вимкнути') : null));
  return form;
}

const fmtWhen = (t) => new Date(t).toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** Пояснення, яке потрібне раз, — згорнуте під «Докладніше», щоб картка читалась з одного погляду. */
const moreText = (...lines) => h('details', { class: 'about-more set-more' }, h('summary', {}, 'Докладніше'),
  h('div', { class: 'muted small' }, lines.map((t) => h('p', {}, t))));

/**
 * «Синхронізація»: стан обміну й «Обмінятися». Працює — адреса й ключ сховані під «Адреса й ключ»;
 * не ввімкнено чи ключ не підходить — форма одразу відкрита.
 */
function botCard() {
  const cfg = Bot.botConfig();
  const synced = cloudCur.last();
  const bad = Bot.keyProblem() || Boolean(cloud.error);
  const state = Bot.keyProblem() ? 'Ключ доступу не підходить — візьми новий командою /key у Telegram-боті й встав нижче.'
    : !cfg ? 'Не ввімкнено — монети й операції лише на цьому телефоні.'
      : cloud.error ? `Помилка: ${cloud.error}.` : synced ? `Обмін: ${fmtWhen(synced)}` : 'Обміну ще не було.';
  const form = botKeyForm(cfg);
  const open = !cfg || Bot.keyProblem();
  return h('section', { class: 'card set-card' },
    h('h2', {}, 'База на сервері'),
    h('p', { class: bad ? 'small error-text' : 'muted small' }, state),
    cfg ? h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn', onClick: () => runCloud({ loud: true }) }, icon('refresh'), 'Обмінятися')) : null,
    open ? form : h('details', { class: 'about-more set-more' }, h('summary', {}, 'Адреса й ключ'), form),
    moreText(
      'Монети й операції лежать у спільній базі на сервері — однакові на всіх телефонах; без інтернету все піде пізніше.',
      'Ключ доступу дає команда /key у Telegram-боті; досить вставити в одному застосунку — Хобі-план, Вага чи тут.'));
}

/** «Telegram-бот · підсумки»: гроші у вечірньому підсумку бота Хобі-плану. Без синхронізації — картки нема. */
function telegramCard() {
  if (!Bot.botConfig()) return null;
  const on = Bot.botOn();
  const last = Bot.lastSent();
  return h('section', { class: 'card set-card' },
    h('h2', {}, 'Підсумки в Telegram'),
    chips([['on', 'Увімкнено'], ['off', 'Вимкнено']], on ? 'on' : 'off', (v) => {
      Bot.setBotOn(v === 'on');
      if (v === 'on') Bot.scheduleBot(botPayload, 0);
      render();
    }),
    h('p', { class: Bot.lastError() && on ? 'small error-text' : 'muted small' }, on
      ? (Bot.lastError() ? `Помилка: ${Bot.lastError()}` : last ? `Надіслано ${fmtWhen(last)}` : 'Ще не надсилалось')
      : 'Гроші у вечірній підсумок бота не потраплять.'),
    on ? moreText(
      'Суми йдуть самі після кожної зміни, а гроші приходять у вечірньому підсумку бота. Час підсумку — у Хобі-плані.',
      'Боту йдуть лише суми за дні й категорії та бюджет місяця — без операцій і коментарів.') : null);
}

// ---------- синхронізація з Google Диском ----------

const snapshot = () => ({ coins: state.coins, ops: state.ops, meta: state.meta });
const sync = { timer: 0, busy: false, again: false, error: '' };

/** Після кожної зміни — за дві секунди, щоб серія правок пішла одним файлом. */
function scheduleSync() {
  if (!Sync.syncOn()) return;
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => runSync(), 2000);
}

// Підключено бота — дані між телефонами возить його база, а Диск раз на день зберігає копію
const BACKUP_EVERY = 24 * 60 * 60 * 1000;

/** Один прохід синхронізації. gesture — викликано з натискання: можна оновити ключ Google. */
async function runSync({ gesture = false, loud = false } = {}) {
  if (!Sync.syncOn() || !navigator.onLine) return;
  if (!loud && Bot.botConfig() && Date.now() - (Sync.lastSync() ?? 0) < BACKUP_EVERY) { Sync.botRound(); return; }
  if (sync.busy) { sync.again = true; return; }
  sync.busy = true;
  try {
    if (loud) await Sync.ensureToken();
    else if (!Sync.tokenValid() && !(gesture && await Sync.refreshByGesture())) return;
    // Свого на цьому телефоні ще нічого — беремо Диск як є, без злиття стартових монет
    const fresh = !Sync.lastSync() && !state.ops.length;
    const merged = await Sync.syncNow(snapshot(), { fresh, envelope: { version: self.APP_VERSION } });
    sync.error = '';
    if (merged) {
      // Поки ходили на Диск, тут могли щось змінити — зливаємо ще раз зі свіжим станом
      const final = fresh ? merged : Sync.merge(snapshot(), merged);
      noteDroppedTombs(state.meta, final.meta);
      await replaceAll(final);
      Object.assign(state, final);
      await fixTags();
      if (Sync.stamp(final) !== Sync.stamp(merged)) sync.again = true;
      render();
    } else if (view === 'settings') render();
    if (loud) toast('Синхронізовано з Google Диском');
  } catch (err) {
    sync.error = err.message;
    if (loud) toast(err.message);
    if (view === 'settings') render();
  } finally {
    sync.busy = false;
    if (sync.again) { sync.again = false; scheduleSync(); }
    refreshChip();
  }
}

// ---------- дані через базу бота (Cloudflare D1) ----------

// Надгробки, які злиття викинуло (запис повернули, минуло 180 днів): у базі їх треба прибрати окремо,
// інакше лишаються там назавжди й їдуть на кожен новий телефон. { id: коли викинули }
const DROPS_KEY = 'cloud-drops';

function readDrops() {
  try { return JSON.parse(recall(DROPS_KEY) || '{}'); } catch { return {}; }
}

/** before — надгробки, що були (тут і з бази), after — що лишились після злиття. */
function noteDroppedTombs(before, after) {
  const kept = new Set(after.filter(Sync.isTomb).map((m) => m.id));
  const drops = readDrops();
  let added = 0;
  for (const m of before) {
    if (!Sync.isTomb(m) || kept.has(m.id) || m.id in drops) continue;
    drops[m.id] = Date.now();
    added += 1;
  }
  if (added) remember(DROPS_KEY, JSON.stringify(drops));
  return added;
}

// Монети, операції й meta (з надгробками del:*) їздять між телефонами через базу бота Хобі-плану тим самим
// ключем, що й підсумки. Злиття те саме, що з Диском (Sync.merge): перемагає новіший запис, надгробок — старіший.
const CLOUD = 'marnotrat';
const cloudCur = cursors(CLOUD);
const cloud = { timer: 0, busy: false, again: false, error: '' };

function scheduleCloud(ms = 2000) {
  if (!Bot.botConfig()) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(() => runCloud(), ms);
}

/** Один обмін з базою бота. Без мережі — тихо: змінене поїде наступного разу (позначки не зсуваються). */
async function runCloud({ loud = false } = {}) {
  const cfg = Bot.botConfig();
  if (!cfg) return;
  if (cloud.busy) { cloud.again = true; return; }
  cloud.busy = true;
  try {
    // Свого на цьому телефоні ще нічого — спершу взяти з бота, без стартових монет (інакше «Готівка» задвоїлась би)
    const fresh = !cloudCur.last() && !state.ops.length;
    const records = Sync.STORES.flatMap((store) => state[store].map((r) => ({ store, id: r.id, data: r, updated: r.updated ?? 0 })));
    // Викинуті надгробки — у базу як видалені; той самий id знову надгробок (видалили вдруге) — не чіпаємо
    const live = new Set(state.meta.filter(Sync.isTomb).map((m) => m.id));
    const drops = Object.entries(readDrops()).filter(([id]) => !live.has(id));
    records.push(...drops.map(([id, at]) => ({ store: 'meta', id, data: null, updated: at, deleted: true })));
    let res;
    try {
      res = await exchange({ url: cfg.url, key: cfg.key, app: CLOUD, prefix: CLOUD, records, skipPush: fresh });
    } catch (err) {
      if (err.status === 401) {
        Bot.markBad(cfg);
        // Є інший ключ, якого бот ще не відкидав (Хобі-план, Диск) — одразу пробуємо його; ні — шукаємо на Диску
        if (Bot.botConfig()) cloud.again = true;
        else Sync.botRound();
        render();
      }
      throw err;
    }
    Bot.markOk(cfg);
    const { rows, commit } = res;
    const remote = Object.fromEntries(Sync.STORES.map((name) => [name, []]));
    for (const r of rows) if (!r.deleted && r.data?.id === r.id && remote[r.store]) remote[r.store].push(r.data);
    const took = fresh && rows.length > 0 && !state.ops.length;
    // Поки ходили до бота, тут могли щось змінити — зливаємо зі свіжим станом
    const merged = took ? Sync.merge({}, remote) : Sync.merge(snapshot(), remote);
    if (noteDroppedTombs([...state.meta, ...remote.meta], merged.meta)) cloud.again = true;
    if (Sync.stamp(merged) !== Sync.stamp(snapshot())) {
      await replaceAll(merged);
      Object.assign(state, merged);
      await fixTags();
      render();
    }
    // Новий телефон, а в боті порожньо — стартові монети лишаються й поїдуть наступним обміном
    commit(!fresh || took);
    // Видалення надгробків пішли в базу — більше не пам'ятаємо їх (крім викинутих щойно, під час обміну)
    if (!fresh && drops.length) {
      const left = readDrops();
      for (const [id, at] of drops) if (left[id] === at) delete left[id];
      remember(DROPS_KEY, JSON.stringify(left));
    }
    if (fresh && !took) cloud.again = true;
    cloud.error = '';
    if (loud) toast('Синхронізовано');
  } catch (err) {
    cloud.error = err.message === 'key' ? 'Ключ доступу не підходить — візьми новий командою /key у Telegram-боті'
      : err instanceof TypeError ? 'Немає зв’язку з сервером' : err.message;
    if (loud) toast(cloud.error);
  } finally {
    cloud.busy = false;
    if (cloud.again) { cloud.again = false; scheduleCloud(500); }
    if (view === 'settings' && !document.activeElement?.matches('input')) render();
    else refreshChip();
  }
}

// ---------- значок синхронізації в шапці: як у Хобі-плані й Вазі ----------

const shortWhen = (ms) => {
  const d = new Date(ms);
  return M.ymd(d) === M.ymd()
    ? d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
};

/** Основна синхронізація — база на сервері, без неї — Google Диск: idle «✓ час», syncing, offline, key, error. */
function chipState() {
  if (Bot.keyProblem()) return { st: 'key', text: 'ключ', title: 'Ключ доступу не підходить' };
  const offline = { st: 'offline', text: 'офлайн', title: 'Немає інтернету — синхронізація пройде, щойно з’явиться зв’язок' };
  if (Bot.botConfig()) {
    if (!navigator.onLine) return offline;
    if (cloud.error) return { st: 'error', text: 'помилка', title: cloud.error };
    const at = cloudCur.last();
    if (!at) return { st: 'syncing', text: '…', title: 'Синхронізую…' };
    return { st: 'idle', text: `✓ ${shortWhen(at)}`, title: `Синхронізовано: ${shortWhen(at)}` };
  }
  if (!Sync.syncOn()) return null;
  if (!navigator.onLine) return offline;
  if (sync.error) return { st: 'error', text: 'помилка', title: sync.error };
  const at = Sync.lastSync();
  if (!at) return { st: 'syncing', text: '…', title: 'Синхронізую з Google Диском…' };
  return { st: 'idle', text: `✓ ${shortWhen(at)}`, title: `Google Диск: ${shortWhen(at)}` };
}

function syncChip() {
  const s = chipState();
  if (!s) return null;
  const onClick = () => {
    if (s.st === 'key') { remember('fold-sync', 'open'); go('settings'); return; }
    if (s.st === 'offline') { toast(s.title); return; }
    if (Bot.botConfig()) runCloud({ loud: true }); else runSync({ loud: true });
  };
  return h('button', { type: 'button', id: 'sync-chip', class: `sync-chip ${s.st}`, title: s.title, 'aria-label': `Синхронізація: ${s.title}`, onClick },
    icon(s.st === 'key' ? 'warn' : 'refresh'), h('span', { class: 'chip-text' }, s.text));
}

/** Стан змінився без перемальовування сторінки — оновити лише шапку. */
function refreshChip() {
  if (view !== 'edit') topbar();
}

// Сьогоднішні витрати й залишок бюджету — для «Сьогодні» в Хобі-плані на цьому ж пристрої (спільний localStorage сайту)
const MONEY_SHARE = 'vitaliylobko:money-today';

/** Витрати за день (сьогодні, якщо не вказано) в гривнях. */
function todaySpent(date = M.ymd()) {
  let spent = 0;
  for (const op of state.ops) {
    if (op.date !== date || opType(op) !== 'expense') continue;
    spent += toUah(amountIn(op), coinOr(op.to).currency);
  }
  return spent;
}

function shareMoney() {
  const plan = planTotal();
  const v = JSON.stringify({ date: M.ymd(), spent: M.round2(todaySpent()), left: plan ? M.round2(plan - totals(currentPeriod()).expense) : null });
  try { if (localStorage.getItem(MONEY_SHARE) !== v) localStorage.setItem(MONEY_SHARE, v); } catch { /* приватний режим */ }
}

// ---------- віджет на Android ----------

/**
 * Шапка для віджета: те, що на головній, і трохи більше — день періоду, гроші на день, сьогодні, заплановане.
 * at — найновіша зміна даних: телефон, що ще не підтягнув чужі операції, не перетре на сервері свіжішу шапку.
 */
function widgetHead() {
  const cur = currentPeriod();
  const [from, to] = periodRange(cur);
  const dayNo = (d) => Math.round((M.parseYmd(d) - M.parseYmd(from)) / 864e5) + 1;
  const plan = planTotal();
  const p = plannedLeft();
  const r = M.round2;
  let at = 0;
  for (const list of [state.ops, state.coins, state.meta]) for (const x of list) at = Math.max(at, Number(x.updated) || 0);
  const month = M.monthTitle(cur).split(' ')[0];
  return {
    at,
    period: startDay() === 1 ? month[0].toUpperCase() + month.slice(1) : periodTitle(cur).replace(/\.\d{4}$/, ''),
    day: dayNo(M.ymd()), days: dayNo(to),
    balance: r(totalBalance()), expense: r(totals(cur).expense), today: r(todaySpent()),
    plan: r(plan), left: r(plan - totals(cur).expense), perDay: perDayLeft()?.perDay ?? 0,
    planned: r(p.sum), plannedN: p.n, next: p.next,
    // Стовпчики тижня у віджеті 4×2: сім днів, останній — сьогодні
    week: [...Array(7).keys()].map((i) => {
      const date = M.addDays(M.ymd(), i - 6);
      return { date, v: r(todaySpent(date)) };
    }),
  };
}

/** Заплановані витрати до кінця періоду разом із простроченими непроведеними: сума в гривнях, скільки, найближча. */
function plannedLeft() {
  const today = M.ymd();
  const end = periodRange(currentPeriod())[1];
  const doneBy = new Map();
  for (const o of state.ops) {
    if (o.fromRule == null) continue;
    if (!doneBy.has(o.fromRule)) doneBy.set(o.fromRule, new Set());
    doneBy.get(o.fromRule).add(o.ruleDate);
  }
  let sum = 0;
  let n = 0;
  let next = null;
  for (const rule of state.ops) {
    if (!rule.repeat?.every || opType(rule) !== 'expense') continue;
    const done = doneBy.get(rule.id) ?? new Set();
    const skip = new Set(rule.repeat.skip ?? []);
    const dates = M.repeatDates(rule.date, rule.repeat.every, rule.repeat.until, end).filter((x) => x <= end && !done.has(x) && !skip.has(x));
    // Прострочені — як у «В планах» стрічки: не більше PLAN_BACKLOG останніх
    const due = dates.filter((x) => x <= today).slice(-PLAN_BACKLOG);
    const v = expenseUah(rule);
    for (const date of [...due, ...dates.filter((x) => x > today)]) {
      sum += v;
      n += 1;
      if (!next || date < next.date) next = { date, name: coinOr(rule.to).name, v: M.round2(v) };
    }
  }
  return { sum, n, next };
}

/** Звична пара монет для кнопок віджета «Витрата» й «Дохід» — найчастіша за 90 днів; нема — перші за порядком. */
function usualPair(type) {
  const since = M.addDays(M.ymd(), -90);
  const live = (id) => state.coins.some((c) => c.id === id && !c.archived);
  const count = new Map();
  for (const op of state.ops) {
    if (op.date < since || opType(op) !== type || !live(op.from) || !live(op.to)) continue;
    const k = `${op.from}\n${op.to}`;
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  if (best) {
    const [from, to] = best[0].split('\n');
    return { from, to };
  }
  const [src, dst] = type === 'income' ? [coinsOf('income')[0], coinsOf('account')[0]] : [coinsOf('account')[0], coinsOf('expense')[0]];
  return src && dst ? { from: src.id, to: dst.id } : null;
}

/** «Віджет на головний екран»: є застосунок — передати адресу й ключ, немає — Chrome качає APK. */
function widgetCard() {
  const link = Widget.setupLink();
  return h('section', { class: 'card set-card' },
    h('h2', {}, 'Віджет на головний екран'),
    h('p', { class: 'muted small' }, link
      ? 'На день, сьогодні, баланс і тиждень — на головному екрані Android.'
      : 'Віджет бере цифри з бази на сервері — спершу ввімкни синхронізацію.'),
    link ? h('div', { class: 'btn-grid' },
      h('a', { class: 'btn primary', href: link }, icon('smartphone'), 'Встановити'),
      h('a', { class: 'btn', href: Widget.APK_URL }, icon('archive'), 'APK файлом')) : null,
    link ? moreText(
      'Перший тап завантажить застосунок віджета — дозволь Chrome встановлення. Другий — підключить його до сервера й запропонує додати віджет 4×1 чи 4×2.',
      'Цифри оновлюються раз на 15 хвилин і кнопкою ⟳; Марнотрат надсилає їх після кожного запису.') : null);
}

// ---------- підрахунки ----------

/**
 * Рухи монет одним проходом: id → { delta — усе прийшло мінус усе пішло; months — за періодом обліку
 * { in, out, n — скільки операцій прийшло } }. Порядок додавання — як у state.ops, тож суми ті самі.
 */
const moves = () => cached('moves', () => {
  const out = new Map();
  const of = (id) => {
    let m = out.get(id);
    if (!m) out.set(id, (m = { delta: 0, months: new Map() }));
    return m;
  };
  const month = (m, ym) => {
    let x = m.months.get(ym);
    if (!x) m.months.set(ym, (x = { in: 0, out: 0, n: 0 }));
    return x;
  };
  for (const op of state.ops) {
    const ym = periodOf(op.date);
    const dst = of(op.to);
    dst.delta += amountIn(op);
    const x = month(dst, ym);
    x.in += amountIn(op);
    x.n += 1;
    const src = of(op.from);
    src.delta -= op.amount;
    month(src, ym).out += op.amount;
  }
  return out;
});

function balance(acc, ops = state.ops) {
  if (ops === state.ops) return M.round2((acc.start || 0) + (moves().get(acc.id)?.delta ?? 0));
  let v = acc.start || 0;
  for (const op of ops) {
    if (op.to === acc.id) v += amountIn(op);
    if (op.from === acc.id) v -= op.amount;
  }
  return M.round2(v);
}

// ---------- період обліку: місяць від дня N (наприклад, від зарплати) ----------

/** День, з якого починається обліковий місяць: 1–28, у meta — спільний для всіх телефонів. */
const startDay = () => state.meta.find((m) => m.id === 'period')?.day ?? 1;
const dd = (n) => String(n).padStart(2, '0');

/** Ключ періоду для дати: місяць, у якому період почався. День 1 — звичайний календарний місяць. */
function periodOf(date) {
  const ym = M.monthOf(date);
  return Number(date.slice(8, 10)) >= startDay() ? ym : M.addMonths(ym, -1);
}

/** Межі періоду включно: з N-го цього місяця до (N−1)-го наступного. */
function periodRange(ym) {
  const n = startDay();
  return [`${ym}-${dd(n)}`, M.addDays(`${M.addMonths(ym, 1)}-${dd(n)}`, -1)];
}

const currentPeriod = () => periodOf(M.ymd());

/** «жовтень 2026» для календарного місяця; зі свого дня — «05.10 – 04.11.2026». */
function periodTitle(ym) {
  if (startDay() === 1) return M.monthTitle(ym);
  const [lo, hi] = periodRange(ym);
  const f = (x) => `${x.slice(8, 10)}.${x.slice(5, 7)}`;
  return `${f(lo)} – ${f(hi)}.${hi.slice(0, 4)}`;
}

/** Яка частка періоду минула на кінець сьогоднішнього дня. */
function periodElapsed(ym) {
  const [lo, hi] = periodRange(ym);
  const day = 24 * 60 * 60 * 1000;
  const len = (M.parseYmd(hi) - M.parseYmd(lo)) / day + 1;
  return Math.min(1, Math.round((M.parseYmd(M.ymd()) - M.parseYmd(lo)) / day + 1) / Math.round(len));
}

const inMonth = (op, ym) => {
  const [lo, hi] = periodRange(ym);
  return op.date >= lo && op.date <= hi;
};

const monthMoves = (c, ym) => moves().get(c.id)?.months.get(ym);

const monthSpent = (c, ym) => monthMoves(c, ym)?.in ?? 0;

const monthIncome = (c, ym) => monthMoves(c, ym)?.out ?? 0;

/** Як операція міняє гроші на рахунках, у гривнях: дохід +, витрата −, переказ — лише різниця курсів. */
// Що входить у «Баланс»: рахунки й борги з позначкою «враховувати»; ціль — відкладене, не входить
const inBalance = (c) => c.kind === 'account' || (c.kind === 'debt' && Boolean(c.inBalance));

function accDelta(op) {
  const src = coinOr(op.from);
  const dst = coinOr(op.to);
  let v = 0;
  if (inBalance(dst)) v += toUah(amountIn(op), dst.currency);
  if (inBalance(src)) v -= toUah(op.amount, src.currency);
  return v;
}

/** Витрати й доходи в гривнях: за день («РРРР-ММ-ДД») чи за період обліку (ключ «РРРР-ММ»). */
function totals(key) {
  const all = cached('totals', () => {
    const out = new Map();
    const add = (k, field, v) => {
      let x = out.get(k);
      if (!x) out.set(k, (x = { expense: 0, income: 0 }));
      x[field] += v;
    };
    for (const op of state.ops) {
      const t = opType(op);
      let v;
      if (t === 'expense') v = toUah(amountIn(op), coinOr(op.to).currency);
      else if (t === 'income') v = toUah(op.amount, coinOr(op.from).currency);
      else continue;
      add(periodOf(op.date), t, v);
      add(op.date, t, v);
    }
    return out;
  });
  const x = all.get(key);
  return { expense: x?.expense ?? 0, income: x?.income ?? 0 };
}

const totalBalance = () => state.coins.filter(inBalance).reduce((s, a) => s + toUah(balance(a), a.currency), 0);

// ---------- головна ----------

/** Сума бюджетів витрат за місяць у гривнях; 0 — бюджетів не задано. */
const planTotal = () => state.coins
  .filter((c) => c.kind === 'expense' && !c.archived && c.budget > 0)
  .reduce((s, c) => s + toUah(c.budget, c.currency), 0);

function headStats() {
  const { expense, income } = totals(currentPeriod());
  const plan = planTotal();
  // Підсумки в гривнях — без копійок: долари за курсом дають «54 451,10». Тап — куди дивитись далі
  const stat = (label, v, onClick, cls = '') => h('button', { type: 'button', class: 'stat', onClick },
    h('span', {}, label), h('b', { class: cls }, `${v < 0 ? '−' : ''}${M.money(Math.round(v))}`));
  const report = (kind) => () => { reportKind = kind; reportPick = null; go('report'); };
  return h('div', { class: 'stats' },
    stat('Баланс', totalBalance(), () => go('feed')),
    stat('Витрати', expense, report('expense')),
    // Скільки ще можна витратити цього місяця: бюджети мінус уже витрачене; вийшли за бюджет — на скільки
    plan ? (plan >= expense ? stat('Лишилось', plan - expense, report('expense'))
      : stat('Понад бюджет', expense - plan, report('expense'), 'minus'))
      : stat('Доходи', income, report('income')));
}

/**
 * Середня витрата монети за повні періоди перед ym — до трьох і лише відколи є операції
 * (місяці до першої — не нулі, а «ще не було»): { avg, n } у валюті монети або null.
 */
const firstOpYmd = () => cached('firstOp', () => state.ops.reduce((m, op) => (op.date < m ? op.date : m), '9999'));

function avgSpent(c, ym, max = 3) {
  const first = firstOpYmd();
  if (first === '9999') return null;
  const since = periodOf(first);
  const keys = [];
  for (let i = 1; i <= max && M.addMonths(ym, -i) >= since; i++) keys.push(M.addMonths(ym, -i));
  return keys.length ? { avg: keys.reduce((s, k) => s + monthSpent(c, k), 0) / keys.length, n: keys.length } : null;
}

/** Жива ціль і скільки на неї відкладаєш за тиждень (у гривнях): та, куди клав останнім; за 90 днів, а молоду — з першого внеску. */
function goalPace() {
  return cached('goalPace', () => {
    const since = M.addDays(M.ymd(), -90);
    let best = null;
    for (const g of state.coins) {
      if (g.kind !== 'goal' || g.archived || !g.budget || balance(g) >= g.budget) continue;
      let net = 0; let first = null; let last = '';
      for (const op of state.ops) {
        if (op.to === g.id) {
          if (!first || op.date < first) first = op.date;
          if (op.date > last) last = op.date;
          if (op.date >= since) net += amountIn(op);
        } else if (op.from === g.id && op.date >= since) net -= op.amount;
      }
      if (!first || net <= 0) continue;
      const days = Math.max(14, Math.min(90, (M.parseYmd(M.ymd()) - M.parseYmd(first)) / 864e5));
      if (!best || last > best.last) best = { goal: g, last, week: toUah(net, g.currency) / (days / 7) };
    }
    return best;
  });
}

/** Звична витрата за день у гривнях — за попередні повні місяці; null, поки повного місяця нема. */
function dailyAvg() {
  return cached('dailyAvg', () => {
    const cur = currentPeriod();
    let sum = 0;
    for (const c of state.coins) {
      if (c.kind !== 'expense') continue;
      const a = avgSpent(c, cur);
      if (a) sum += toUah(a.avg, c.currency);
    }
    return sum > 0 ? sum / 30.4 : null;
  });
}

// Велика витрата — від десятої частини місячного плану; без бюджетів — від трьох звичних днів; не менше 500 грн
const BIG_SHARE = 0.1;
const bigFrom = () => cached('bigFrom', () => {
  const plan = planTotal();
  const day = dailyAvg();
  return Math.max(500, plan ? plan * BIG_SHARE : day ? day * 3 : Infinity);
});
const isBig = (uah) => uah >= bigFrom();
const expenseUah = (op) => toUah(amountIn(op), coinOr(op.to).currency);
// Регулярний платіж (комуналка, підписка) — не покупка: ні великою, ні днем з тратами не вважається
const isRegular = (op) => Boolean(op.fromRule || op.repeat);

/** Найсвіжіша велика витрата на монету за останні 7 днів (крім операції except). */
function recentBig(c, except) {
  const since = M.addDays(M.ymd(), -6);
  let best = null;
  for (const op of state.ops) {
    if (op.to !== c.id || op.id === except || op.date < since || op.date > M.ymd() || isRegular(op) || !isBig(expenseUah(op))) continue;
    if (!best || op.date > best.date) best = op;
  }
  return best;
}

/** Скільки можна витрачати щодня до кінця періоду, щоб лишитись у бюджетах: залишок ÷ дні разом із сьогоднішнім; extra — ще не записане. */
function perDayLeft(extra = 0) {
  const plan = planTotal();
  if (!plan) return null;
  const cur = currentPeriod();
  const left = plan - totals(cur).expense - extra;
  const days = Math.round((M.parseYmd(periodRange(cur)[1]) - M.parseYmd(M.ymd())) / 864e5) + 1;
  return { left, perDay: left > 0 ? Math.round(left / days) : 0 };
}

// День без трат: жодної витрати, крім регулярних платежів
const spentDays = () => cached('spentDays', () => {
  const s = new Set();
  for (const op of state.ops) if (!isRegular(op) && opType(op) === 'expense') s.add(op.date);
  return s;
});
const isFreeDay = (date) => date >= firstOpYmd() && date <= M.ymd() && !spentDays().has(date);

/** Скільки днів поспіль без трат, закінчуючи date. */
function freeStreak(date) {
  let n = 0;
  for (let d = date; isFreeDay(d); d = M.addDays(d, -1)) n += 1;
  return n;
}

/** Дні без трат у періоді обліку — до сьогодні. */
function freeDaysIn(ym) {
  const [from, to] = periodRange(ym);
  let n = 0;
  for (let d = from; d <= to; d = M.addDays(d, 1)) if (isFreeDay(d)) n += 1;
  return n;
}

const plural = (n, [one, few, many]) => (n % 10 === 1 && n % 100 !== 11 ? one
  : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);
const weeksWord = (n) => plural(n, ['тиждень', 'тижні', 'тижнів']);
const daysWord = (n) => plural(n, ['день', 'дні', 'днів']);

/** Колір монети витрати за поточний місяць — з темпом і кількістю операцій. */
function coinBudget(c, spent, ym = currentPeriod()) {
  const count = monthMoves(c, ym)?.n ?? 0;
  const elapsed = ym === currentPeriod() ? periodElapsed(ym) : 1;
  return M.budgetState(spent, c.budget, { elapsed, count });
}

// Сума монети зі знаком: рахунок буває в мінусі (кредитка), і без «−» його не відрізнити
const coinMoney = (v, cur) => M.money(v, cur, { sign: v < 0 ? '−' : '' });

// Суми монет, показані востаннє: змінену після збереження «докручуємо» до нової
const shownSums = new Map();
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function animateSums() {
  for (const el of document.querySelectorAll('.coin-sum[data-from]')) {
    const from = Number(el.dataset.from);
    const to = Number(el.dataset.to);
    const cur = el.dataset.cur;
    el.closest('.coin')?.classList.add('bump');
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 450);
      const e = 1 - (1 - k) ** 3;
      el.textContent = coinMoney(k < 1 ? from + (to - from) * e : to, cur);
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

/** Маленька монета для рядків і шапки екрана суми — того ж кольору, що на головній. */
function miniCoin(c) {
  const st = c.kind === 'expense' ? coinBudget(c, monthSpent(c, currentPeriod())).st : '';
  return h('span', { class: `mini-coin k-${c.kind}${st ? ` st-${st}` : ''}`, 'aria-hidden': 'true' }, icon(hasIcon(c.icon) ? c.icon : 'coins'));
}

function coinEl(c, ym) {
  let sum;
  let sub = null;
  let st = '';
  let fill = 0;
  if (c.kind === 'income') {
    sum = monthIncome(c, ym);
    if (c.budget) sub = M.num(c.budget);
  } else if (c.kind === 'account') {
    sum = balance(c);
  } else if (c.kind === 'debt') {
    // Борг: плюс — винні мені, мінус — винен я; сума без знака, напрям — кольором і підписом
    const bal = balance(c);
    sum = Math.abs(bal);
    st = bal > 0 ? 'owed' : bal < 0 ? 'owe' : 'closed';
    const late = bal !== 0 && c.due && c.due <= M.ymd();
    sub = `${bal > 0 ? 'винні мені' : bal < 0 ? 'я винен' : 'повернуто'}${bal !== 0 && c.due ? ` · ${late ? 'час!' : `до ${c.due.slice(8, 10)}.${c.due.slice(5, 7)}`}` : ''}`;
    if (late) st += ' late';
  } else if (c.kind === 'goal') {
    // Ціль: відкладено / скільки треба; кільце — частка зібраного
    sum = balance(c);
    fill = c.budget ? Math.min(1, Math.max(0, sum / c.budget)) : 0;
    if (c.budget && sum >= c.budget) st = 'done';
  } else {
    sum = monthSpent(c, ym);
    ({ st, fill } = coinBudget(c, sum, ym));
  }
  const face = h('div', { class: 'coin-face', style: { '--fill': String(fill) } },
    c.kind === 'expense' ? h('span', { class: 'coin-fill' }) : null,
    icon(hasIcon(c.icon) ? c.icon : 'coins', 'ico coin-ico'));
  const zero = Math.abs(sum) < 0.005 && c.kind !== 'debt' ? ' zero' : '';
  const el = h('div', { class: `coin k-${c.kind}${st ? ` st-${st}` : ''}${zero}`, 'data-id': c.id, 'data-kind': c.kind },
    h('div', { class: 'coin-name' }, c.name),
    face,
    sumEl(c, sum),
    sub != null ? h('div', { class: 'coin-sub' }, sub) : null);
  if (editing()) {
    el.append(
      h('button', { type: 'button', class: 'coin-x', 'aria-label': `Прибрати «${c.name}»`, onClick: () => removeCoin(c) }, icon('close')),
      h('button', { type: 'button', class: 'coin-pen', 'aria-label': `Змінити «${c.name}»`, onClick: () => editCoin(c) }, icon('pen')));
  }
  bindCoin(el, face, c);
  return el;
}

function sumEl(c, sum) {
  const prev = shownSums.get(c.id);
  shownSums.set(c.id, sum);
  const el = h('div', { class: 'coin-sum' }, coinMoney(sum, c.currency));
  if (prev !== undefined && prev !== sum && !reduceMotion()) {
    Object.assign(el.dataset, { from: String(prev), to: String(sum), cur: c.currency });
    el.textContent = coinMoney(prev, c.currency);
  }
  return el;
}

function addCoinEl(kind) {
  return h('button', { type: 'button', class: 'coin coin-add', 'aria-label': `Додати: ${M.KINDS[kind].toLowerCase()}`, onClick: () => editCoin(null, kind) },
    h('div', { class: 'coin-name' }, ' '),
    h('div', { class: 'coin-face' }, icon('plus')));
}

// Сторінка ряду, на якій стояли: головна перемальовується після кожної операції
const pagerAt = new Map();

/**
 * Ряд монет сторінками, що гортаються вбік (по perPage на сторінці), з крапками внизу.
 * Одна сторінка — без крапок і без гортання.
 */
function pager(key, items, perPage, cls) {
  const pages = [];
  for (let i = 0; i < items.length; i += perPage) pages.push(items.slice(i, i + perPage));
  const track = h('div', { class: 'pager-track', 'data-pager': key, 'data-per': perPage },
    pages.map((list) => h('div', { class: 'pager-page coin-grid' }, list)));
  const dots = pages.length > 1 ? h('div', { class: 'pager-dots', 'aria-hidden': 'true' }, pages.map(() => h('span'))) : null;
  const paint = () => {
    if (!dots) return;
    const at = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    pagerAt.set(key, at);
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === at));
  };
  track.addEventListener('scroll', paint, { passive: true });
  // Повертаємо на ту саму сторінку, коли ряд уже в документі
  requestAnimationFrame(() => {
    const at = Math.min(pagerAt.get(key) ?? 0, pages.length - 1);
    track.scrollLeft = at * track.clientWidth;
    paint();
  });
  return h('div', { class: `pager ${cls}` }, track, dots);
}

/**
 * Що чекає уваги: повтори, яким пора, прострочені борги, гарантії, що спливають.
 * На головній — лише лічильник на кнопці меню (місце — монетам), самі рядки — групою в меню.
 */
function alerts() {
  const n = dueCount();
  // Борги, яким настав строк і які ще не закриті
  const late = coinsOf('debt').filter((c) => c.due && c.due <= M.ymd() && Math.abs(balance(c)) >= 0.01);
  const rows = late.map((c) => {
    const bal = balance(c);
    return { cls: 'debt', ico: 'handshake', to: `feed/${c.id}`, text: `${c.name}: ${bal > 0 ? 'час повернути тобі' : 'час віддати'} ${M.money(Math.abs(bal), c.currency)}` };
  });
  if (n) rows.unshift({ cls: '', ico: 'refresh', to: 'feed', text: `До проведення: ${n}` });
  // Гарантія спливає за місяць — ще є час звернутись
  const ending = warrantyOps().filter((op) => daysLeft(op.warranty) >= 0 && daysLeft(op.warranty) <= WARRANTY_SOON);
  if (ending.length) {
    const first = ending[0];
    rows.push({ cls: 'warranty', ico: 'shield', to: 'warranty',
      text: ending.length === 1 ? `Гарантія: ${opName(first)} — до ${dmy(first.warranty)}` : `Гарантія спливає: ${ending.length} покупки за місяць` });
  }
  return rows;
}

function viewMain() {
  const ym = currentPeriod();
  const incomeOpen = recall('income-open') === '1';
  // Цілі стоять у сітці витрат, як копилка
  const grid = state.coins.filter((c) => (c.kind === 'expense' || c.kind === 'goal') && !c.archived).sort((a, b) => a.order - b.order);
  return h('div', { class: `main${editing() ? ' editing' : ''}` },
    keyNote(),
    incomeOpen ? pager('income', [...coinsOf('income').map((c) => coinEl(c, ym)), addCoinEl('income')], 4, 'coin-row incomes') : null,
    pager('account', [...state.coins.filter((c) => (c.kind === 'account' || c.kind === 'debt') && !c.archived)
      .sort((a, b) => a.order - b.order).map((c) => coinEl(c, ym)), addCoinEl('account')], 4, 'coin-row accounts'),
    state.ops.length ? todayStrip() : null,
    pager('expense', [...grid.map((c) => coinEl(c, ym)), addCoinEl('expense')], 16, 'expenses'),
    state.ops.length ? null : h('p', { class: 'muted small main-hint' },
      'Тягни монету пальцем: дохід — на рахунок, рахунок — на витрату чи інший рахунок. Тап — історія монети, довге натискання — змінити.'));
}

const opsWord = (n) => plural(n, ['операція', 'операції', 'операцій']);

/** Підсумок сьогодні під рахунками — тап веде у «Звіт по днях» на сьогодні. */
function todayStrip() {
  if (editing()) return null;
  const today = M.ymd();
  const n = state.ops.filter((op) => op.date === today).length;
  const { expense } = totals(today);
  const pd = perDayLeft();
  const perDay = pd && pd.left > 0 ? h('span', { class: 'today-per' }, 'можна ще ', h('b', {}, M.money(pd.perDay)), '/день') : null;
  const wrap = h('div', { class: `today-wrap${todayOpen ? ' open' : ''}`, inert: !todayOpen },
    h('button', { type: 'button', class: 'today-strip', onClick: () => { dayDate = today; go('days'); } },
      h('span', { class: 'today-text' },
        h('span', {}, n ? ['Сьогодні ', h('b', {}, expense ? `− ${M.money(expense)}` : M.money(0)), ` · ${n} ${opsWord(n)}`] : 'Сьогодні без операцій'),
        perDay)));
  // Згорнутий рядок видно тонкою ручкою: тап (чи Enter) розгортає — не лише жестом
  return todayOpen ? wrap : [h('button', { type: 'button', class: 'today-grip', 'aria-label': 'Показати «Сьогодні»', onClick: openToday }), wrap];
}

/** Розгорнути «Сьогодні» на головній: ручка зникає, рядок плавно виїжджає. */
function openToday() {
  const wrap = document.querySelector('.main .today-wrap');
  if (!wrap || todayOpen) return;
  todayOpen = true;
  wrap.classList.add('open');
  wrap.inert = false;
  document.querySelector('.main .today-grip')?.remove();
}

/** Потягнути головну вниз від верху — розгорнути «Сьогодні»; монету, що тягнуть, не рахуємо. */
function bindPullToday() {
  const PULL = 60;
  let start = null;
  addEventListener('touchstart', (e) => {
    start = view === 'main' && !todayOpen && scrollY <= 0 && e.touches.length === 1
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (!start || document.body.classList.contains('dragging')) return;
    const dy = e.touches[0].clientY - start.y;
    if (dy < PULL || dy < Math.abs(e.touches[0].clientX - start.x) * 1.5) return;
    start = null;
    if (!document.querySelector('.main .today-wrap')) return;
    openToday();
    vibrate(10);
  }, { passive: true });
}

// ---------- перетягування монет ----------

/** Куди можна тягнути: дохід → рахунок; рахунок → рахунок чи витрата. */
function canDrop(src, dst) {
  if (!dst || src.id === dst.id) return false;
  if (src.kind === 'income') return dst.kind === 'account';
  if (src.kind === 'account') return dst.kind === 'account' || dst.kind === 'expense' || dst.kind === 'goal' || dst.kind === 'debt';
  // Борг → рахунок: позичив у когось чи тобі повернули
  if (src.kind === 'debt') return dst.kind === 'account';
  // З цілі — назад на рахунок
  if (src.kind === 'goal') return dst.kind === 'account';
  return false;
}

// Ряд, у якому монету можна переставити: цілі стоять разом із витратами
const rowOf = (c) => (c.kind === 'goal' ? 'expense' : c.kind === 'debt' ? 'account' : c.kind);
const canReorder = (src, dst) => Boolean(dst) && src.id !== dst.id && rowOf(src) === rowOf(dst);

/**
 * Перестановка наживо (режим правки): монета стає на місце тієї, над якою палець, решта ряду
 * розступається — з анімацією, і між сторінками теж (сторінки перезаповнюються по data-per).
 */
function liveMove(el, target) {
  const track = el.closest('.pager-track');
  if (!track || target.closest('.pager-track') !== track) return;
  const items = [...track.querySelectorAll(':scope > .pager-page > *')];
  const from = items.indexOf(el);
  const to = items.indexOf(target);
  if (from < 0 || to < 0) return;
  const before = new Map(items.map((n) => [n, n.getBoundingClientRect()]));
  items.splice(to, 0, items.splice(from, 1)[0]);
  const pages = [...track.children];
  const per = Number(track.dataset.per);
  items.forEach((n, i) => pages[Math.floor(i / per)].append(n));
  if (reduceMotion()) return;
  for (const n of items) {
    const a = before.get(n);
    const b = n.getBoundingClientRect();
    if (a.left !== b.left || a.top !== b.top) {
      n.animate?.([{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
    }
  }
}

/** Зберегти порядок ряду таким, як монети стоять у документі після перетягування. */
async function saveOrder(el) {
  const ids = [...(el.closest('.pager-track')?.querySelectorAll('.coin[data-id]') ?? [])].map((n) => n.dataset.id);
  const put = ids.map((id) => coin(id)).map((c, i) => (c && c.order !== i ? { ...c, order: i } : null)).filter(Boolean);
  if (put.length) await save({ coins: { put } });
}

// ---------- цілі й борги: не більше, ніж є ----------

/**
 * Перевірка змін операцій (put — нові чи змінені, del — id видалених). Повертає текст, чому не можна, або null.
 * Ціль: у мінус не йде — забрати можна лише відкладене.
 * Борг: при новій чи зміненій операції не переходить через нуль — повернути можна лише те, що винні
 * (видалення боргових операцій дозволене: це прибирання помилок).
 * Монета, що вже була «зламана» (старі дані), правок, які її не погіршують, не блокує.
 */
function holdBreak(put = [], del = []) {
  const ids = new Set([...put.map((o) => o.id), ...del]);
  const without = state.ops.filter((o) => !ids.has(o.id));
  const next = [...without, ...put];
  const touched = new Set([...put, ...state.ops.filter((o) => ids.has(o.id))].flatMap((o) => [o.from, o.to]));
  for (const id of touched) {
    const c = coin(id);
    if (c?.kind === 'goal') {
      const after = balance(c, next);
      if (after < -0.005 && after < balance(c) - 0.005) {
        const avail = Math.max(0, balance(c, without));
        return avail > 0 && put.length
          ? `У цілі «${c.name}» лише ${M.money(avail, c.currency)} — більше не забереш`
          : `Не можна: у цілі «${c.name}» стане мінус — з неї вже забрали ці гроші`;
      }
    }
    if (c?.kind === 'debt' && put.length) {
      const base = balance(c, without);
      const after = balance(c, next);
      if (Math.abs(base) >= 0.01 && Math.abs(after) >= 0.01 && Math.sign(base) !== Math.sign(after)) {
        return base > 0
          ? `«${c.name}» винен тобі лише ${M.money(base, c.currency)} — більше не повернеш. Позичив ще — це окрема операція`
          : `Ти винен «${c.name}» лише ${M.money(-base, c.currency)} — більше не віддаси. Дав ще в борг — це окрема операція`;
      }
    }
  }
  return null;
}

/** Не можна — сказати чому й струснути телефоном; true, якщо зміну зупинено. */
function refuse(put, del) {
  const why = holdBreak(put, del);
  if (!why) return false;
  toast(why);
  vibrate([30, 40, 30]);
  return true;
}

/**
 * ✕ на монеті, що тримає гроші: ціль — повернути на рахунок (у «Баланс» вона не входить, інакше гроші зникли б);
 * рахунок — перенести на інший або сховати з грошима; відкритий борг — підтвердити.
 */
function removeHolder(c) {
  const left = balance(c);
  const others = coinsOf('account').filter((a) => a.id !== c.id);
  const move = async (acc) => {
    close();
    const op = { id: uid(), from: c.id, to: acc.id, amount: left, date: M.ymd(), tags: [], comment: `Закрито «${c.name}»`, created: Date.now() };
    if (acc.currency !== c.currency) op.amountTo = M.round2(left * rate(c.currency) / rate(acc.currency));
    await save({ ops: { put: [op] }, coins: { put: [{ ...c, archived: true }] } });
    toast(`${M.money(left, c.currency)} → ${acc.name}, «${c.name}» сховано`, {
      label: 'Скасувати', run: () => save({ ops: { del: [op.id] }, coins: { put: [{ ...c }] } }),
    });
  };
  const hide = async () => {
    close();
    await save({ coins: { put: [{ ...c, archived: true }] } });
    toast(`«${c.name}» сховано`, { label: 'Скасувати', run: () => save({ coins: { put: [{ ...c }] } }) });
  };
  const text = c.kind === 'goal' ? `У цілі відкладено ${M.money(left, c.currency)}. На який рахунок їх повернути?`
    : c.kind === 'account' ? `На рахунку ${M.money(left, c.currency)}. Перенести їх на інший рахунок? Якщо просто сховати — гроші лишаться в «Баланс», але рахунку на головній не буде.`
      : `${left > 0 ? `«${c.name}» ще винен тобі` : `Ти ще винен «${c.name}»`} ${M.money(Math.abs(left), c.currency)}. Сховати борг усе одно?`;
  const close = sheet(`Прибрати «${c.name}»?`, h('div', { class: 'form' },
    h('p', {}, text),
    c.kind !== 'debt' && others.length
      ? h('div', { class: 'pick-coins' }, others.map((a) => h('button', { type: 'button', class: 'pick-coin', onClick: () => move(a) }, miniCoin(a), h('span', {}, a.name))))
      : null,
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn', onClick: () => close() }, 'Скасувати'),
      c.kind !== 'goal' ? h('button', { type: 'button', class: 'btn danger', onClick: hide }, 'Сховати') : null)));
}

/** ✕ на монеті: без операцій — видалити, з операціями — сховати (операції лишаються). */
async function removeCoin(orig) {
  if (['goal', 'account', 'debt'].includes(orig.kind) && Math.abs(balance(orig)) >= 0.01) { removeHolder(orig); return; }
  const used = state.ops.some((op) => op.from === orig.id || op.to === orig.id);
  if (used) {
    await save({ coins: { put: [{ ...orig, archived: true }] } });
    toast(`«${orig.name}» сховано — операції лишились`, { label: 'Скасувати', run: () => save({ coins: { put: [{ ...orig }] } }) });
  } else {
    await save({ coins: { del: [orig.id] } });
    toast(`«${orig.name}» видалено`, { label: 'Скасувати', run: () => save({ coins: { put: [{ ...orig }] } }) });
  }
}

// Тягнеш монету до краю ряду — ряд гортається на сусідню сторінку (раз на PAGE_WAIT мс)
const PAGE_EDGE = 28;
const PAGE_WAIT = 600;

const LONG_PRESS = 500;
// Велику витрату записує утримання кнопки стільки мілісекунд
const HOLD_MS = 1000;
const EDGE = 70;

/**
 * Копія монети після відпускання: влучив — втягується в ціль, і та її «ловить», з подвійним відгуком;
 * мимо — плавно вертається на місце. Без анімацій у системі — просто зникає.
 */
function flyGhost(ghost, target, home) {
  if (target) {
    vibrate([18, 40, 18]);
    const f = target.querySelector('.coin-face');
    f?.classList.add('catch');
    f?.addEventListener('animationend', () => f.classList.remove('catch'), { once: true });
  }
  const to = (target?.querySelector('.coin-face') ?? home).getBoundingClientRect();
  if (!ghost.animate || !to.width || matchMedia('(prefers-reduced-motion: reduce)').matches) { ghost.remove(); return; }
  const anim = ghost.animate([{}, {
    left: `${to.left + to.width / 2}px`, top: `${to.top + to.height / 2}px`,
    transform: `translate(-50%, -50%) scale(${target ? 0.3 : 1})`, opacity: target ? 0 : 0.5,
  }], { duration: target ? 200 : 260, easing: 'cubic-bezier(.3, .7, .4, 1)', fill: 'forwards' });
  anim.onfinish = () => ghost.remove();
  anim.oncancel = () => ghost.remove();
}

function bindCoin(el, face, c) {
  face.addEventListener('contextmenu', (e) => e.preventDefault());
  face.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    let moved = false;
    let long = false;
    let drag = null;
    let at = { x: e.clientX, y: e.clientY };
    const timer = setTimeout(() => {
      if (moved) return;
      long = true;
      vibrate();
      cleanup();
      if (!editing()) go('edit');
    }, LONG_PRESS);

    const findTarget = () => {
      const t = document.elementFromPoint(at.x, at.y)?.closest('.coin.drop-ok');
      // Режим правки: монета одразу стає на нове місце, решта розступається
      if (editing()) {
        if (t && t !== drag.over) { liveMove(el, t); vibrate(10); }
        drag.over = t ?? null;
        return;
      }
      if (t !== drag.over) {
        drag.over?.classList.remove('drop-over');
        drag.over = t ?? null;
        if (drag.over) { drag.over.classList.add('drop-over'); vibrate(15); }
      }
    };
    const scrollLoop = () => {
      if (!drag) return;
      const dy = at.y > innerHeight - EDGE ? 12 : at.y < EDGE + 60 ? -12 : 0;
      if (dy) { scrollBy(0, dy); findTarget(); }
      // Край ряду зі сторінками — перегорнути, якщо палець тримають там
      const track = [...document.querySelectorAll('.pager-track')].find((t) => {
        const r = t.getBoundingClientRect();
        return at.y >= r.top && at.y <= r.bottom;
      });
      const r = track?.getBoundingClientRect();
      let dir = !r ? 0 : at.x < r.left + PAGE_EDGE ? -1 : at.x > r.right - PAGE_EDGE ? 1 : 0;
      // Гортати є куди — край ряду світиться стрілкою: «тримай тут, перегорну»
      if (dir < 0 && track.scrollLeft < 1) dir = 0;
      if (dir > 0 && track.scrollLeft + track.clientWidth >= track.scrollWidth - 1) dir = 0;
      for (const p of document.querySelectorAll('.pager')) {
        p.classList.toggle('edge-l', dir < 0 && p === track.parentElement);
        p.classList.toggle('edge-r', dir > 0 && p === track.parentElement);
      }
      const now = performance.now();
      if (!dir) drag.edgeAt = 0;
      else if (!drag.edgeAt) drag.edgeAt = now;
      else if (now - drag.edgeAt > PAGE_WAIT) {
        track.scrollBy({ left: dir * track.clientWidth, behavior: 'smooth' });
        drag.edgeAt = now;
        setTimeout(findTarget, 350);
      }
      drag.raf = requestAnimationFrame(scrollLoop);
    };
    const startDrag = () => {
      const r = face.getBoundingClientRect();
      const ghost = face.cloneNode(true);
      ghost.classList.add('coin-ghost');
      Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px`, left: `${at.x}px`, top: `${at.y}px` });
      document.body.append(ghost);
      document.body.classList.add('dragging');
      el.classList.add('drag-src');
      const ok = editing() ? (dst) => canReorder(c, dst) : (dst) => canDrop(c, dst);
      for (const t of document.querySelectorAll('.coin[data-id]')) {
        if (ok(coin(t.dataset.id))) t.classList.add('drop-ok');
      }
      // Крапка сторінки, де є куди кинути, — підсвічена: видно, що ціль далі, за краєм
      for (const track of document.querySelectorAll('.pager-track')) {
        const dots = track.nextElementSibling?.children ?? [];
        [...track.children].forEach((page, i) => dots[i]?.classList.toggle('target', Boolean(page.querySelector('.drop-ok'))));
      }
      drag = { ghost, over: null, raf: 0 };
      vibrate();
      scrollLoop();
    };
    const onMove = (ev) => {
      if (ev.pointerId !== start.id) return;
      at = { x: ev.clientX, y: ev.clientY };
      if (!moved) {
        if (Math.hypot(at.x - start.x, at.y - start.y) < 8) return;
        moved = true;
        clearTimeout(timer);
        if (c.kind === 'expense' && !editing()) { cleanup(); return; }
        startDrag();
      }
      if (!drag) return;
      ev.preventDefault();
      drag.ghost.style.left = `${at.x}px`;
      drag.ghost.style.top = `${at.y}px`;
      findTarget();
    };
    const onUp = (ev) => {
      if (ev.pointerId !== start.id) return;
      const target = drag?.over;
      const wasDrag = Boolean(drag);
      const tap = !moved && !long && ev.type === 'pointerup';
      if (wasDrag && editing()) {
        // Монета вже на новому місці — лишилось зберегти; скасований жест — повернути як було
        cleanup();
        if (ev.type === 'pointerup') saveOrder(el); else render();
        return;
      }
      const hit = wasDrag && target && ev.type === 'pointerup';
      cleanup(hit ? target : null);
      if (hit) openAmount({ from: c.id, to: target.dataset.id });
      else if (tap) {
        if (editing()) editCoin(c);
        else openFeed(c.id);
      }
    };
    function cleanup(landed = null) {
      clearTimeout(timer);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      if (!drag) return;
      cancelAnimationFrame(drag.raf);
      flyGhost(drag.ghost, landed, face);
      document.body.classList.remove('dragging');
      el.classList.remove('drag-src');
      for (const t of document.querySelectorAll('.drop-ok, .drop-over')) t.classList.remove('drop-ok', 'drop-over');
      for (const t of document.querySelectorAll('.pager-dots .target')) t.classList.remove('target');
      for (const p of document.querySelectorAll('.pager.edge-l, .pager.edge-r')) p.classList.remove('edge-l', 'edge-r');
      drag = null;
    }
    addEventListener('pointermove', onMove, { passive: false });
    addEventListener('pointerup', onUp);
    addEventListener('pointercancel', onUp);
  });
  // З клавіатури: Enter — історія монети
  face.tabIndex = 0;
  face.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFeed(c.id); });
}

// ---------- екран суми ----------

/** Найчастіші теги цієї монети-цілі — підказки над клавіатурою. */
function tagsFor(to) {
  const count = new Map();
  for (const op of state.ops) {
    if (op.to !== to) continue;
    for (const t of op.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

const allTags = () => [...new Set(state.ops.flatMap((op) => op.tags ?? []))].sort((a, b) => a.localeCompare(b, 'uk'));

/** Тег в одному написанні: без «#», зайвих пробілів і великих літер — «Їжа» й «їжа » не стають двома тегами. */
const normTag = (t) => String(t).trim().replace(/^#+/, '').replace(/\s+/g, ' ').replace(/[’ʼ`]/g, "'").toLocaleLowerCase('uk');

/** Теги операції в одному написанні, без двійників і порожніх. */
const normTags = (tags) => [...new Set((tags ?? []).map(normTag).filter(Boolean))];

/** Операції, де теги записані інакше (з великої, з пробілом), — виправлені; двійники зливаються. */
function fixedTagOps() {
  return state.ops.filter((op) => op.tags?.length && normTags(op.tags).join('\n') !== op.tags.join('\n'))
    .map((op) => ({ ...op, tags: normTags(op.tags) }));
}

/** Теги з іншим написанням — виправити й зберегти (піде й на інші телефони). */
async function fixTags() {
  const fixed = fixedTagOps();
  if (fixed.length) await save({ ops: { put: fixed } }, { redraw: false });
}

/** Перейменувати тег у всіх операціях (у той, що вже є, — злити) чи прибрати, коли to порожній. «Скасувати» повертає як було. */
async function retag(from, to) {
  const before = state.ops.filter((op) => op.tags?.includes(from));
  if (!before.length) return;
  const after = before.map((op) => ({ ...op, tags: normTags(op.tags.flatMap((t) => (t === from ? (to ? [to] : []) : [t]))) }));
  const merged = Boolean(to) && allTags().includes(to);
  await save({ ops: { put: after } });
  toast(!to ? `#${from} прибрано: ${before.length} ${opsWord(before.length)}` : `#${from} → #${to}${merged ? ' — злито' : ''}`,
    { label: 'Скасувати', run: () => save({ ops: { put: before } }) });
}

/**
 * Введення суми після перетягування (op — правка наявної операції).
 * Різні валюти «звідки» й «куди» — два рядки; другий рахується за курсом, поки його не змінили руками.
 */
function openAmount({ from, to, op = null, preset = null, copy = null }) {
  // preset — запланований повтор: поля з правила, зберігається новою операцією з fromRule;
  // copy — «Повторити»: сума, теги й коментар наявної операції, але нова операція на сьогодні
  const base = op ?? preset ?? copy;
  // Звідки й куди можна змінити тапом по монеті вгорі — тому не const
  let src = coinOr(from);
  let dst = coinOr(to);
  let two = src.currency !== dst.currency;
  const d = {
    a: base ? M.toExpr(base.amount) : '',
    b: base && two ? M.toExpr(amountIn(base)) : '',
    bOwn: Boolean(base && two),
    bTyped: Boolean(base && two),
    active: 'a',
    tags: [...(base?.tags ?? [])],
    comment: base?.comment ?? '',
    date: preset ? (preset.date > M.ymd() ? M.ymd() : preset.date) : (op?.date ?? M.ymd()),
    panel: null,
    repeat: { every: op?.repeat?.every ?? '', until: op?.repeat?.until ?? '' },
    warranty: op?.warranty ?? '',
    photos: [...(op?.photos ?? [])],
  };
  // id відомий заздалегідь: фото чека пишеться в базу одразу, з прив'язкою до операції
  const recId = op?.id ?? uid();
  // Повтор задається в операції-правилі; проведений повтор свого не має
  const canRepeat = !preset && !op?.fromRule;
  const autoB = () => M.round2(M.calc(d.a) * rate(src.currency) / rate(dst.currency));

  const lineA = h('button', { type: 'button', class: 'amt-line', onClick: () => { d.active = 'a'; paint(); } });
  const lineB = h('button', { type: 'button', class: 'amt-line second', onClick: () => { d.active = 'b'; if (!d.bOwn) { d.b = M.toExpr(autoB()); d.bOwn = true; } paint(); } });
  const res = h('div', { class: 'amt-res' });
  // З цілі — видно, скільки там є, і тапом забрати все
  const avail = h('button', { type: 'button', class: 'amt-avail' });
  const note = h('div', { class: 'amt-note' });
  // Над тегами, під пальцем: що станеться з бюджетом витрати — словами й смужкою (витрачено / ця сума / лишиться)
  const budgetName = h('span', { class: 'amt-budget-name' });
  const budgetText = h('span', { class: 'amt-budget-text' });
  const barSpent = h('span', { class: 'bar-spent' });
  const barNow = h('span', { class: 'bar-now' });
  const budgetLine = h('div', { class: 'amt-budget', hidden: true },
    h('div', { class: 'amt-budget-head' }, budgetName, budgetText),
    h('div', { class: 'amt-budget-bar', 'aria-hidden': 'true' }, barSpent, barNow));
  const impactLine = h('div', { class: 'amt-impact', hidden: true });
  const foot = h('div', { class: 'amt-foot' }, budgetLine, impactLine);
  const tagBar = h('div', { class: 'amt-tags' });
  const lower = h('div', {});

  const line = (el, expr, cur, on, placeholder) => {
    el.classList.toggle('on', on);
    el.replaceChildren(h('span', { class: 'amt-val' }, expr || placeholder), h('span', { class: 'amt-cur' }, cur));
  };
  const paint = () => {
    line(lineA, d.a, src.currency, d.active === 'a', '0');
    lineB.hidden = !two;
    tagBar.hidden = dst.kind !== 'expense';
    if (two) line(lineB, d.bOwn ? d.b : M.toExpr(autoB()), dst.currency, d.active === 'b', '0');
    const expr = d.active === 'a' ? d.a : d.b;
    const v = M.calc(expr);
    res.textContent = M.hasOp(expr) ? (Number.isNaN(v) ? 'помилка' : `= ${M.num(v)}`) : '';
    const inGoal = src.kind === 'goal' ? Math.max(0, balance(src, state.ops.filter((o) => o.id !== recId))) : 0;
    avail.hidden = src.kind !== 'goal';
    avail.textContent = `у цілі ${M.money(inGoal, src.currency)} · забрати все`;
    avail.onclick = () => { d.a = M.toExpr(inGoal); d.active = 'a'; d.b = ''; d.bOwn = false; d.bTyped = false; paint(); };
    paintQuick();
    // Коментар, вибраний чипом, уже видно на чипі
    note.textContent = [d.tags.map((t) => `#${t}`).join(' '), quickList.includes(d.comment) ? '' : d.comment, d.repeat.every ? `⟳ ${M.repeatLabel(d.repeat.every)}${d.repeat.until ? ` до ${M.dateTitle(d.repeat.until)}` : ''}` : '',
      d.warranty ? `гарантія до ${dmy(d.warranty)}` : '', d.photos.length ? `фото: ${d.photos.length}` : ''].filter(Boolean).join(' · ');
    paintBudget();
    paintTags();
    pad.querySelector('[aria-label="Повторювати"]')?.classList.toggle('on', Boolean(d.repeat.every));
    pad.querySelector('[aria-label="Деталі"]')?.classList.toggle('on', Boolean(d.warranty || d.photos.length));
  };
  // Що означає ця витрата — від найважливішого: нещодавня велика сюди ж, ціль, гроші на день, дні звичних витрат
  const impacts = () => {
    const v = two ? valueB() : valueA();
    if (dst.kind !== 'expense' || !(v > 0)) return [];
    const uah = toUah(v, dst.currency);
    const out = [];
    const recent = recentBig(dst, recId);
    if (recent) out.push({ cls: 'warn', text: `За тиждень тут уже було ${M.money(amountIn(recent), dst.currency)} (${dmy(recent.date).slice(0, 5)})` });
    const pace = goalPace();
    const weeks = pace ? Math.round(uah / pace.week) : 0;
    if (weeks >= 1) out.push({ cls: 'goal', text: `це ≈ ${weeks} ${weeksWord(weeks)} відкладання на «${pace.goal.name}»` });
    const day = dailyAvg();
    if (day && uah >= day) {
      const cur = currentPeriod();
      // Правка операції цього ж періоду: стара сума вже сидить у витраченому
      const was = op && opType(op) === 'expense' && periodOf(op.date) === cur ? expenseUah(op) : 0;
      const before = periodOf(d.date) === cur ? perDayLeft(-was) : null;
      const after = before && perDayLeft(uah - was);
      if (after && after.left >= 0) out.push({ cls: '', text: `на день лишиться ${M.money(after.perDay)} замість ${M.money(before.perDay)}` });
      else if (after) out.push({ cls: 'over', text: `бюджет місяця — в мінусі на ${M.money(-after.left)}` });
      const n = Math.round(uah / day);
      out.push({ cls: '', text: `це ${n} ${daysWord(n)} звичних витрат` });
    }
    return out;
  };
  const paintImpact = () => {
    const [first] = impacts();
    impactLine.hidden = !first;
    if (!first) return;
    impactLine.className = `amt-impact${first.cls ? ` ${first.cls}` : ''}`;
    impactLine.textContent = first.text;
  };
  const paintBudget = () => {
    paintImpact();
    const cur = currentPeriod();
    const show = dst.kind === 'expense' && dst.budget > 0 && periodOf(d.date) === cur;
    budgetLine.hidden = !show;
    if (!show) return;
    // Правка операції цього ж періоду: стара сума вже сидить у витраченому
    const was = op && op.to === dst.id && periodOf(op.date) === cur ? amountIn(op) : 0;
    const v = two ? valueB() : valueA();
    const spent = monthSpent(dst, cur) - was;
    const now = v > 0 ? v : 0;
    const rest = dst.budget - spent - now;
    const pct = (x) => Math.max(0, Math.min(100, (x / dst.budget) * 100));
    budgetLine.classList.toggle('over', rest < 0);
    barSpent.style.width = `${pct(spent)}%`;
    barNow.style.width = `${Math.min(100 - pct(spent), pct(now))}%`;
    budgetName.textContent = dst.name;
    budgetText.textContent = rest >= 0
      ? `лишиться ${M.money(rest, dst.currency)} з ${M.money(dst.budget, dst.currency)}`
      : `понад бюджет на ${M.money(-rest, dst.currency)}`;
  };
  let quickFor = null;
  let quickList = [];
  const paintQuick = () => {
    if (quickFor !== dst.id) {
      quickFor = dst.id;
      const n = new Map();
      for (const o of state.ops) if (o.to === dst.id && o.comment) n.set(o.comment, (n.get(o.comment) ?? 0) + 1);
      quickList = dst.kind === 'expense' ? [...n].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c) : [];
    }
  };
  // Над клавіатурою, під пальцем: часті коментарі (💬) окремим рядком, під ними — теги
  const paintTags = () => {
    const sugg = [...new Set([...d.tags, ...tagsFor(to)])].slice(0, 8);
    const coms = quickList.length ? h('div', { class: 'amt-tags-list amt-com-list' }, quickList.map((c) => h('button', {
      type: 'button', class: `amt-tag amt-com${d.comment === c ? ' on' : ''}`, 'aria-pressed': String(d.comment === c), 'aria-label': `Коментар: ${c}`,
      onClick: () => { d.comment = d.comment === c ? '' : c; paint(); },
    }, icon('comment'), c))) : null;
    const tags = h('div', { class: 'amt-tag-row' },
      h('div', { class: 'amt-tags-list' }, sugg.map((t) => h('button', {
        type: 'button', class: `amt-tag${d.tags.includes(t) ? ' on' : ''}`, 'aria-pressed': String(d.tags.includes(t)),
        onClick: () => { toggleTag(t); },
      }, t))),
      h('button', { type: 'button', class: 'amt-more', 'aria-label': 'Усі теги', onClick: () => showPanel('tags') }, icon('dots')));
    tagBar.replaceChildren(...[coms, tags].filter(Boolean));
  };
  const toggleTag = (t) => {
    d.tags = d.tags.includes(t) ? d.tags.filter((x) => x !== t) : [...d.tags, t];
    paint();
  };

  const edit = (fn) => {
    const key = d.active;
    // Перша цифра в другому рядку замінює підставлену за курсом суму, а не дописується до неї
    if (key === 'b' && !d.bTyped) { d.bTyped = true; d.b = ''; }
    d[key] = fn(d[key]);
    paint();
  };
  const digit = (k) => edit((s) => {
    const lastNum = s.split(/[+−×÷%]/).at(-1);
    if (k === ',') return lastNum.includes(',') ? s : `${s}${lastNum ? '' : '0'},`;
    if (/%$/.test(s)) return s;
    if (lastNum === '0') return s.slice(0, -1) + k;
    if (lastNum.replace(',', '').length >= 10) return s;
    return s + k;
  });
  const operator = (k) => edit((s) => {
    if (!s) return s;
    if (k === '%') return /\d$/.test(s) ? `${s}%` : s;
    return /[+−×÷]$/.test(s) ? s.slice(0, -1) + k : (/,$/.test(s) ? s.slice(0, -1) : s) + k;
  });
  const equals = () => edit((s) => { const v = M.calc(s); return Number.isNaN(v) ? s : M.toExpr(v); });
  const back = () => edit((s) => s.slice(0, -1));

  const valueA = () => M.calc(d.a);
  const valueB = () => (two ? (d.bOwn ? M.calc(d.b) : autoB()) : undefined);

  const store = async (date) => {
    const a = valueA();
    const b = valueB();
    if (!(a > 0) || (two && !(b > 0))) { toast('Введи суму'); vibrate([30, 40, 30]); return; }
    if (!op && !preset && !d.confirmed && dst.kind === 'expense' && isBig(toUah(two ? b : a, dst.currency))) { askBig(date); return; }
    const rec = {
      id: recId, from, to, amount: a, date: date || d.date,
      tags: d.tags, comment: d.comment.trim(), created: op?.created ?? Date.now(),
    };
    if (two) rec.amountTo = b;
    if (d.warranty) rec.warranty = d.warranty;
    if (d.photos.length) rec.photos = d.photos;
    if (op?.ammo) rec.ammo = op.ammo;
    if (op?.sl) rec.sl = op.sl;
    if (preset) { rec.fromRule = preset.rule.id; rec.ruleDate = preset.date; }
    if (op?.fromRule) { rec.fromRule = op.fromRule; rec.ruleDate = op.ruleDate; }
    if (canRepeat && d.repeat.every) rec.repeat = { every: d.repeat.every, until: d.repeat.until, skip: op?.repeat?.skip ?? [] };
    if (refuse([rec])) return;
    const accBefore = src.kind === 'account' ? balance(src) : 0;
    const goalBefore = dst.kind === 'goal' ? balance(dst) : 0;
    closeSheet();
    await save({ ops: { put: [rec] } });
    const t = opType(rec);
    const sign = t === 'expense' ? '−' : t === 'income' ? '+' : '';
    // Поповнення, яке дотягнуло ціль до суми, — святкуємо
    const reached = dst.kind === 'goal' && dst.budget > 0 && goalBefore < dst.budget && balance(coinOr(rec.to)) >= dst.budget;
    if (reached) vibrate([20, 60, 20, 60, 40]);
    const accNow = src.kind === 'account' ? balance(coinOr(rec.from)) : 0;
    const minus = src.kind === 'account' && accNow < 0 && accNow < accBefore ? ` · ${src.name} у мінусі: ${M.money(accNow, src.currency, { sign: '−' })}` : '';
    const what = (reached ? `Ціль «${dst.name}» зібрано! 🎉`
      : `${dst.name}: ${M.money(t === 'income' ? amountIn(rec) : rec.amount, t === 'income' ? dst.currency : src.currency, { sign })}`) + minus;
    toast(op ? `Операцію змінено${minus}` : what, {
      label: 'Скасувати',
      run: () => save(op ? { ops: { put: [{ ...op }] } } : { ops: { del: [rec.id] } }),
    });
    const slk = slKind(rec);
    if (slk) offerJournal(rec, slk);
  };
  const remove = async () => {
    // Не можна — екран лишається відкритим, видно, про що мова
    if (refuse([], [op.id])) return;
    closeSheet();
    await deleteOp(op);
  };

  // Дата з календаря: прихований input type=date, showPicker там, де є
  const dateInput = h('input', { type: 'date', class: 'date-hidden', value: d.date, 'aria-label': 'Дата', tabindex: '-1' });
  const pickDate = (then) => {
    dateInput.value = d.date;
    dateInput.onchange = () => { if (dateInput.value) then(dateInput.value); };
    try { dateInput.showPicker(); } catch { dateInput.click(); }
  };

  const key = (label, fn, aria = null, cls = '') => h('button', { type: 'button', class: cls, 'aria-label': aria ?? label, onClick: fn }, label);
  const pad = h('div', { class: 'pad' },
    h('div', { class: 'pad-digits' },
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => key(k, () => digit(k))),
      key(',', () => digit(','), 'Кома'), key('0', () => digit('0')), key(icon('backspace'), back, 'Стерти')),
    h('div', { class: 'pad-ops' },
      key(icon('comment'), () => showPanel('comment'), 'Деталі'),
      key(icon('refresh'), () => (canRepeat ? showPanel('repeat') : toast('Повтор задається в першій операції — відкрий її')), 'Повторювати'),
      key('−', () => operator('−'), 'Мінус'), key('%', () => operator('%'), 'Відсоток'),
      key('+', () => operator('+'), 'Плюс'), key('×', () => operator('×'), 'Помножити'),
      key('=', equals, 'Дорівнює'), key('÷', () => operator('÷'), 'Поділити')));

  const dates = op || preset
    ? h('div', { class: `dates${op ? ' with-del' : ''}` }, h('button', {
      type: 'button', onClick: () => pickDate((v) => { d.date = v; dates.firstChild.textContent = M.dateTitle(v); paint(); }),
    }, M.dateTitle(d.date)),
    // Ще раз така сама — нова операція з тими ж монетами, сумою, тегами й коментарем
    op ? h('button', { type: 'button', class: 'dates-act', 'aria-label': 'Повторити', title: 'Повторити', onClick: () => openAmount({ from, to, copy: op }) }, icon('copy')) : null,
    // Видалення — внизу, подалі від ✓ «Зберегти»: поруч їх легко сплутати
    op ? h('button', { type: 'button', class: 'dates-act', 'aria-label': 'Видалити', onClick: () => remove() }, icon('trash')) : null,
    dateInput)
    : h('div', { class: 'dates' },
      h('button', { type: 'button', onClick: () => store(M.addDays(M.ymd(), -1)) }, 'Вчора'),
      h('button', { type: 'button', onClick: () => store(M.ymd()) }, 'Сьогодні'),
      h('button', { type: 'button', 'aria-label': 'Інша дата', onClick: () => pickDate((v) => store(v)) }, icon('calendar')),
      dateInput);

  // Теги чи коментар — на місці клавіатури, «Готово» повертає її
  const showPanel = (kind) => {
    d.panel = kind;
    if (kind === 'repeat') {
      const until = h('input', { type: 'date', class: 'field', value: d.repeat.until, min: d.date, 'aria-label': 'Повторювати до' });
      lower.replaceChildren(h('div', { class: 'amt-panel form' },
        h('p', { class: 'flabel' }, 'Повторювати'),
        chips(M.REPEATS, d.repeat.every, (v) => { d.repeat.every = v; }),
        h('label', { class: 'flabel' }, 'До (не обов’язково)'), until,
        h('p', { class: 'muted small' }, 'Наступні повтори з’являться в стрічці блідими: свайп вправо — провести, вліво — пропустити.'),
        h('div', { class: 'btn-grid' }, h('button', {
          type: 'button', class: 'btn primary', onClick: () => { d.repeat.until = d.repeat.every ? until.value : ''; hidePanel(); },
        }, icon('check'), 'Готово'))));
      return;
    }
    if (kind === 'comment') {
      // Пишемо одразу: ✓ «Зберегти» вгорі можна натиснути, не закривши панель «Готово»
      const ta = h('textarea', { rows: 2, maxlength: 200, placeholder: 'Наприклад: Екофлоу', class: 'field', onInput: () => { d.comment = ta.value; } }, d.comment);
      // Гарантія: дата кінця або швидко — роки від дати покупки
      const until = h('input', { type: 'date', class: 'field', value: d.warranty, min: d.date, 'aria-label': 'Гарантія до', onChange: () => { d.warranty = until.value; } });
      const years = (n) => M.addDays(`${Number(d.date.slice(0, 4)) + n}${d.date.slice(4)}`, 0);
      const quick = h('div', { class: 'chips' }, [[1, '1 рік'], [2, '2 роки'], [3, '3 роки']].map(([n, label]) => h('button', {
        type: 'button', class: 'chip', onClick: () => { until.value = years(n); d.warranty = until.value; },
      }, label)));
      const photos = h('div', { class: 'photo-row' });
      const drawPhotos = () => photos.replaceChildren(
        ...d.photos.map((id) => photoThumb(id, () => { d.photos = d.photos.filter((x) => x !== id); drawPhotos(); })),
        photoAdd(async (blob) => {
          const id = uid();
          await putFile({ id, blob, created: Date.now(), op: recId });
          d.photos.push(id);
          drawPhotos();
        }));
      drawPhotos();
      lower.replaceChildren(h('div', { class: 'amt-panel form' },
        h('label', { class: 'flabel' }, 'Коментар'), ta,
        h('label', { class: 'flabel' }, 'Гарантія до'), h('div', { class: 'warranty-line' }, until, quick),
        h('p', { class: 'flabel' }, 'Фото чека чи гарантійного талона'), photos,
        h('div', { class: 'btn-grid' }, h('button', {
          type: 'button', class: 'btn primary', onClick: () => { d.comment = ta.value; d.warranty = until.value; hidePanel(); },
        }, icon('check'), 'Готово'))));
      return;
    }
    showTags();
  };

  // Усі теги — окремим екраном поверх суми: пошук угорі, під ним вибрані, часті для цієї витрати й усі за абеткою
  const showTags = () => {
    const count = new Map();
    for (const op of state.ops) for (const t of op.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
    const input = h('input', {
      type: 'search', maxlength: 40, placeholder: 'Знайти чи створити тег', 'aria-label': 'Знайти чи створити тег', class: 'field', enterkeyhint: 'done',
    });
    const body = h('div', { class: 'tag-body' });
    const chip = (t) => h('button', {
      type: 'button', class: `chip${d.tags.includes(t) ? ' on' : ''}`, 'aria-pressed': String(d.tags.includes(t)),
      onClick: () => { toggleTag(t); input.value = ''; draw(); },
    }, `#${t}`, count.get(t) ? h('span', { class: 'tag-n' }, String(count.get(t))) : null);
    const section = (title, tags) => (tags.length ? h('section', { class: 'tag-sec' }, h('h3', { class: 'flabel' }, title), h('div', { class: 'chips' }, tags.map(chip))) : null);
    const draw = () => {
      const q = normTag(input.value);
      const all = [...new Set([...count.keys(), ...d.tags])].sort((a, b) => a.localeCompare(b, 'uk'));
      if (q) {
        const found = all.filter((t) => t.includes(q));
        body.replaceChildren(...[
          all.includes(q) ? null : h('button', { type: 'button', class: 'btn tag-new', onClick: pick }, icon('plus'), `Створити #${q}`),
          found.length ? h('div', { class: 'chips' }, found.map(chip)) : h('p', { class: 'muted small' }, 'Серед наявних такого нема')].filter(Boolean));
        return;
      }
      const picked = h('div', { class: 'chips' }, d.tags.map((t) => h('button', {
        type: 'button', class: 'chip on', 'aria-label': `Зняти #${t}`, onClick: () => { toggleTag(t); draw(); },
      }, `#${t}`, icon('close'))));
      body.replaceChildren(...[
        d.tags.length ? h('section', { class: 'tag-sec' }, h('h3', { class: 'flabel' }, 'Вибрані'), picked) : null,
        // Короткий список видно й так — «Часто тут» лише тоді, коли тегів багато
        all.length > 12 ? section('Часто тут', tagsFor(to).slice(0, 8)) : null,
        section('Усі', all),
        all.length ? null : h('p', { class: 'muted small' }, 'Тегів ще нема — напиши перший угорі.')].filter(Boolean));
    };
    // Enter чи «Створити»: наявний тег вибираємо, новий — створюємо; поле чисте, клавіатура лишається
    const pick = () => {
      const t = normTag(input.value);
      if (t && !d.tags.includes(t)) toggleTag(t);
      input.value = '';
      draw();
      input.focus();
    };
    const close = () => { d.panel = null; screen.remove(); document.removeEventListener('keydown', onKey, true); paint(); };
    // Escape закриває лише теги, а не весь екран суми — ловимо раніше за шторку, бо фокус після тапу по чипу губиться
    const onKey = (e) => {
      // Екран суми закрили разом із тегами (системна «Назад») — слухач більше не потрібен
      if (!screen.isConnected) { document.removeEventListener('keydown', onKey, true); return; }
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); pick(); } });
    const screen = h('div', { class: 'tag-screen', role: 'dialog', 'aria-label': 'Теги' },
      h('div', { class: 'tag-head' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Назад до суми', onClick: close }, icon('back')),
        h('h2', {}, 'Теги'), input),
      body,
      h('div', { class: 'tag-foot' }, h('button', { type: 'button', class: 'btn primary', onClick: close }, icon('check'), 'Готово')));
    document.addEventListener('keydown', onKey, true);
    draw();
    document.querySelector('.sheet.screen').append(screen);
    screen.querySelector('.icon-btn').focus({ preventScroll: true });
  };
  const hidePanel = () => { d.panel = null; lower.replaceChildren(pad, dates); paint(); };

  // Велика витрата: усі наслідки й «Утримуй, щоб записати» — секунда, щоб передумати
  const askBig = (date) => {
    d.panel = 'big';
    const v = two ? valueB() : valueA();
    const record = () => { d.confirmed = true; hidePanel(); store(date); };
    let timer = null;
    const stop = () => { clearTimeout(timer); hold.classList.remove('holding'); };
    let pressed = false;
    const hold = h('button', { type: 'button', class: 'btn primary hold-btn', 'aria-label': 'Записати велику витрату: утримуй секунду' },
      h('span', { class: 'hold-fill', 'aria-hidden': 'true' }), h('span', { class: 'hold-text' }, 'Утримуй, щоб записати'));
    hold.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pressed = true;
      hold.classList.add('holding');
      timer = setTimeout(() => { stop(); vibrate(20); record(); }, HOLD_MS);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) hold.addEventListener(ev, stop);
    hold.addEventListener('contextmenu', (e) => e.preventDefault());
    // Клавіатура й екранний диктор (подвійний дотик) дають клік без натискання пальцем — утримувати їм нічим, записуємо одразу
    hold.addEventListener('click', () => { if (!pressed) record(); pressed = false; });
    const lines = [...(budgetLine.hidden ? [] : [{ cls: budgetLine.classList.contains('over') ? 'over' : '', text: `${budgetName.textContent}: ${budgetText.textContent}` }]), ...impacts()];
    lower.replaceChildren(h('div', { class: 'amt-panel big-confirm' },
      h('p', { class: 'big-title' }, `Велика витрата — ${M.money(v, dst.currency)}`),
      lines.length ? h('ul', { class: 'big-list' }, lines.map((x) => h('li', { class: x.cls || null }, x.text))) : null,
      hold,
      h('button', { type: 'button', class: 'btn', onClick: hidePanel }, 'Подумаю')));
    // Наслідки тепер у списку — над сумою їх не повторюємо
    budgetLine.hidden = true;
    impactLine.hidden = true;
    vibrate([18, 40, 18]);
  };

  // Тап по монеті вгорі — вибір іншої: лише ті, між якими така операція можлива
  const route = h('div', { class: 'amt-route' });
  const paintRoute = () => {
    const end = (c, side) => h('button', {
      type: 'button', class: `amt-end${d.panel === side ? ' on' : ''}`, 'aria-label': side === 'from' ? `Звідки: ${c.name}` : `Куди: ${c.name}`,
      onClick: () => (d.panel === side ? hidePanel() : pickCoin(side)),
    }, miniCoin(c), h('span', {}, c.name));
    route.replaceChildren(end(src, 'from'), icon('next'), end(dst, 'to'));
  };
  const pickCoin = (side) => {
    d.panel = side;
    const fits = state.coins
      .filter((c) => !c.archived && (side === 'from' ? canDrop(c, dst) : canDrop(src, c)))
      .sort((a, b) => a.order - b.order);
    const cur = side === 'from' ? src : dst;
    lower.replaceChildren(h('div', { class: 'amt-panel form' },
      h('label', { class: 'flabel' }, side === 'from' ? 'Звідки' : 'Куди'),
      h('div', { class: 'pick-coins' }, [cur, ...fits.filter((c) => c.id !== cur.id)].map((c) => h('button', {
        type: 'button', class: `pick-coin${c.id === cur.id ? ' on' : ''}`, onClick: () => setEnd(side, c),
      }, miniCoin(c), h('span', {}, c.name))))));
    paintRoute();
  };
  const setEnd = (side, c) => {
    if (side === 'from') { src = c; from = c.id; } else { dst = c; to = c.id; }
    const wasTwo = two;
    two = src.currency !== dst.currency;
    // Інша пара валют — друга сума за курсом заново
    if (two !== wasTwo || two) { d.b = ''; d.bOwn = false; d.bTyped = false; d.active = 'a'; }
    hidePanel();
    paintRoute();
  };

  const screen = h('div', { class: 'amt' },
    h('div', { class: 'amt-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Скасувати', onClick: () => closeSheet() }, icon('close')),
      route,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Зберегти', onClick: () => store() }, icon('check'))),
    h('div', { class: 'amt-body' }, lineA, lineB, res, avail, note));
  lower.replaceChildren(pad, dates);
  sheet(`${src.name} → ${dst.name}`, [screen.firstChild, screen.lastChild, foot, tagBar, lower], { cls: 'screen', bare: true });
  paintRoute();
  paint();

  // Фізична клавіатура (комп'ютер): цифри, дії, Enter, Backspace
  const panel = document.querySelector('.sheet.screen');
  panel.addEventListener('keydown', (e) => {
    if (d.panel || e.target.matches('input, textarea')) return;
    const map = { '+': '+', '-': '−', '*': '×', '/': '÷', '%': '%' };
    if (/^\d$/.test(e.key)) digit(e.key);
    else if (e.key === ',' || e.key === '.') digit(',');
    else if (map[e.key]) operator(map[e.key]);
    else if (e.key === 'Backspace') back();
    else if (e.key === '=') equals();
    else if (e.key === 'Enter') store();
    else return;
    e.preventDefault();
  });
}

// ---------- стрічка ----------

function opRow(op) {
  const t = opType(op);
  const src = coinOr(op.from);
  const dst = coinOr(op.to);
  const v = t === 'income' ? amountIn(op) : op.amount;
  const cur = t === 'income' ? dst.currency : src.currency;
  const sign = t === 'expense' ? '− ' : t === 'income' ? '+ ' : '';
  const every = op.plan ? op.rule.repeat.every : op.repeat?.every;
  const note = [(op.tags ?? []).map((x) => `#${x}`).join(' '), op.comment, every ? `⟳ ${M.repeatLabel(every)}` : '',
    op.warranty && !op.plan ? `гарантія до ${dmy(op.warranty)}` : '', op.photos?.length && !op.plan ? `фото: ${op.photos.length}` : '',
    op.plan ? '' : slNote(op)].filter(Boolean);
  const second = op.amountTo != null && t === 'transfer' ? ` → ${M.money(op.amountTo, dst.currency)}` : '';
  // У стрічці однієї монети її назва в кожному рядку — шум: лишаємо лише другий кінець
  const other = feedCoin === op.to ? src : feedCoin === op.from ? dst : null;
  const ends = h('span', { class: 'op-ends' }, other ? h('span', { class: 'op-to' }, other.name)
    : [h('span', { class: 'op-from' }, src.name), h('span', { class: 'op-to' }, dst.name)]);
  // Запланований повтор: тап — провести з правкою суми, свайп вправо — провести як є, вліво — пропустити чи зупинити
  if (op.plan) {
    const row = h('button', { type: 'button', class: `op-row plan${op.date <= M.ymd() ? ' due' : ''}`, onClick: () => openAmount({ from: op.from, to: op.to, preset: op }) },
      ends,
      h('span', { class: 'op-right' },
        h('span', { class: `op-sum ${t}` }, M.money(v, cur, { sign }) + second),
        note.map((x) => h('span', { class: 'op-note' }, x)),
        h('span', { class: 'op-note plan-tag' }, op.date <= M.ymd() ? 'провести →' : 'заплановано')));
    return swipeRow(row, { onLeft: () => planMenu(op), onRight: () => confirmPlan(op), labels: ['Провести', 'Пропустити'] });
  }
  const row = h('button', { type: 'button', class: 'op-row', onClick: () => openAmount({ from: op.from, to: op.to, op }) },
    ends,
    h('span', { class: 'op-right' },
      h('span', { class: `op-sum ${t}` }, M.money(v, cur, { sign }) + second),
      note.map((x) => h('span', { class: 'op-note' }, x))));
  return swipeRow(row, { onLeft: () => deleteOp(op), onRight: () => openAmount({ from: op.from, to: op.to, op }) });
}

async function deleteOp(op) {
  if (refuse([], [op.id])) return;
  await save({ ops: { del: [op.id] } });
  // Що операція записала в Стрілецький журнал (патрони, тюнінг, екіпірування) — теж прибрати
  const relink = await unlinkJournal(op.sl).catch(() => null);
  toast(relink ? `Операцію видалено — і з журналу (${op.sl.text})` : 'Операцію видалено', {
    label: 'Скасувати',
    run: async () => {
      await save({ ops: { put: [{ ...op }] } });
      if (relink) await relink().catch(() => toast('У журнал не повернулось — додай там вручну'));
    },
  });
}

/**
 * Свайп рядка: вліво — onLeft (видалити), вправо — onRight (змінити). Спрацьовує далі третини ширини:
 * короткий рух — це ще прокрутка. Після свайпу клік, що приходить слідом, не відкриває операцію.
 */
function swipeRow(row, { onLeft, onRight, labels = null }) {
  const wrap = h('div', { class: 'swipe-row' },
    h('div', { class: 'swipe-bg edit', 'aria-hidden': 'true' }, icon(labels ? 'check' : 'pen'), labels?.[0] ?? 'Змінити'),
    h('div', { class: 'swipe-bg del', 'aria-hidden': 'true' }, labels?.[1] ?? 'Видалити', icon(labels ? 'skip' : 'trash')),
    row);
  let start = null;
  let dx = 0;
  let axis = null;
  let armed = false;
  let swallow = false;
  const reset = () => {
    row.style.transition = 'transform .18s ease';
    row.style.transform = '';
    wrap.classList.remove('armed', 'to-left', 'to-right');
    start = null; axis = null; dx = 0; armed = false;
  };
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    row.style.transition = 'none';
  });
  row.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (axis === 'x') row.setPointerCapture(start.id);
    }
    if (axis !== 'x') return;
    dx = mx;
    row.style.transform = `translateX(${dx}px)`;
    wrap.classList.toggle('to-left', dx < 0);
    wrap.classList.toggle('to-right', dx > 0);
    const now = Math.abs(dx) > row.clientWidth / 3;
    if (now !== armed) { armed = now; wrap.classList.toggle('armed', armed); if (armed) vibrate(); }
  });
  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const act = armed && e.type === 'pointerup' ? (dx < 0 ? onLeft : onRight) : null;
    swallow = axis === 'x';
    reset();
    if (act) { vibrate(40); act(); }
  };
  row.addEventListener('pointerup', finish);
  row.addEventListener('pointercancel', finish);
  row.addEventListener('click', (e) => { if (swallow) { swallow = false; e.stopImmediatePropagation(); } }, true);
  return wrap;
}

// Скільки прострочених повторів одного правила показувати: щоденне, забуте на рік, не завалить стрічку
const PLAN_BACKLOG = 10;

/**
 * Заплановані, ще не проведені повтори — віртуальні рядки стрічки: { ...операція-правило, date, plan: true, rule }.
 * Проведений повтор — звичайна операція з fromRule/ruleDate; пропущений — дата в rule.repeat.skip.
 */
function planned() {
  const today = M.ymd();
  return cached(`planned:${today}`, () => plannedOn(today));
}

function plannedOn(today) {
  const out = [];
  const doneBy = new Map();
  for (const o of state.ops) {
    if (o.fromRule == null) continue;
    if (!doneBy.has(o.fromRule)) doneBy.set(o.fromRule, new Set());
    doneBy.get(o.fromRule).add(o.ruleDate);
  }
  for (const rule of state.ops) {
    if (!rule.repeat?.every) continue;
    const done = doneBy.get(rule.id) ?? new Set();
    const skip = new Set(rule.repeat.skip ?? []);
    const dates = M.repeatDates(rule.date, rule.repeat.every, rule.repeat.until, today).filter((x) => !done.has(x) && !skip.has(x));
    const due = dates.filter((x) => x <= today).slice(-PLAN_BACKLOG);
    const next = dates.filter((x) => x > today).slice(0, 1);
    for (const date of [...due, ...next]) {
      out.push({ ...rule, id: `plan:${rule.id}:${date}`, date, plan: true, rule, repeat: undefined, created: 0 });
    }
  }
  return out;
}

const dueCount = () => planned().filter((p) => p.date <= M.ymd()).length;

/** Провести повтор як є (свайп вправо): дата — запланована, але не в майбутньому. */
async function confirmPlan(p) {
  const rec = {
    id: uid(), from: p.from, to: p.to, amount: p.amount, date: p.date > M.ymd() ? M.ymd() : p.date,
    tags: [...(p.tags ?? [])], comment: p.comment ?? '', created: Date.now(), fromRule: p.rule.id, ruleDate: p.date,
  };
  if (p.amountTo != null) rec.amountTo = p.amountTo;
  if (refuse([rec])) return;
  await save({ ops: { put: [rec] } });
  toast(`Проведено: ${coinOr(p.to).name}`, { label: 'Скасувати', run: () => save({ ops: { del: [rec.id] } }) });
}

/** Свайп вліво по повтору: пропустити лише цей чи зупинити все правило. */
function planMenu(p) {
  const rule = p.rule;
  const put = (repeat) => save({ ops: { put: [{ ...rule, repeat: { ...rule.repeat, ...repeat } }] } });
  sheet('Запланована операція', h('div', { class: 'form' },
    h('p', {}, `${coinOr(p.from).name} → ${coinOr(p.to).name}, ${M.dateTitle(p.date)}. Повтор ${M.repeatLabel(rule.repeat.every)}.`),
    h('div', { class: 'btn-grid' },
      h('button', {
        type: 'button', class: 'btn', onClick: async () => {
          closeSheet();
          await put({ skip: [...(rule.repeat.skip ?? []), p.date] });
          toast('Пропущено', { label: 'Скасувати', run: () => save({ ops: { put: [{ ...rule }] } }) });
        },
      }, icon('skip'), 'Пропустити цю'),
      h('button', {
        type: 'button', class: 'btn danger', onClick: async () => {
          closeSheet();
          await put({ until: M.addDays(p.date, -1) });
          toast('Повтор зупинено', { label: 'Скасувати', run: () => save({ ops: { put: [{ ...rule }] } }) });
        },
      }, icon('close'), 'Зупинити повтор'))));
}

// Дати «РРРР-ММ-ДД» — просте порівняння рядків; localeCompare на тисячах операцій помітно повільніший
const cmp = (x, y) => (x > y) - (x < y);
const byNewest = (a, b) => cmp(b.date, a.date) || (b.created ?? b.updated ?? 0) - (a.created ?? a.updated ?? 0);

/**
 * Підсумок дня в стрічці однієї монети — «зміна» в її валюті: витрата — мінус витрачене,
 * дохід — плюс отримане, рахунок і ціль — прихід мінус розхід.
 */
function coinDayFoot(c, dayOps) {
  // Одна операція за день — підсумок лише повторив би її суму
  if (!c || dayOps.filter((op) => !op.plan).length < 2) return null;
  let v = 0;
  for (const op of dayOps) {
    if (op.plan) continue;
    if (op.to === c.id) v += amountIn(op);
    if (op.from === c.id) v -= op.amount;
  }
  if (c.kind === 'expense' || c.kind === 'income') v = -v;
  const sign = v > 0 ? '+ ' : v < 0 ? '− ' : '';
  return h('div', { class: 'day-foot' },
    h('div', {}),
    h('div', {}, h('b', { class: v > 0 ? 'plus' : v < 0 ? 'minus' : '' }, M.money(v, c.currency, { sign })), h('span', {}, 'зміна')));
}

const FEED_TYPES = [['all', 'Усі'], ['expense', 'Витрати'], ['income', 'Доходи'], ['transfer', 'Перекази']];

/** Чи підходить операція під пошук: назви монет, теги, коментар, сума. q — уже через searchKey. */
function opMatches(op, q) {
  if (!q) return true;
  const hay = [coinOr(op.from).name, coinOr(op.to).name, ...(op.tags ?? []).map((t) => `#${t}`), op.comment ?? '', String(op.amount)]
    .map(searchKey).join(' ');
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** Зміна в гривнях від знайдених операцій: доходи плюс, витрати мінус, перекази не рахуються. */
function opsChange(list) {
  let v = 0;
  for (const op of list) {
    if (op.plan) continue;
    const t = opType(op);
    if (t === 'expense') v -= toUah(amountIn(op), coinOr(op.to).currency);
    else if (t === 'income') v += toUah(op.amount, coinOr(op.from).currency);
  }
  return v;
}

const signedUah = (v) => M.money(v, 'UAH', { sign: v > 0 ? '+ ' : v < 0 ? '− ' : '' });

// Усі операції новіші першими — сортуємо раз на зміну даних, а не на кожне відкриття стрічки
const newestOps = () => cached('newest', () => [...state.ops].sort(byNewest));

/** Зливає два вже впорядковані списки в один, теж новіші першими. */
function mergeNewest(a, b) {
  if (!b.length) return a;
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(byNewest(a[i], b[j]) <= 0 ? a[i++] : b[j++]);
  return out.concat(a.slice(i), b.slice(j));
}

/** Операції під поточні монету, тип і пошук стрічки — новіші першими; withPlanned — разом із запланованими. */
const feedOps = (withPlanned, q = searchKey(feedQuery)) => mergeNewest(newestOps(), withPlanned ? [...planned()].sort(byNewest) : [])
  .filter((op) => !feedCoin || op.from === feedCoin || op.to === feedCoin)
  .filter((op) => feedType === 'all' || opType(op) === feedType)
  .filter((op) => opMatches(op, q));

/** Список днів стрічки під поточні монету, пошук і тип. */
function feedList(lazy = false) {
  const q = searchKey(feedQuery);
  const filtered = Boolean(q) || feedType !== 'all';
  const ops = feedOps(true, q);
  if (!ops.length) {
    return [h('p', { class: 'empty' }, filtered ? 'Нічого не знайдено'
      : feedCoin ? 'У цієї монети ще немає операцій' : 'Ще немає операцій — потягни монету на головній')];
  }
  const days = [...new Set(ops.map((op) => op.date))];
  const shown = days.slice(0, feedDays);
  // Залишок на кінець дня: від сьогоднішнього відкочуємо зміни пізніших днів — усіх, не лише показаних
  const delta = new Map();
  for (const op of state.ops) delta.set(op.date, (delta.get(op.date) ?? 0) + accDelta(op));
  const deltaDays = [...delta.keys()].sort().reverse();
  let bal = totalBalance();
  let i = 0;
  const balAt = (date) => {
    while (i < deltaDays.length && deltaDays[i] > date) { bal -= delta.get(deltaDays[i]); i += 1; }
    return bal;
  };
  const today = M.ymd();
  const out = [];
  if (filtered) {
    const real = ops.filter((op) => !op.plan);
    out.push(h('p', { class: 'feed-found' }, `Знайдено: ${real.length}`, feedType === 'transfer' ? null : h('b', {}, signedUah(opsChange(real)))));
  }
  const byDay = Map.groupBy(ops, (op) => op.date);
  const daySection = (date) => {
    const dayOps = byDay.get(date);
    let foot;
    if (feedCoin) foot = coinDayFoot(coin(feedCoin), dayOps);
    else if (filtered) {
      // Під пошуком «на рахунках» не про знайдене — лише сума знайденого за день
      const v = opsChange(dayOps);
      foot = feedType === 'transfer' ? null : h('div', { class: 'day-foot' }, h('div', {}),
        h('div', {}, h('b', { class: v > 0 ? 'plus' : v < 0 ? 'minus' : '' }, signedUah(v)), h('span', {}, 'знайдене')));
    } else {
      const { expense, income } = totals(date);
      const change = income - expense;
      foot = h('div', { class: 'day-foot' },
        h('div', {}, h('b', {}, M.money(Math.round(balAt(date)))), h('span', {}, 'на рахунках')),
        h('div', {}, h('b', { class: change > 0 ? 'plus' : change < 0 ? 'minus' : '' }, signedUah(change)), h('span', {}, 'зміна')));
    }
    return h('section', { class: 'day' }, h('h2', { class: 'day-title' }, M.dayHead(date, today)),
      h('div', { class: 'card' }, dayOps.map(opRow), foot));
  };
  const more = days.length > shown.length
    ? h('button', { type: 'button', class: 'more-btn', onClick: () => { feedDays += 60; render(); } }, 'Показати ще') : null;
  // Перший екран — одразу, решту днів дошиваємо порціями між кадрами: на сотнях операцій стрічка не підвисає
  if (!lazy || shown.length <= FEED_FIRST) return [...out, ...shown.map(daySection), more];
  out.push(...shown.slice(0, FEED_FIRST).map(daySection));
  const rest = h('div', { class: 'feed-rest', 'aria-hidden': 'true' });
  let next = FEED_FIRST;
  const chunk = () => {
    if (!rest.isConnected) return;
    rest.before(...shown.slice(next, next + FEED_CHUNK).map(daySection));
    next += FEED_CHUNK;
    if (next < shown.length) later(chunk);
    else rest.replaceWith(...(more ? [more] : []));
  };
  // Наступна порція — вже після кадру: інакше таймер устигав би раніше за малювання і перший екран чекав би все
  const later = (fn) => requestAnimationFrame(() => setTimeout(fn, 0));
  later(chunk);
  return [...out, rest];
}

function viewFeed() {
  const list = h('div', { class: 'stack feed' }, feedList(feedLazy));
  feedLazy = false;
  let timer = 0;
  const search = h('input', {
    type: 'search', class: 'field', value: feedQuery, enterkeyhint: 'search', 'aria-label': 'Пошук у стрічці',
    placeholder: feedCoin ? 'Пошук: тег, коментар, сума…' : 'Пошук: рахунок, категорія, тег, коментар…',
    // Список — без перемальовування всього екрана: поле не втрачає фокус і клавіатура не ховається
    onInput: (e) => { feedQuery = e.target.value; clearTimeout(timer); timer = setTimeout(() => list.replaceChildren(...feedList(true)), 150); },
  });
  const types = feedCoin ? null : chips(FEED_TYPES, feedType, (v) => { feedType = v; list.replaceChildren(...feedList(true)); });
  return h('div', { class: 'page stack feed-page' }, feedCoin ? budgetCard(coin(feedCoin)) : null, h('div', { class: 'feed-tools' }, search, types), list);
}

/** Ліміт монети смужкою в її стрічці (під монетою на головній цифри немає); колір — за темпом, як у монети. */
function budgetCard(c) {
  if (!c?.budget || (c.kind !== 'expense' && c.kind !== 'goal')) return null;
  const goal = c.kind === 'goal';
  const done = goal ? balance(c) : monthSpent(c, currentPeriod());
  const st = goal ? (done >= c.budget ? 'done' : '') : coinBudget(c, done).st;
  const left = c.budget - done;
  const m = (v) => M.money(v, c.currency);
  return h('div', { class: `card budget-card${st ? ` st-${st}` : ''}` },
    h('div', { class: 'budget-nums' },
      h('span', {}, goal ? 'Зібрано ' : 'Витрачено ', h('b', {}, m(done)), ` з ${m(c.budget)}`),
      h('b', { class: left < 0 ? 'minus' : '' }, left < 0 ? `понад ${m(-left)}` : goal ? `ще ${m(left)}` : `лишилось ${m(left)}`)),
    h('div', { class: 'budget-bar' }, h('span', { style: { width: `${Math.min(100, Math.max(0, (done / c.budget) * 100))}%` } })));
}

// ---------- звіти ----------

const SLOTS = 7;

const customPeriod = () => Boolean(reportFilter.from || reportFilter.to);
const firstOpDate = () => state.ops.reduce((m, op) => (op.date < m ? op.date : m), M.ymd());

/** Межі звіту: свій період з фільтра або місяць, що гортається. Дати — рядки «РРРР-ММ-ДД», порівнюються як рядки. */
function reportRange() {
  if (customPeriod()) return [reportFilter.from || firstOpDate(), reportFilter.to || M.ymd()];
  return periodRange(reportMonth);
}

const dmy = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(0, 4)}`;
// У центр кільця — коротше: рік один раз, якщо він спільний
function shortRange() {
  const [lo, hi] = reportRange();
  return lo.slice(0, 4) === hi.slice(0, 4) ? `${dmy(lo).slice(0, 5)} – ${dmy(hi)}` : `${dmy(lo)} – ${dmy(hi)}`;
}
const reportTitle = () => (customPeriod() ? reportRange().map(dmy).join(' – ') : periodTitle(reportMonth));

/** Операції звіту в гривнях: потрібного типу, у межах періоду, з вибраних рахунків. */
function reportItems(kind) {
  const [lo, hi] = reportRange();
  const out = [];
  for (const op of state.ops) {
    if (op.date < lo || op.date > hi || opType(op) !== kind) continue;
    // Рахунок, з якого витрачено чи на який прийшов дохід
    const acc = kind === 'expense' ? op.from : op.to;
    if (reportFilter.accounts && !reportFilter.accounts.includes(acc)) continue;
    const c = coinOr(kind === 'expense' ? op.to : op.from);
    out.push({ op, c, v: kind === 'expense' ? toUah(amountIn(op), c.currency) : toUah(op.amount, c.currency) });
  }
  return out;
}

/**
 * Частки звіту: [{ c, v, color }] за спаданням; понад 7 — у «Інше».
 * За тегами: операція з кількома тегами йде в кожен, без тегів — у «Без тегу».
 */
function reportParts(kind) {
  const sums = new Map();
  for (const { op, c, v } of reportItems(kind)) {
    const keys = reportTags ? (op.tags?.length ? op.tags : ['']) : [c.id];
    for (const k of keys) sums.set(k, (sums.get(k) ?? 0) + v);
  }
  const list = [...sums]
    .map(([k, v]) => ({ c: reportTags ? { id: `tag:${k}`, name: k ? `#${k}` : 'Без тегу', tag: k } : coinOr(k), v }))
    .filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  // «Інше» з однієї частки нічого не ховає — тоді вона йде восьмою своїм кольором
  const slots = list.length === SLOTS + 1 ? SLOTS + 1 : SLOTS;
  const top = list.slice(0, slots).map((x, i) => ({ ...x, color: `var(--s${i + 1})` }));
  const rest = list.slice(slots);
  if (rest.length) top.push({ c: { id: 'other', name: `Інше (${rest.length})` }, v: rest.reduce((s, x) => s + x.v, 0), color: 'var(--s-other)', rest });
  return top;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Кільце часток із підписами відсотків на виносках, як у звіті «Загальний».
 * Виноска: від кільця назовні, далі горизонтальна полиця; підписи з одного боку не налазять — зсуваємо вниз.
 */
function donut(parts, total, center) {
  const R = 100;
  const C = 2 * Math.PI * R;
  const GAP = parts.length > 1 ? 2.5 : 0;
  const svg = svgEl('svg', { viewBox: '-170 -135 340 270', role: 'img' });
  svg.setAttribute('aria-label', parts.map((p) => `${p.c.name} ${Math.round((p.v / total) * 100)}%`).join(', '));
  const labels = [];
  let acc = 0;
  for (const p of parts) {
    const share = p.v / total;
    const len = Math.max(share * C - GAP, 0.5);
    const seg = svgEl('circle', {
      r: R, class: `donut-seg${reportPick && reportPick !== p.c.id ? ' dim' : ''}`, stroke: p.color,
      'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -acc * C, transform: 'rotate(-90)',
    });
    const title = svgEl('title', {});
    title.textContent = `${p.c.name}: ${M.money(p.v)}`;
    seg.append(title);
    seg.addEventListener('click', () => { reportPick = reportPick === p.c.id ? null : p.c.id; render(); });
    svg.append(seg);
    if (share >= 0.03) {
      const mid = (acc + share / 2) * 2 * Math.PI - Math.PI / 2;
      labels.push({ mid, color: p.color, text: `${Math.round(share * 100)}%`, right: Math.cos(mid) >= 0 });
    }
    acc += share;
  }
  // Виноски: точка на кільці → злам на R+18 → полиця до краю; по боках — не ближче 15 одиниць по висоті
  for (const side of [true, false]) {
    const list = labels.filter((l) => l.right === side)
      .map((l) => ({ ...l, x1: Math.cos(l.mid) * (R + 8), y1: Math.sin(l.mid) * (R + 8), y: Math.sin(l.mid) * (R + 22) }))
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < list.length; i++) list[i].y = Math.max(list[i].y, list[i - 1].y + 15);
    for (const l of list) {
      const xk = Math.cos(l.mid) * (R + 22);
      const xe = side ? Math.max(xk + 12, R + 34) : Math.min(xk - 12, -R - 34);
      svg.append(svgEl('polyline', { points: `${l.x1},${l.y1} ${xk},${l.y} ${xe},${l.y}`, class: 'donut-lead', stroke: l.color }));
      const t = svgEl('text', { x: xe + (side ? 3 : -3), y: l.y + 4, 'text-anchor': side ? 'start' : 'end', class: 'donut-label' });
      t.textContent = l.text;
      svg.append(t);
    }
  }
  return h('div', { class: 'donut-box' }, svg, h('div', { class: 'donut-center' }, center));
}

function periodNav(title, step) {
  const nav = h('div', { class: 'period' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Назад', onClick: () => step(-1) }, icon('prev')),
    h('h2', {}, title),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Вперед', onClick: () => step(1) }, icon('next')));
  return nav;
}

// Відхилення від середнього, з якого його видно: менше — звичайне коливання
const DELTA_SHOWN = 0.2;

function viewReport() {
  const parts = reportParts(reportKind);
  const total = parts.reduce((s, p) => s + p.v, 0);
  // Справжня сума: за тегами операція з кількома тегами рахується в частках кілька разів, у підсумку — раз
  const real = reportItems(reportKind).reduce((s, x) => s + x.v, 0);
  const picked = parts.find((p) => p.c.id === reportPick);
  const stepMonth = (n) => { reportMonth = M.addMonths(reportMonth, n); reportPick = null; render(); return true; };
  const custom = customPeriod();
  const nav = custom
    ? h('div', { class: 'period' },
      h('h2', {}, reportTitle()),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Повернутись до місяців', onClick: () => { reportFilter.from = ''; reportFilter.to = ''; reportPick = null; render(); } }, icon('close')))
    : periodNav(reportTitle(), stepMonth);
  const what = reportKind === 'expense' ? 'витрат' : 'доходів';
  // Монета проти свого середнього за 3 попередні місяці; поточний — за темпом, як колір монет.
  // На початку місяця, зі своїм періодом чи фільтром рахунків порівнювати нема з чим
  const el = reportMonth === currentPeriod() ? periodElapsed(reportMonth) : 1;
  const compare = reportKind === 'expense' && !reportTags && !filterOn() && el >= 0.25;
  const delta = (p) => {
    const a = compare && !p.rest ? avgSpent(p.c, reportMonth) : null;
    const r = a?.avg > 0 ? p.v / (toUah(a.avg, p.c.currency) * el) - 1 : 0;
    const big = Math.abs(r) >= DELTA_SHOWN;
    return h('span', { class: `rep-delta${big ? (r > 0 ? ' up' : ' down') : ''}`, title: big ? `Порівняно із середнім за ${a.n} міс.` : null },
      big ? `${r > 0 ? '↑' : '↓'} ${Math.round(Math.abs(r) * 100)}%` : '');
  };
  const body = h('div', { class: 'page stack' },
    nav,
    total ? donut(parts, total, picked
      ? [h('span', {}, picked.c.name), h('b', {}, M.money(picked.v)), h('span', {}, `${Math.round((picked.v / total) * 100)}%`)]
      : [h('span', {}, reportKind === 'expense' ? 'витрати' : 'доходи'), h('b', {}, M.money(real))])
      : h('p', { class: 'empty' }, custom ? `За цей період ${what} немає` : `Цього місяця ${what} немає`),
    total ? h('div', { class: 'card' }, parts.map((p) => h('button', {
      type: 'button', class: `rep-row${reportPick === p.c.id ? ' on' : ''}`,
      onClick: () => {
        // Тег і «Інше» — підсвітити в кільці; монета — її стрічка
        if (p.rest || reportTags) { reportPick = reportPick === p.c.id ? null : p.c.id; render(); } else openFeed(p.c.id);
      },
    },
    h('span', { class: 'rep-dot', style: { background: p.color } }),
    h('span', { class: 'rep-name' }, p.c.name),
    delta(p),
    h('span', { class: 'rep-pct' }, `${Math.round((p.v / total) * 100)}%`),
    h('span', { class: 'rep-sum' }, M.money(p.v))))) : null);
  if (!custom) swipeStep(body, stepMonth);
  const tab = (k, label) => h('button', { type: 'button', class: reportKind === k ? 'on' : '', onClick: () => { reportKind = k; reportPick = null; render(); } }, label);
  return h('div', {}, h('div', { class: 'tabs-bar' }, tab('expense', 'Витрати'), tab('income', 'Доходи')), body);
}

/** Фільтри звіту: свій період (початок і кінець) і рахунки, з яких рахувати. */
function openReportFilter() {
  const accs = state.coins.filter((c) => c.kind === 'account' && !c.archived).sort((a, b) => a.order - b.order);
  const [lo, hi] = reportRange();
  const from = h('input', { type: 'date', class: 'field', value: lo, max: M.ymd(), 'aria-label': 'Початок' });
  const to = h('input', { type: 'date', class: 'field', value: hi > M.ymd() ? M.ymd() : hi, 'aria-label': 'Кінець' });
  const chosen = new Set(reportFilter.accounts ?? accs.map((c) => c.id));
  const boxes = accs.map((c) => h('input', { type: 'checkbox', checked: chosen.has(c.id), 'data-id': c.id }));
  const all = h('input', { type: 'checkbox', checked: chosen.size === accs.length });
  all.addEventListener('change', () => { for (const b of boxes) b.checked = all.checked; });
  for (const b of boxes) b.addEventListener('change', () => { all.checked = boxes.every((x) => x.checked); });
  const row = (label, box) => h('label', { class: 'check-row' }, h('span', {}, label), box);
  const apply = () => {
    const ids = boxes.filter((b) => b.checked).map((b) => b.dataset.id);
    if (!ids.length) { toast('Вибери хоча б один рахунок'); return; }
    // Дати не чіпали — лишаємо гортання місяцями
    if (from.value !== lo || to.value !== (hi > M.ymd() ? M.ymd() : hi)) {
      reportFilter.from = from.value || '';
      reportFilter.to = to.value || '';
      if (reportFilter.from && reportFilter.to && reportFilter.from > reportFilter.to) [reportFilter.from, reportFilter.to] = [reportFilter.to, reportFilter.from];
    }
    reportFilter.accounts = ids.length === accs.length ? null : ids;
    reportPick = null;
    closeSheet();
    render();
  };
  const reset = () => {
    Object.assign(reportFilter, { from: '', to: '', accounts: null });
    reportPick = null;
    closeSheet();
    render();
  };
  sheet('Фільтри', h('div', { class: 'form filter-form' },
    h('p', { class: 'filter-head' }, 'Звітний період'),
    h('label', { class: 'check-row' }, h('span', {}, 'Початок'), from),
    h('label', { class: 'check-row' }, h('span', {}, 'Кінець'), to),
    h('p', { class: 'filter-head' }, 'Рахунки'),
    row('Вибрати всі', all),
    accs.map((c, i) => row(c.name, boxes[i])),
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn', onClick: reset }, icon('undo'), 'Скинути'),
      h('button', { type: 'button', class: 'btn primary', onClick: apply }, icon('check'), 'Готово'))));
}

const filterOn = () => customPeriod() || Boolean(reportFilter.accounts);

function viewDays() {
  const step = (n) => { dayDate = M.addDays(dayDate, n); render(); return true; };
  const rows = new Map();
  for (const op of state.ops) {
    if (op.date !== dayDate) continue;
    const t = opType(op);
    if (t === 'transfer') continue;
    const c = coinOr(t === 'expense' ? op.to : op.from);
    const v = t === 'expense' ? -toUah(amountIn(op), c.currency) : toUah(op.amount, c.currency);
    const key = c.id ?? c.name;
    rows.set(key, { name: c.name, v: (rows.get(key)?.v ?? 0) + v });
  }
  const list = [...rows.values()].sort((a, b) => b.v - a.v);
  const { expense, income } = totals(dayDate);
  const net = income - expense;
  const signed = (v) => M.money(v, 'UAH', { sign: v > 0 ? '+ ' : v < 0 ? '− ' : '' });
  const body = h('div', { class: 'page stack' },
    periodNav(M.dateTitle(dayDate), step),
    h('div', { class: `big-total ${net > 0 ? 'plus' : net < 0 ? 'minus' : ''}` }, signed(net)),
    list.length ? h('div', { class: 'card' }, list.map((r) => h('div', { class: 'kv' },
      h('span', {}, r.name), h('span', { class: r.v > 0 ? 'plus' : 'minus' }, signed(r.v)))))
      : h('p', { class: 'empty' }, 'Цього дня доходів і витрат немає'),
    isFreeDay(dayDate) ? freeDayCard(dayDate) : null,
    // Підсумок має сенс, коли були і дохід, і витрата: інакше він повторює велику суму вгорі
    income && expense ? h('div', { class: 'card' },
      h('div', { class: 'kv' }, h('b', {}, 'Дохід'), h('span', { class: 'plus' }, signed(income))),
      h('div', { class: 'kv' }, h('b', {}, 'Витрата'), h('span', { class: 'minus' }, signed(-expense)))) : null);
  return swipeStep(body, step);
}

/** День без трат: скільки поспіль і скільки таких у місяці; регулярні платежі не рахуються. */
function freeDayCard(date) {
  const n = freeStreak(date);
  return h('div', { class: 'card free-day' },
    icon('flame'),
    h('div', {},
      h('b', {}, n > 1 ? `${n} ${daysWord(n)} без трат поспіль` : 'День без трат'),
      h('p', { class: 'muted small' }, `У цьому місяці таких днів: ${freeDaysIn(periodOf(date))}. Регулярні платежі не рахуються.`)));
}

// ---------- редагування монети ----------

const NEW_ICON = { account: 'wallet', income: 'banknote', expense: 'shopping-cart', goal: 'piggy-bank', debt: 'handshake' };
const GRID_KINDS = [['expense', 'Витрата'], ['goal', 'Ціль']];
const ROW_KINDS = [['account', 'Рахунок'], ['debt', 'Борг']];

// Пошук без різниці між великими літерами й видами апострофа
const searchKey = (s) => s.toLocaleLowerCase('uk').replace(/[’ʼ`]/g, "'").trim();

/** Іконки групами з підзаголовками (гроші, продукти, дім…), зверху — пошук за назвою; як у Хобі-плані. */
function iconPicker(d) {
  const buttons = [];
  const current = h('span', { class: 'icon-pick-now' });
  const paint = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === d.icon));
    current.replaceChildren(icon(hasIcon(d.icon) ? d.icon : 'coins'));
  };
  const groups = M.ICON_GROUPS.map((g) => {
    const row = h('div', { class: 'icon-row', role: 'group', 'aria-label': g.title });
    for (const [key, name] of g.icons) {
      if (!hasIcon(key)) continue;
      const b = h('button', {
        type: 'button', class: 'icon-opt', 'aria-label': name, title: name, 'data-v': key,
        onClick: () => { d.icon = key; paint(); },
      }, icon(key));
      b.dataset.find = searchKey(name);
      buttons.push(b);
      row.append(b);
    }
    // Групи згорнуті; розгорнута та, де поточна іконка
    const mine = g.icons.some(([k]) => k === d.icon);
    const el = h('details', { class: 'icon-group', open: mine },
      h('summary', { class: 'icon-group-title' }, h('span', {}, g.title), h('span', { class: 'icon-group-count' }, String(row.childElementCount))), row);
    el.dataset.find = searchKey(g.title);
    el.dataset.mine = mine ? '1' : '';
    return el;
  });
  const empty = h('p', { class: 'muted small', hidden: true }, 'Нічого не знайдено');
  // Назва групи теж шукається: «транспорт» показує всю групу
  const filter = (q) => {
    let shown = 0;
    for (const g of groups) {
      const whole = !q || g.dataset.find.includes(q);
      let inGroup = 0;
      for (const b of g.querySelectorAll('.icon-opt')) {
        b.hidden = !(whole || b.dataset.find.includes(q));
        if (!b.hidden) inGroup += 1;
      }
      g.hidden = inGroup === 0;
      // Під час пошуку знайдене видно одразу; порожній пошук — згорнути назад
      g.open = q ? inGroup > 0 : g.dataset.mine === '1';
      shown += inGroup;
    }
    empty.hidden = shown > 0;
  };
  const search = h('input', {
    type: 'search', class: 'field', placeholder: 'Пошук: кава, таксі, ліки…', 'aria-label': 'Пошук іконки', enterkeyhint: 'search',
    onInput: (e) => filter(searchKey(e.target.value)),
  });
  paint();
  // Увесь вибір — одним рядком, що розгортається: інакше до «Зберегти» довго гортати
  return h('details', { class: 'icon-pick-all' },
    h('summary', {}, current, h('span', {}, 'Іконка'), h('span', { class: 'muted small' }, 'змінити')),
    h('div', { class: 'icon-picker' }, search, h('div', { class: 'icon-groups' }, empty, groups)));
}

function editCoin(orig, kind = orig?.kind) {
  const d = orig ? structuredClone(orig)
    : { id: uid(), kind, name: '', icon: NEW_ICON[kind], currency: 'UAH', budget: 0, start: 0, order: Date.now(), archived: false };
  // Рахунок і ціль тримають гроші — у них задають залишок
  const holds = kind === 'account' || kind === 'goal';
  const used = orig && state.ops.some((op) => op.from === orig.id || op.to === orig.id);
  const name = h('input', { type: 'text', maxlength: 30, value: d.name, placeholder: 'Назва', autocomplete: 'off', 'aria-label': 'Назва' });
  const amountField = (value, label) => h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: value || '', placeholder: '0', 'aria-label': label });
  const budgetLabel = { income: 'План на місяць (не обов’язково)', expense: 'Бюджет на місяць', goal: 'Скільки треба зібрати' }[kind];
  const budget = amountField(d.budget, budgetLabel);
  // Порада — середня витрата за попередні місяці, вгору до сотень; поле заповнює тап, зберігаєш сам
  const advice = orig && kind === 'expense' ? avgSpent(orig, currentPeriod()) : null;
  const advised = advice?.avg > 0 ? Math.ceil(advice.avg / 100) * 100 : 0;
  const adviceBtn = advised ? h('button', { type: 'button', class: 'chip advice', onClick: () => { budget.value = String(advised); } },
    `Порадь: ${M.money(advised, d.currency)} — середнє за ${advice.n} міс.`) : null;
  const startLabel = kind === 'goal' ? 'Уже відкладено' : 'Залишок зараз';
  const start = amountField(orig ? balance(orig) : 0, startLabel);
  const grid = iconPicker(d);
  // Борг: напрям і сума зараз, дата повернення, чи входить у «Баланс»
  const debt = kind === 'debt';
  const debtNow = orig && debt ? balance(orig) : 0;
  const dir = { v: debtNow < 0 ? 'owe' : 'owed' };
  const debtSum = amountField(Math.abs(debtNow), 'Сума боргу зараз');
  const due = h('input', { type: 'date', class: 'field', value: d.due ?? '', 'aria-label': 'Повернути до' });
  const counted = h('input', { type: 'checkbox', checked: Boolean(d.inBalance) });
  const store = async () => {
    const rec = { ...d, name: name.value.trim() };
    if (!rec.name) { toast(debt ? 'Напиши, хто' : 'Дай назву'); return; }
    rec.budget = Math.max(0, Number(budget.value) || 0);
    if (debt) {
      rec.budget = 0;
      rec.due = due.value || '';
      rec.inBalance = counted.checked;
      // Як у рахунку: «скільки зараз» → стартовий залишок, операції не чіпаємо
      const now = (dir.v === 'owe' ? -1 : 1) * (Number(debtSum.value) || 0);
      rec.start = M.round2((d.start || 0) + now - debtNow);
    }
    if (holds) {
      // Залишок задають «скільки зараз»: різницю переносимо в стартовий, операції не чіпаємо
      const now = kind === 'goal' ? Math.max(0, Number(start.value) || 0) : Number(start.value) || 0;
      rec.start = M.round2((d.start || 0) + now - (orig ? balance(orig) : 0));
    }
    closeSheet();
    await save({ coins: { put: [rec] } });
  };
  const remove = async () => {
    closeSheet();
    await removeCoin(orig);
  };
  sheet(orig ? orig.name : `Нова монета: ${M.KINDS[kind].toLowerCase()}`, h('div', { class: 'form' },
    // Нова монета в сітці витрат: витрата чи ціль — інший тип перемальовує форму
    !orig && (kind === 'expense' || kind === 'goal')
      ? [h('p', { class: 'flabel' }, 'Тип'), chips(GRID_KINDS, kind, (v) => { if (v !== kind) editCoin(null, v); })] : null,
    !orig && (kind === 'account' || kind === 'debt')
      ? [h('p', { class: 'flabel' }, 'Тип'), chips(ROW_KINDS, kind, (v) => { if (v !== kind) editCoin(null, v); })] : null,
    kind === 'goal' ? h('p', { class: 'muted small' }, 'Відкладене: гроші з рахунку переносиш сюди перетягуванням. У «Баланс» і у витрати не входять.') : null,
    debt ? h('p', { class: 'muted small' }, 'Дав у борг — тягни рахунок на цю монету; позичив чи тобі повертають — тягни її на рахунок. Ні витратою, ні доходом це не рахується.') : null,
    h('label', { class: 'flabel' }, debt ? 'Хто' : 'Назва'), name,
    !used ? [h('p', { class: 'flabel' }, 'Валюта'), chips(M.CURRENCIES, d.currency, (v) => { d.currency = v; })]
      : kind !== 'expense' ? h('p', { class: 'muted small' }, `Валюта: ${d.currency} — змінити не можна, бо вже є операції`) : null,
    debt ? [
      h('p', { class: 'flabel' }, 'Зараз'), chips([['owed', 'Мені винні'], ['owe', 'Я винен']], dir.v, (v) => { dir.v = v; }),
      h('label', { class: 'flabel' }, 'Сума боргу зараз (0 — почнеш з перетягування)'), debtSum,
      h('label', { class: 'flabel' }, 'Повернути до (не обов’язково)'), due,
      h('label', { class: 'check-row' }, h('span', {}, 'Враховувати в «Баланс»'), counted),
    ] : null,
    kind !== 'account' && !debt ? [h('label', { class: 'flabel' }, budgetLabel), budget, adviceBtn] : null,
    holds ? [h('label', { class: 'flabel' }, startLabel), start] : null,
    grid,
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn primary', onClick: store }, icon('check'), 'Зберегти'),
      orig ? h('button', { type: 'button', class: 'btn danger', onClick: remove }, icon('trash'), used ? 'Сховати' : 'Видалити') : null)));
}

// ---------- налаштування ----------

const THEMES = [['auto', 'Як у системі'], ['light', 'Світла'], ['dark', 'Темна']];

/** «Вхід за відбитком»: увімкнути, через скільки блокувати у фоні, вимкнути з підтвердженням. */
function lockCard() {
  const body = h('div', {});
  const act = (fn, done) => async () => {
    try {
      await fn();
      toast(done);
    } catch (err) {
      if (err?.name !== 'NotAllowedError') toast(`Помилка: ${err?.message || err}`);
    }
    render();
  };
  if (lockOn()) {
    body.append(
      h('p', { class: 'muted small' }, 'Блокувати після згортання:'),
      chips(LOCK_DELAYS.map((m) => [String(m), m ? `${m} хв` : 'Одразу']), String(lockDelay()), (v) => setLockDelay(Number(v))),
      h('div', { class: 'btn-grid' }, h('button', { type: 'button', class: 'btn', onClick: act(disableLock, 'Вхід за відбитком вимкнено') }, 'Вимкнути')));
  } else {
    lockAvailable().then((ok) => body.append(ok
      ? h('div', { class: 'btn-grid' }, h('button', { type: 'button', class: 'btn primary', onClick: act(enableLock, 'Вхід за відбитком увімкнено') }, 'Увімкнути'))
      : h('p', { class: 'muted small' }, 'На цьому пристрої немає відбитка, обличчя чи PIN-коду, які браузер може перевірити.')));
  }
  return h('section', { class: 'card set-card' }, h('h2', {}, 'Вхід за відбитком'),
    h('p', { class: 'muted small' }, 'Відбиток, обличчя чи PIN-код телефона — лише на цьому пристрої.'),
    body,
    moreText('Це захист від чужих очей: дані на телефоні не шифруються.'));
}

function applyTheme() {
  const pref = recall('theme') || 'auto';
  const light = pref === 'light' || (pref === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', light ? '#ffffff' : '#1b1e22');
}

/** Курс НБУ на сьогодні; власний курс (manual) не перезаписуємо. */
async function fetchRates(force = false) {
  const m = ratesMeta();
  const today = M.ymd();
  if (!force && (m.manual || m.date === today)) return false;
  const res = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?date=${today.replaceAll('-', '')}&json`);
  if (!res.ok) throw new Error(`НБУ відповів ${res.status}`);
  const list = await res.json();
  const get = (cc) => list.find((x) => x.cc === cc)?.rate;
  if (!get('USD')) throw new Error('НБУ не дав курсу');
  await save({ meta: { put: [{ id: 'rates', USD: get('USD'), EUR: get('EUR') ?? m.EUR, date: today, manual: false }] } }, { redraw: false });
  return true;
}

function periodCard() {
  const day = startDay();
  const select = h('select', {
    class: 'field', 'aria-label': 'День початку місяця',
    onChange: async (e) => {
      await save({ meta: { put: [{ id: 'period', day: Number(e.target.value) }] } }, { redraw: false });
      reportMonth = currentPeriod();
      render();
      toast(Number(e.target.value) === 1 ? 'Місяць — календарний' : `Місяць обліку — з ${e.target.value}-го`);
    },
  }, Array.from({ length: 28 }, (_, i) => h('option', { value: String(i + 1), selected: i + 1 === day }, i === 0 ? '1 — календарний місяць' : `${i + 1}-го числа`)));
  return h('section', { class: 'card set-card' },
    h('h2', {}, 'Початок місяця'),
    h('p', { class: 'muted small' }, 'З якого дня рахувати бюджети й звіти — зручно з дня зарплати.'),
    select,
    day === 1 ? null : h('p', { class: 'muted small' }, `Зараз: ${periodTitle(currentPeriod())}`));
}

function viewSettings() {
  const m = ratesMeta();
  const rateInput = (cc) => h('input', {
    type: 'number', inputmode: 'decimal', step: '0.0001', min: '0', value: String(m[cc] ?? ''), class: 'field', 'aria-label': `Курс ${cc}`,
    onChange: async (e) => {
      const v = Number(e.target.value);
      if (!(v > 0)) return;
      await save({ meta: { put: [{ ...ratesMeta(), [cc]: v, manual: true }] } }, { redraw: false });
      toast(`Свій курс ${cc}: ${v}`);
    },
  });
  const rateStatus = h('p', { class: 'muted small' }, m.manual ? 'Свій курс — НБУ не підтягується' : m.date ? `Курс НБУ на ${M.dateTitle(m.date)}` : 'Курс за замовчуванням — підтягну НБУ, щойно буде зв’язок');
  const file = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onChange: (e) => importBackup(e.target.files[0]) });
  const csvFile = h('input', { type: 'file', accept: '.csv,text/csv,text/plain', hidden: true, onChange: (e) => { importCsv(e.target.files[0]); e.target.value = ''; } });
  const theme = chips(THEMES, recall('theme') || 'auto', (v) => { remember('theme', v); applyTheme(); });
  // Порядок — від того, що чіпають найчастіше, до разового: облік, вигляд, синхронізація, телефон, копії, про застосунок
  return h('div', { class: 'page' },
    settingsGroup('Облік', [periodCard(),
      h('section', { class: 'card set-card' },
        h('h2', {}, 'Курси до гривні'),
        h('div', { class: 'rate-row' },
          h('label', {}, h('b', {}, '$'), rateInput('USD')),
          h('label', {}, h('b', {}, '€'), rateInput('EUR'))),
        h('div', { class: 'row-between' },
          rateStatus,
          h('button', {
            type: 'button', class: 'btn', onClick: async () => {
              try { await fetchRates(true); toast('Курс НБУ оновлено'); render(); } catch (err) { toast(err instanceof TypeError ? 'Немає зв’язку з НБУ' : err.message); }
            },
          }, icon('refresh'), 'НБУ')))], { fold: 'account' }),
    settingsGroup(`Теги · ${allTags().length}`, [tagsCard()], { fold: 'tags' }),
    settingsGroup(`Сховані монети · ${state.coins.filter((c) => c.archived).length}`, [hiddenCard()], { fold: 'hidden' }),
    settingsGroup('Вигляд і вхід', [h('section', { class: 'card set-card' }, h('h2', {}, 'Тема'), theme), lockCard()], { fold: 'look' }),
    settingsGroup('Синхронізація', [botCard(), syncCard()], { fold: 'sync' }),
    settingsGroup('На телефоні', [widgetCard(), telegramCard()], { fold: 'phone' }),
    settingsGroup('Копії й імпорт', [
      h('section', { class: 'card set-card' },
        h('h2', {}, 'Копія у файл'),
        h('p', { class: 'muted small' }, 'Файл JSON з усіма даними — щоб відновити тут чи на іншому телефоні.'),
        h('div', { class: 'btn-grid' },
          h('button', { type: 'button', class: 'btn', onClick: exportBackup }, icon('archive'), 'Зберегти'),
          h('button', { type: 'button', class: 'btn', onClick: () => file.click() }, icon('undo'), 'Відновити')),
        file),
      h('section', { class: 'card set-card' },
        h('h2', {}, 'Таблиця CSV'),
        h('p', { class: 'muted small' }, 'Операції з таблиці; в таблицю стрічку зберігає кнопка вгорі стрічки.'),
        h('div', { class: 'btn-grid' }, h('button', { type: 'button', class: 'btn', onClick: () => csvFile.click() }, icon('upload'), 'Імпорт з CSV')),
        moreText('Колонки «Дата», «Звідки», «Куди», «Сума», за бажанням — «Тип», «Валюта», «Теги», «Коментар». Монети шукаю за назвою, яких нема — створю; те, що вже є, пропущу.'),
        csvFile)], { fold: 'data' }),
    settingsGroup('Про застосунок', [aboutCard(), aboutPanel()], { fold: 'about' }),
    settingsGroup('Небезпечна зона', [h('section', { class: 'card set-card' },
      h('h2', {}, 'Почати з чистого'),
      h('p', { class: 'muted small' }, Sync.syncOn()
        ? 'Стерти всі монети й операції — тут, на Google Диску й на інших твоїх телефонах. Лишаться стартові монети.'
        : 'Стерти всі монети й операції на цьому телефоні. Лишаться стартові монети.'),
      h('button', { type: 'button', class: 'btn danger', onClick: wipeAll }, icon('close'), 'Стерти всі дані'))], { danger: true }));
}

/** Група налаштувань, як у Стрілецькому журналі: рамка з назвою на лінії, розділи всередині — через лінію. */
/** fold — назва для пам'яті: група згорнута, доки її не розгорнули; порожня згорнута — не показується. */
function settingsGroup(title, sections, { danger = false, fold = '' } = {}) {
  const items = sections.filter(Boolean);
  if (!fold) return h('fieldset', { class: `settings-group${danger ? ' danger' : ''}` }, h('legend', {}, title), items);
  if (!items.length) return null;
  const key = `fold-${fold}`;
  const group = h('fieldset', { class: `settings-group${recall(key) === 'open' ? '' : ' closed'}` });
  const toggle = h('button', {
    type: 'button', class: 'group-toggle', 'aria-expanded': String(!group.classList.contains('closed')), onClick: () => {
      const closed = group.classList.toggle('closed');
      toggle.setAttribute('aria-expanded', String(!closed));
      remember(key, closed ? '' : 'open');
    },
  }, icon('chevron'), title);
  group.append(h('legend', {}, toggle), ...items);
  return group;
}

/** Усі теги з кількістю операцій і пошуком; тап — перейменувати, злити з іншим чи прибрати. Нема тегів — картки нема. */
function tagsCard() {
  const count = new Map();
  for (const op of state.ops) for (const t of op.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1);
  if (!count.size) return null;
  const tags = [...count.keys()].sort((a, b) => a.localeCompare(b, 'uk'));
  const list = h('div', { class: 'chips' });
  const find = h('input', { type: 'search', class: 'field', placeholder: 'Знайти тег', 'aria-label': 'Знайти тег' });
  const draw = () => {
    const q = normTag(find.value);
    const shown = q ? tags.filter((t) => t.includes(q)) : tags;
    list.replaceChildren(...shown.map((t) => h('button', { type: 'button', class: 'chip', onClick: () => editTag(t, count.get(t)) }, `#${t} · ${count.get(t)}`)),
      ...(shown.length ? [] : [h('p', { class: 'muted small' }, 'Такого тегу нема')]));
  };
  find.addEventListener('input', draw);
  draw();
  return h('section', { class: 'card set-card' },
    h('p', { class: 'muted small' }, 'Тап по тегу — перейменувати, злити з іншим чи прибрати з усіх операцій. Великі літери й зайві пробіли прибираю сам.'),
    tags.length > 12 ? find : null, list);
}

/** Шторка одного тегу: нова назва (така, що вже є, — злиття) чи «Прибрати тег»; операції лишаються. */
function editTag(t, n) {
  const input = h('input', { type: 'text', maxlength: 40, value: t, class: 'field', 'aria-label': 'Назва тегу', enterkeyhint: 'done' });
  const note = h('p', { class: 'muted small' });
  const ok = h('button', { type: 'button', class: 'btn primary' }, icon('check'), h('span', {}, 'Зберегти'));
  const paintNote = () => {
    const to = normTag(input.value);
    const into = to && to !== t && allTags().includes(to);
    note.textContent = into ? `#${to} уже є — теги зіллються в один` : '';
    ok.lastChild.textContent = into ? `Злити з #${to}` : 'Зберегти';
  };
  const apply = async () => {
    const to = normTag(input.value);
    closeSheet();
    if (to && to !== t) await retag(t, to);
  };
  input.addEventListener('input', paintNote);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
  ok.addEventListener('click', apply);
  sheet(`#${t}`, h('div', { class: 'form' },
    h('p', {}, `У ${n} ${plural(n, ['операції', 'операціях', 'операціях'])}.`),
    h('label', { class: 'flabel' }, 'Назва'), input, note,
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn danger', onClick: async () => { closeSheet(); await retag(t, ''); } }, icon('close'), 'Прибрати тег'),
      ok)));
}

/** Сховані монети: повернути (сховав помилково) чи видалити разом з операціями. Нема схованих — картки нема. */
function hiddenCard() {
  const list = state.coins.filter((c) => c.archived).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'uk'));
  if (!list.length) return null;
  const opsOf = (c) => state.ops.filter((o) => o.from === c.id || o.to === c.id);
  const restore = async (c) => {
    await save({ coins: { put: [{ ...c, archived: false }] } }, { redraw: false });
    toast(`«${c.name}» повернуто`);
    render();
  };
  const remove = (c) => {
    const ops = opsOf(c);
    // Без операцій залишки інших рахунків зміняться: стерта витрата «повертає» гроші на рахунок, з якого платили
    const shift = new Map();
    for (const o of ops) {
      const [other, d] = o.from === c.id ? [o.to, -amountIn(o)] : [o.from, o.amount];
      const oc = coin(other);
      if (oc && oc.id !== c.id && ['account', 'goal', 'debt'].includes(oc.kind)) shift.set(oc, (shift.get(oc) ?? 0) + d);
    }
    const moved = [...shift].filter(([, d]) => Math.abs(d) >= 0.01);
    sheet(`Видалити «${c.name}»?`, h('div', { class: 'form' },
      h('p', {}, ops.length
        ? `Разом з монетою зникнуть її операції: ${ops.length} — з історії, звітів і «Витрати» за ті місяці.`
        : 'Операцій у монети немає — більше нічого не зміниться.'),
      moved.length ? h('p', { class: 'minus' }, `Зміняться залишки: ${moved.map(([oc, d]) => `${oc.name} ${d > 0 ? '+' : '−'}${M.money(d, oc.currency)}`).join(', ')}.`) : null,
      ops.length ? h('p', { class: 'muted small' }, 'Якщо просто не хочеш бачити монету — нічого не роби: схованою вона нічому не заважає.') : null,
      h('div', { class: 'btn-grid' },
        h('button', {
          type: 'button', class: 'btn danger', onClick: async () => {
            closeSheet();
            await save({ coins: { del: [c.id] }, ops: { del: ops.map((o) => o.id) } }, { redraw: false });
            for (const o of ops) await unlinkJournal(o.sl).catch(() => null);
            toast(`«${c.name}» видалено`);
            render();
          },
        }, icon('close'), 'Видалити'),
        h('button', { type: 'button', class: 'btn', onClick: () => closeSheet() }, 'Скасувати'))));
  };
  return h('section', { class: 'card set-card' },
    h('p', { class: 'muted small' }, 'Їх немає на головній, але операції лишаються й рахуються. Сховав помилково — «Повернути».'),
    list.map((c) => h('div', { class: 'hidden-row' },
      miniCoin(c),
      h('span', { class: 'hidden-name' }, h('b', {}, c.name),
        h('span', { class: 'muted small' }, `${M.KINDS[c.kind]} · операцій: ${opsOf(c).length}${['account', 'goal', 'debt'].includes(c.kind) ? ` · ${coinMoney(balance(c), c.currency)}` : ''}`)),
      h('button', { type: 'button', class: 'btn', onClick: () => restore(c) }, 'Повернути'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Видалити «${c.name}»`, onClick: () => remove(c) }, icon('close')))));
}

/**
 * Стерти все: монети й операції видаляються звичайним save() — з надгробками, тож синхронізація
 * стирає їх і на Диску, й на інших телефонах (просто очистити базу — Диск повернув би все назад).
 * Замість стертих — стартові монети; курси й день початку місяця лишаються.
 */
function wipeAll() {
  sheet('Стерти всі дані?', h('div', { class: 'form' },
    h('p', {}, `Монет: ${state.coins.length}, операцій: ${state.ops.length} — буде стерто${Sync.syncOn() ? ' й на Google Диску' : ''}. Якщо дані ще знадобляться — спершу «Зберегти копію».`),
    h('div', { class: 'btn-grid' },
      h('button', {
        type: 'button', class: 'btn danger', onClick: async () => {
          closeSheet();
          await save({
            coins: { del: state.coins.map((c) => c.id), put: M.seedCoins(uid) },
            ops: { del: state.ops.map((o) => o.id) },
          });
          await dropFilesExcept(new Set());
          toast('Усе стерто');
          go('main');
        },
      }, icon('close'), 'Стерти'),
      h('button', { type: 'button', class: 'btn', onClick: () => closeSheet() }, 'Скасувати'))));
}

/** «Про застосунок»: автор, що воно таке, де дані, з чого почати — як у hobby-planner і shooting-log. */
function aboutPanel() {
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
  const more = (title, node) => h('details', { class: 'about-more' }, h('summary', {}, title), node);
  return h('section', { class: 'card set-card' },
    h('div', { class: 'about-head' },
      h('img', { class: 'about-avatar', src: './icons/author.jpg', alt: '', width: 64, height: 64, loading: 'lazy' }),
      h('div', {},
        h('p', { class: 'muted small' }, 'Марнотрат — облік витрат монетами: перетягнув гроші з рахунку на витрату — записано. Працює без інтернету.'),
        h('p', { class: 'small about-author' }, 'Автор — ', link('https://github.com/VitaliyLobko', 'Віталій Лобко')))),
    more('Де мої дані', h('div', { class: 'muted small' },
      h('p', {}, 'Монети й операції лежать у браузері на цьому телефоні. Сервера в застосунку немає, автор не отримує ні даних, ні статистики.'),
      h('p', {}, 'Google Диск — за бажанням: дані лягають у файл на твоєму Диску й однакові на всіх твоїх телефонах. Застосунок бачить лише свої файли.'),
      h('p', {}, 'Резервна копія — «Зберегти копію»: файл JSON, ним же переносиш дані вручну.'))),
    more('З чого почати', h('ol', { class: 'about-steps' },
      h('li', {}, 'Встанови застосунок: Android — Chrome → ⋮ → «Встановити застосунок»; iPhone — Safari → «Поділитися» → «На екран „Додому“».'),
      h('li', {}, 'Довге натискання на монету — режим «Редагування»: назва, іконка, бюджет, переставити, прибрати. «+» у ряду — нова монета.'),
      h('li', {}, 'Дохід → рахунок, рахунок → витрата чи ціль, рахунок → рахунок: тягни монету пальцем на іншу й введи суму.'),
      h('li', {}, 'Тап по монеті — її операції. У стрічці свайп вліво — видалити, вправо — змінити.'),
      h('li', {}, 'Заливка монети витрати знизу — скільки бюджету вже витрачено, сіре згори — що лишилось. Зелена — в темпі, помаранчева — витрачаєш швидше, ніж іде місяць, червона — понад бюджет. Зелений обідок без заливки — бюджету немає.'))),
    h('p', { class: 'muted small' },
      link('https://github.com/VitaliyLobko/marnotrat/issues/new', 'Повідомити про помилку'), ' · ',
      link('https://github.com/VitaliyLobko/marnotrat', 'Вихідний код')));
}

function aboutCard() {
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' },
    upd.worker ? 'Нова версія завантажена — оновлення займе секунду, дані залишаться'
      : (upd.checked ? `У тебе остання версія · перевірено о ${upd.checked}` : ''));
  return h('section', { class: 'card set-card' },
    h('h2', {}, `Марнотрат ${self.APP_VERSION ?? '?'}`),
    h('p', { class: 'muted small' }, `Збірка ${self.APP_BUILD ?? '?'}`),
    status,
    h('div', { class: 'btn-grid' },
      upd.worker
        ? h('button', { type: 'button', class: 'btn primary', onClick: () => upd.worker.postMessage('skipWaiting') }, icon('refresh'), 'Оновити')
        : h('button', { type: 'button', class: 'btn', onClick: () => checkUpdate(status) }, icon('refresh'), 'Оновлення'),
      h('button', { type: 'button', class: 'btn', onClick: () => changesSheet(CHANGES.slice(0, 6), 'Що нового') }, icon('star'), 'Що нового')));
}

/** Новий worker після reg.update(): дочекатись, поки встановиться (або відпаде). */
function whenInstalled(worker) {
  return new Promise((resolve) => {
    const check = () => { if (worker.state !== 'installing') { worker.removeEventListener('statechange', check); resolve(worker); } };
    worker.addEventListener('statechange', check);
    check();
  });
}

async function checkUpdate(status) {
  if (!upd.reg) { status.textContent = 'Перевірка недоступна: офлайн-режим не встановлено (локальний запуск чи приватне вікно)'; return; }
  status.textContent = 'Перевіряю…';
  try {
    await upd.reg.update();
  } catch {
    status.textContent = 'Немає зв’язку — спробуй пізніше';
    return;
  }
  const fresh = upd.reg.installing ? await whenInstalled(upd.reg.installing) : upd.reg.waiting;
  // Без controller (перший запуск) новий worker вмикається сам — оновлювати нічого
  if (fresh && navigator.serviceWorker.controller && fresh.state === 'installed') {
    upd.worker = fresh;
    $('update').hidden = false;
    $('update-btn').onclick = () => fresh.postMessage('skipWaiting');
    render();
    return;
  }
  upd.checked = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  status.textContent = `У тебе остання версія · перевірено о ${upd.checked}`;
}

// ---------- «Що нового» ----------

function changesSheet(list, title) {
  sheet(title, h('div', { class: 'stack changes-list' },
    ...list.map((c) => h('div', { class: 'changes' },
      h('h3', {}, `Версія ${c.v}`),
      h('ul', {}, c.items.map((t) => h('li', {}, t))))),
    h('button', { type: 'button', class: 'btn primary', onClick: () => closeSheet() }, icon('check'), 'Зрозуміло')));
}

/** Після оновлення — один раз, що з'явилось з тієї версії, що була. Перший запуск — лише запам'ятати версію. */
function showWhatsNew() {
  const current = self.APP_VERSION;
  if (!current) return;
  const seen = recall('seen-version');
  remember('seen-version', current);
  // 0.1.0 «Що нового» ще не мала: хто вже мав операції — показуємо поточну версію
  if (seen === current || (!seen && !state.ops.length)) return;
  const list = seen ? changesSince(seen, current) : CHANGES.filter((c) => c.v === current);
  if (list.length) changesSheet(list.slice(0, 4), `Що нового в ${current}`);
}

/** «Google Диск»: з ботом — щоденна копія, без бота — синхронізація між телефонами. */
function syncCard() {
  const on = Sync.syncOn();
  const last = Sync.lastSync();
  const when = last ? new Date(last).toLocaleString('uk-UA', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  const connect = async () => {
    try {
      await Sync.connect();
      await runSync({ loud: true });
    } catch (err) { toast(err.message); }
    render();
  };
  const restore = async () => {
    try {
      const data = await Sync.fetchBackup();
      if (!data) { toast('На Диску ще немає копії'); return; }
      importData(data, 'Копія з Google Диска');
    } catch (err) { toast(err.message); }
  };
  const off = () => sheet('Відключити Google Диск?', h('div', { class: 'form' },
    h('p', {}, 'Копія на Диску лишиться, просто перестане оновлюватись. Вхід у Google в інших застосунках не чіпаємо.'),
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn danger', onClick: () => { closeSheet(); Sync.disconnect(); render(); } }, 'Відключити'),
      h('button', { type: 'button', class: 'btn', onClick: closeSheet }, 'Залишити'))));
  return h('section', { class: 'card set-card' },
    h('h2', {}, Bot.botConfig() ? 'Google Диск · щоденна копія' : 'Google Диск · синхронізація'),
    on ? h('p', { class: sync.error ? 'small error-text' : 'muted small' }, sync.error ? `Помилка: ${sync.error}` : last ? `Остання копія: ${when}` : 'Копії ще не було') : null,
    on ? null : h('p', { class: 'muted small' }, 'Копія даних раз на день у файлі на твоєму Google Диску.'),
    on
      ? h('div', { class: 'btn-grid' },
        h('button', { type: 'button', class: 'btn', onClick: () => runSync({ loud: true }) }, icon('refresh'), 'Оновити'),
        h('button', { type: 'button', class: 'btn', onClick: restore }, icon('undo'), 'Відновити'),
        h('button', { type: 'button', class: 'btn', onClick: off }, icon('close'), 'Відключити'))
      : h('div', { class: 'btn-grid' }, h('button', { type: 'button', class: 'btn', onClick: connect }, icon('refresh'), 'Підключити Диск')),
    moreText('Файл marnotrat-sync.json на твоєму Google Диску; там же адреса сервера й ключ доступу для інших пристроїв. Застосунок бачить лише свої файли.'));
}

const backupData = () => ({ app: 'marnotrat', version: self.APP_VERSION, exported: new Date().toISOString(), ...state });

function exportBackup() {
  downloadFile(JSON.stringify(backupData(), null, 1), `marnotrat-${M.ymd()}.json`, 'application/json');
}

/** Віддати текст файлом: посилання з download і клік. */
function downloadFile(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBackup(f) {
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { toast('Файл не читається як JSON'); return; }
  importData(data, 'Відновити з копії?');
}

/** Копія (з файлу чи з Диска): «Додати до наявних» або «Замінити все». */
function importData(data, title) {
  if (data?.app !== 'marnotrat' || !Array.isArray(data.coins) || !Array.isArray(data.ops)) { toast('Це не копія Марнотрата'); return; }
  sheet(title, h('div', { class: 'form' },
    h('p', {}, `Монет: ${data.coins.length}, операцій: ${data.ops.length}.`),
    h('p', { class: 'muted' }, '«Додати» — монети з тією ж назвою беруться наявні, яких нема — створюються, операції додаються до твоїх. «Замінити все» — поточні дані на цьому телефоні буде стерто.'),
    h('div', { class: 'btn-grid' },
      h('button', {
        type: 'button', class: 'btn', onClick: async () => {
          closeSheet();
          const n = await mergeBackup(data);
          toast(`Додано операцій: ${n.ops}, нових монет: ${n.coins}`);
        },
      }, icon('check'), 'Додати до наявних'),
      h('button', {
        type: 'button', class: 'btn danger', onClick: async () => {
          closeSheet();
          await replaceAll(data);
          Object.assign(state, await loadAll());
          cloudCur.reset();
          scheduleCloud(0);
          toast('Відновлено');
          render();
        },
      }, 'Замінити все'),
      h('button', { type: 'button', class: 'btn', onClick: () => closeSheet() }, 'Скасувати'))));
}

/**
 * Злиття копії з наявним (зокрема перенесення історії з іншого застосунку): монета того ж виду з тією ж
 * назвою — наявна, решта створюються; стартовий залишок рахунку додається до наявного. Операції з уже
 * наявним id пропускаються — повторний імпорт не дублює. Іде звичайним save(), тож синхронізація підхоплює.
 */
async function mergeBackup(data) {
  const key = (c) => `${c.kind}|${c.name.trim().toLocaleLowerCase('uk')}`;
  const byKey = new Map(state.coins.map((c) => [key(c), c]));
  const byId = new Set(state.coins.map((c) => c.id));
  const known = new Set(state.ops.map((o) => o.id));
  const fresh = data.ops.filter((o) => !known.has(o.id));
  // Стартовий залишок — лише разом з операціями монети: повторний імпорт не додає його вдруге
  const touched = new Set(fresh.flatMap((o) => [o.from, o.to]));
  const ids = new Map();
  const coins = [];
  let created = 0;
  let order = Math.max(0, ...state.coins.map((c) => c.order ?? 0)) + 1;
  for (const c of data.coins) {
    const have = byId.has(c.id) ? null : byKey.get(key(c));
    if (byId.has(c.id)) ids.set(c.id, c.id);
    else if (have) {
      ids.set(c.id, have.id);
      const start = c.start && touched.has(c.id) ? M.round2((have.start || 0) + c.start) : have.start;
      // Бюджет з копії — лише якщо свого ще не задано
      const budget = have.budget || c.budget || 0;
      if (start !== have.start || budget !== have.budget) coins.push({ ...have, start, budget });
    } else {
      ids.set(c.id, c.id);
      coins.push({ ...c, order: order++ });
      created += 1;
    }
  }
  const ops = fresh.map((o) => ({ ...o, from: ids.get(o.from) ?? o.from, to: ids.get(o.to) ?? o.to }));
  await save({ coins: { put: coins }, ops: { put: ops } });
  return { ops: ops.length, coins: created };
}

// ---------- меню й маршрути ----------

const MENU = [
  ['Огляд', [['feed', 'feed', 'Стрічка'], ['days', 'daily', 'Звіт по днях'], ['report', 'pie', 'Загальний'], ['history', 'chart', 'Історія']]],
  ['Планування', [['subs', 'refresh', 'Регулярні платежі'], ['warranty', 'shield', 'Гарантії'], ['reconcile', 'scale', 'Звірка залишків']]],
];

/** Порожній екран: іконка в колі, заголовок і підказка, що робити. */
const emptyState = (ico, title, text) => h('div', { class: 'empty-state' },
  h('span', { class: 'empty-ico' }, icon(ico)), h('b', {}, title), h('p', {}, text));

// ---------- таблиця CSV ----------

const TYPE_NAMES = { expense: 'Витрата', income: 'Дохід', transfer: 'Переказ' };
const TYPE_BY_NAME = {
  'витрата': 'expense', 'дохід': 'income', 'переказ': 'transfer', expense: 'expense', income: 'income', transfer: 'transfer',
};
// Яких типів монети стоять «звідки» і «куди» в операції кожного типу; перший — для нової монети
const CSV_ENDS = {
  expense: [['account', 'debt'], ['expense', 'goal']],
  income: [['income'], ['account']],
  transfer: [['account', 'debt', 'goal'], ['account', 'debt', 'goal']],
};

/** Те, що зараз у стрічці (монета, тип, пошук; усі дні, без запланованих), — файлом CSV для Excel чи Таблиць. */
function exportCsv() {
  const ops = feedOps(false);
  if (!ops.length) { toast('У стрічці нема операцій'); return; }
  const rows = [['Дата', 'Тип', 'Звідки', 'Куди', 'Сума', 'Валюта', 'Сума в отримувача', 'Валюта отримувача', 'Теги', 'Коментар'],
    ...ops.map((op) => {
      const src = coinOr(op.from);
      const dst = coinOr(op.to);
      const two = op.amountTo != null;
      return [op.date, TYPE_NAMES[opType(op)], src.name, dst.name, Csv.csvAmount(op.amount), src.currency,
        two ? Csv.csvAmount(op.amountTo) : '', two ? dst.currency : '', (op.tags ?? []).join(', '), op.comment ?? ''];
    })];
  downloadFile(Csv.toCsv(rows), `marnotrat-${feedCoin ? coinOr(feedCoin).name : 'стрічка'}-${M.ymd()}.csv`, 'text/csv');
  toast(`Збережено операцій: ${ops.length}`);
}

const lowName = (s) => s.trim().toLocaleLowerCase('uk');
// Однакова операція: та сама дата, монети, сума й коментар — повторний імпорт її не задвоює
const opSig = (o) => `${o.date}|${o.from}|${o.to}|${M.round2(o.amount)}|${(o.comment ?? '').trim()}`;

/**
 * Рядки таблиці → що додасться: нові операції, нові монети, скільки дублів і які рядки не прочитано.
 * Монету шукаємо за назвою серед відповідних типів; нема — нова (у грн, якщо валюту не вказано).
 */
function planCsv(rows, at) {
  const cell = (r, k) => (k in at ? String(r[at[k]] ?? '').trim() : '');
  const found = new Map();
  for (const c of state.coins) {
    const k = `${c.kind}|${lowName(c.name)}`;
    if (!found.has(k) || found.get(k).archived) found.set(k, c);
  }
  const fresh = [];
  let order = Math.max(0, ...state.coins.map((c) => c.order ?? 0)) + 1;
  const pick = (name, kinds, cur) => {
    for (const k of kinds) {
      const c = found.get(`${k}|${lowName(name)}`);
      if (c) return c;
    }
    const c = { id: uid(), kind: kinds[0], name: name.slice(0, 30), icon: NEW_ICON[kinds[0]], currency: cur || 'UAH', budget: 0, start: 0, order: order++, archived: false };
    found.set(`${c.kind}|${lowName(name)}`, c);
    fresh.push(c);
    return c;
  };
  const seen = new Set(state.ops.map(opSig));
  const ops = [];
  const bad = [];
  let dup = 0;
  rows.forEach((r, i) => {
    const date = Csv.parseDate(cell(r, 'date'));
    const amount = Csv.parseAmount(cell(r, 'amount'));
    const fromName = cell(r, 'from');
    const toName = cell(r, 'to');
    // Номер рядка у файлі: заголовок — перший
    if (!date || !amount || !fromName || !toName) { bad.push(i + 2); return; }
    const has = (kind, name) => found.has(`${kind}|${lowName(name)}`);
    const t = TYPE_BY_NAME[lowName(cell(r, 'type'))]
      ?? (has('income', fromName) ? 'income' : has('account', toName) || has('debt', toName) || has('goal', toName) ? 'transfer' : 'expense');
    const cur = Csv.parseCurrency(cell(r, 'currency'));
    const amountTo = Csv.parseAmount(cell(r, 'amountTo'));
    const src = pick(fromName, CSV_ENDS[t][0], cur);
    const dst = pick(toName, CSV_ENDS[t][1], Csv.parseCurrency(cell(r, 'currencyTo')) ?? (amountTo ? null : cur));
    const op = {
      id: uid(), from: src.id, to: dst.id, amount, date, created: Date.now() + i,
      tags: normTags(cell(r, 'tags').split(/[,;]|\s+(?=#)/)),
      comment: cell(r, 'comment').slice(0, 200),
    };
    if (src.currency !== dst.currency) op.amountTo = amountTo ?? M.round2(amount * rate(src.currency) / rate(dst.currency));
    const sig = opSig(op);
    if (seen.has(sig)) { dup += 1; return; }
    seen.add(sig);
    ops.push(op);
  });
  // Монета, потрібна лише дублям, не створюється
  const used = new Set(ops.flatMap((o) => [o.from, o.to]));
  return { ops, dup, bad, coins: fresh.filter((c) => used.has(c.id)) };
}

async function importCsv(f) {
  if (!f) return;
  const rows = Csv.parseCsv(await f.text());
  const at = rows.length ? Csv.mapHeader(rows[0]) : {};
  if (!['date', 'from', 'to', 'amount'].every((k) => k in at)) {
    toast('Не бачу колонок «Дата», «Звідки», «Куди», «Сума» в першому рядку');
    return;
  }
  const plan = planCsv(rows.slice(1), at);
  const kindName = (c) => M.KINDS[c.kind].toLowerCase();
  const badList = plan.bad.length > 8 ? `${plan.bad.slice(0, 8).join(', ')} і ще ${plan.bad.length - 8}` : plan.bad.join(', ');
  sheet('Імпорт з таблиці', h('div', { class: 'form' },
    h('p', {}, `Рядків: ${rows.length - 1}. Додам операцій: ${plan.ops.length}.`),
    plan.dup ? h('p', { class: 'muted small' }, `Уже є — пропущу: ${plan.dup}.`) : null,
    plan.bad.length ? h('p', { class: 'error-text small' }, `Не прочитав ${plan.bad.length === 1 ? 'рядок' : 'рядки'} ${badList}: нема дати, суми чи назви монети.`) : null,
    plan.coins.length ? h('p', { class: 'muted small' }, `Нові монети: ${plan.coins.map((c) => `${c.name} (${kindName(c)})`).join(', ')}.`) : null,
    h('div', { class: 'btn-grid' },
      h('button', {
        type: 'button', class: 'btn primary', disabled: !plan.ops.length, onClick: async () => {
          closeSheet();
          await save({ coins: { put: plan.coins }, ops: { put: plan.ops } });
          toast(`Додано операцій: ${plan.ops.length}${plan.coins.length ? `, нових монет: ${plan.coins.length}` : ''}`, {
            label: 'Скасувати',
            run: () => save({ ops: { del: plan.ops.map((o) => o.id) }, coins: { del: plan.coins.map((c) => c.id) } }),
          });
        },
      }, icon('check'), 'Імпортувати'),
      h('button', { type: 'button', class: 'btn', onClick: () => closeSheet() }, 'Скасувати'))));
}

// ---------- регулярні платежі ----------

// Скільки разів на місяць у середньому: тиждень — 52/12, день — 365/12
const PER_MONTH = { day: 365 / 12, week: 52 / 12, month: 1, year: 1 / 12 };

/** Наступна дата повтору після сьогодні (або null, якщо правило скінчилось). */
function nextRepeat(rule) {
  const today = M.ymd();
  const last = M.repeatDates(rule.date, rule.repeat.every, rule.repeat.until, today).at(-1);
  return last && last > today ? last : null;
}

const activeRule = (op) => Boolean(op.repeat?.every) && (!op.repeat.until || op.repeat.until >= M.ymd());

function viewSubs() {
  const rules = state.ops.filter((op) => op.repeat?.every).sort((a, b) => b.amount - a.amount);
  if (!rules.length) {
    return h('div', { class: 'page' }, emptyState('refresh', 'Регулярних платежів ще немає',
      'Комуналка, підписки, оренда: відкрий операцію й натисни ⟳ на клавіатурі суми — щомісяця, щотижня чи щороку.'));
  }
  const today = M.ymd();
  const active = rules.filter(activeRule);
  const stopped = rules.filter((op) => !activeRule(op));
  // Місячний еквівалент у гривнях: витрати й доходи окремо, перекази не рахуються
  const monthly = (op) => toUah(op.amount, coinOr(op.from).currency) * PER_MONTH[op.repeat.every];
  const sumOf = (t) => active.filter((op) => opType(op) === t).reduce((s, op) => s + monthly(op), 0);
  const outM = sumOf('expense');
  const inM = sumOf('income');
  const stop = async (op) => {
    await save({ ops: { put: [{ ...op, repeat: { ...op.repeat, until: M.addDays(today, -1) } }] } });
    toast(`Зупинено: ${coinOr(op.to).name}`, { label: 'Скасувати', run: () => save({ ops: { put: [{ ...op }] } }) });
  };
  const resume = (op) => save({ ops: { put: [{ ...op, repeat: { ...op.repeat, until: '' } }] } });
  const soon = (date) => {
    const n = daysLeft(date);
    return n === 0 ? 'сьогодні' : n === 1 ? 'завтра' : `через ${n} дн.`;
  };
  const row = (op, on) => {
    const t = opType(op);
    const src = coinOr(op.from);
    const dst = coinOr(op.to);
    const next = on ? nextRepeat(op) : null;
    const name = [t === 'income' ? src.name : dst.name, op.comment].filter(Boolean).join(' · ');
    const perMonth = op.repeat.every !== 'month' && t !== 'transfer' ? `≈ ${M.money(Math.round(monthly(op)))}/міс` : '';
    return h('div', { class: `sub-row${on ? '' : ' off'}` },
      h('button', { type: 'button', class: 'sub-main', onClick: () => openAmount({ from: op.from, to: op.to, op }) },
        miniCoin(t === 'income' ? src : dst),
        h('span', { class: 'sub-text' },
          h('b', {}, name),
          h('span', {}, [M.repeatLabel(op.repeat.every), perMonth, on ? '' : `зупинено ${dmy(op.repeat.until)}`].filter(Boolean).join(' · '))),
        h('span', { class: 'sub-right' },
          h('span', { class: `sub-sum ${t}` }, M.money(op.amount, src.currency)),
          next ? h('span', { class: `pill${daysLeft(next) <= 3 ? ' warn' : ''}` }, soon(next)) : null)),
      h('button', {
        type: 'button', class: 'icon-btn sub-act', 'aria-label': on ? `Зупинити: ${name}` : `Відновити: ${name}`, title: on ? 'Зупинити' : 'Відновити',
        onClick: () => (on ? stop(op) : resume(op)),
      }, icon(on ? 'pause' : 'play')));
  };
  return h('div', { class: 'page stack' },
    h('div', { class: 'card hero' },
      h('span', { class: 'hero-cap' }, 'Регулярні витрати на місяць'),
      h('b', { class: 'hero-num' }, `≈ ${M.money(Math.round(outM))}`),
      h('span', { class: 'hero-sub' }, `за рік ≈ ${M.money(Math.round(outM * 12))} · ${active.length} ${active.length === 1 ? 'платіж' : active.length < 5 ? 'платежі' : 'платежів'}`),
      inM ? h('span', { class: 'hero-sub plus' }, `регулярні доходи ≈ ${M.money(Math.round(inM))} на місяць`) : null),
    active.length ? h('div', { class: 'card' }, active.map((op) => row(op, true))) : h('p', { class: 'empty' }, 'Усі регулярні платежі зупинено'),
    stopped.length ? h('details', { class: 'card fold-card' }, h('summary', {}, `Зупинені (${stopped.length})`), stopped.map((op) => row(op, false))) : null);
}

// ---------- історія: як міняється з місяця в місяць ----------

// Що показувати: exp / inc / net — підсумки, c:<id> — монета, t:<тег> — тег витрат
let histKey = 'exp';
let histPick = null;
const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
const HIST_N = 12;

/** Ряд для графіка: назва, тип (exp — витратний, можна прогнозувати; inc; net — плюс і мінус) і значення за період. */
function histSeries(key) {
  if (key === 'inc') return { name: 'Усі доходи', kind: 'inc', value: (ym) => totals(ym).income };
  if (key === 'net') return { name: 'Чистий дохід', kind: 'net', value: (ym) => { const t = totals(ym); return t.income - t.expense; } };
  if (key.startsWith('c:')) {
    const c = coin(key.slice(2));
    if (c?.kind === 'income') return { name: c.name, kind: 'inc', value: (ym) => toUah(monthIncome(c, ym), c.currency) };
    if (c) return { name: c.name, kind: 'exp', value: (ym) => toUah(monthSpent(c, ym), c.currency) };
  }
  if (key.startsWith('t:')) {
    const tag = key.slice(2);
    return {
      name: `#${tag}`, kind: 'exp',
      value: (ym) => state.ops.reduce((s, op) => (opType(op) === 'expense' && op.tags?.includes(tag) && inMonth(op, ym)
        ? s + toUah(amountIn(op), coinOr(op.to).currency) : s), 0),
    };
  }
  return { name: 'Усі витрати', kind: 'exp', value: (ym) => totals(ym).expense };
}

/** Вибір ряду: підсумки, витрати, доходи, теги — списком, бо монет і тегів багато. */
function histSelect() {
  const opt = (v, label) => h('option', { value: v, selected: v === histKey }, label);
  const group = (label, items) => (items.length ? h('optgroup', { label }, items) : null);
  return h('select', {
    class: 'field', 'aria-label': 'Що показати',
    onChange: (e) => { histKey = e.target.value; histPick = null; render(); },
  },
  group('Підсумки', [opt('exp', 'Усі витрати'), opt('inc', 'Усі доходи'), opt('net', 'Чистий дохід (доходи − витрати)')]),
  group('Витрати', coinsOf('expense').map((c) => opt(`c:${c.id}`, c.name))),
  group('Доходи', coinsOf('income').map((c) => opt(`c:${c.id}`, c.name))),
  group('Теги', allTags().map((t) => opt(`t:${t}`, `#${t}`))));
}

/** Стовпчик із заокругленим кінцем далі від нуля: y0 — нуль, y1 — значення. */
function barPath(x, w, y0, y1) {
  const r = Math.min(4, Math.abs(y1 - y0), w / 2);
  if (y1 === y0) return '';
  const up = y1 < y0;
  const e = up ? y1 + r : y1 - r;
  return `M${x} ${y0}V${e}Q${x} ${y1} ${x + r} ${y1}H${x + w - r}Q${x + w} ${y1} ${x + w} ${e}V${y0}Z`;
}

function viewHistory() {
  const s = histSeries(histKey);
  const cur = currentPeriod();
  // Місяці до першої операції — не нулі, а «ще не було»: графік починається з першого, щонайменше 3 колонки
  const firstOp = state.ops.reduce((m, op) => (op.date < m ? op.date : m), '9999');
  const since = firstOp === '9999' ? cur : periodOf(firstOp);
  let n = 1;
  while (n < HIST_N && M.addMonths(cur, -n) >= since) n += 1;
  n = Math.max(3, n);
  const keys = Array.from({ length: n }, (_, i) => M.addMonths(cur, i - n + 1));
  const vals = keys.map((k) => s.value(k));
  // Прогноз на поточний період — лише для витрат: темп «скільки вже» ÷ «яка частка минула»
  const el = periodElapsed(cur);
  const fc = s.kind === 'exp' && el > 0 && el < 1 && vals.at(-1) > 0 ? vals.at(-1) / el : null;
  // Середнє — по повних періодах, відколи є операції
  const full = keys.slice(0, -1).map((k, i) => [k, vals[i]]).filter(([k]) => k >= since);
  const avg = full.length ? full.reduce((a, [, v]) => a + v, 0) / full.length : null;
  const pick = histPick && keys.includes(histPick) ? histPick : cur;

  // Геометрія: viewBox, ширина тягнеться на всю картку
  const W = 360;
  const H = 190;
  const top = 20;
  const bottom = 22;
  const hi = Math.max(0, ...vals, fc ?? 0, avg ?? 0);
  const lo = Math.min(0, ...vals);
  const span = hi - lo || 1;
  const y = (v) => top + ((hi - v) / span) * (H - top - bottom);
  const slot = W / n;
  const bw = Math.min(22, slot - 6);
  const y0 = y(0);
  const fill = (v) => (s.kind === 'net' ? (v >= 0 ? 'var(--plus)' : 'var(--minus)') : 'var(--s1)');
  const svgNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs, ...kids) => {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    n.append(...kids.flat().filter(Boolean));
    return n;
  };
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hist-svg', role: 'img', 'aria-label': `${s.name} за ${n} міс.` },
    sv('line', { x1: 0, x2: W, y1: y0, y2: y0, class: 'hist-zero' }),
    keys.map((k, i) => {
      const x = i * slot + (slot - bw) / 2;
      const v = vals[i];
      const now = k === cur;
      const label = `${periodTitle(k)}: ${M.money(Math.round(v))}`;
      return sv('g', { class: `hist-col${k === pick ? ' on' : ''}${now ? ' now' : ''}` },
        now && fc ? sv('path', { d: barPath(x, bw, y0, y(fc)), class: 'hist-fc' }) : null,
        sv('path', { d: barPath(x, bw, y0, y(v)), fill: fill(v), class: 'hist-bar' }),
        sv('text', { x: x + bw / 2, y: H - 6, class: 'hist-x' }, MONTHS_SHORT[Number(k.slice(5, 7)) - 1]),
        // Зона натискання — уся колонка, не лише стовпчик
        sv('rect', { x: i * slot, y: 0, width: slot, height: H, class: 'hist-hit', tabindex: '0', 'aria-label': label },
          sv('title', {}, label)));
    }),
    avg != null && avg !== 0 ? [
      sv('line', { x1: 0, x2: W, y1: y(avg), y2: y(avg), class: 'hist-avg' }),
      sv('text', { x: 2, y: y(avg) - 4, class: 'hist-avg-t' }, 'середнє'),
    ] : null);
  const choose = (e) => {
    const g = e.target.closest?.('.hist-col');
    if (!g) return;
    histPick = keys[[...svg.querySelectorAll('.hist-col')].indexOf(g)];
    render();
  };
  svg.addEventListener('click', choose);
  svg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(e); } });

  const pv = vals[keys.indexOf(pick)];
  const fmt = (v) => (s.kind === 'net' ? signedUah(Math.round(v)) : M.money(Math.round(v)));
  const readout = h('div', { class: 'hist-read' },
    h('span', {}, `${periodTitle(pick)}${pick === cur ? ' · поки що' : ''}`),
    h('b', { class: s.kind === 'net' ? (pv > 0 ? 'plus' : pv < 0 ? 'minus' : '') : '' }, fmt(pv)),
    pick === cur && fc ? h('span', {}, `прогноз на кінець місяця ≈ ${M.money(Math.round(fc))}`) : null);
  const tile = (label, v, sub = null) => h('div', {}, h('span', {}, label), h('b', {}, v), sub ? h('span', {}, sub) : null);
  const sum12 = vals.reduce((a, v) => a + v, 0);
  const stats = h('div', { class: 'card sub-total' },
    tile('Середнє за місяць', avg == null ? '—' : fmt(avg), full.length ? `за ${full.length} повн. міс.` : 'ще немає повного місяця'),
    tile(`Разом за ${n} міс.`, fmt(sum12)));
  const table = h('details', { class: 'card fold-card' }, h('summary', {}, 'Таблицею'),
    h('table', { class: 'hist-table' }, h('tbody', {}, [...keys].reverse().map((k) => h('tr', {},
      h('td', {}, periodTitle(k)), h('td', {}, fmt(vals[keys.indexOf(k)])))))));
  return h('div', { class: 'page stack' },
    histSelect(),
    h('div', { class: 'card hist-card' }, readout, svg,
      h('p', { class: 'hist-key muted small' },
        fc ? h('span', { class: 'hist-key-fc' }, 'пунктир — прогноз') : null)),
    stats, table);
}

// ---------- гарантії й фото чеків ----------

const WARRANTY_SOON = 30;
const daysLeft = (date) => Math.round((M.parseYmd(date) - M.parseYmd(M.ymd())) / 864e5);
/** Операції з гарантією: найближчий кінець першим. */
const warrantyOps = () => state.ops.filter((op) => op.warranty).sort((a, b) => a.warranty.localeCompare(b.warranty));
const opName = (op) => op.comment || coinOr(op.to).name;

/** Фото з телефона: зменшене до 1600 px по довшій стороні, JPEG — щоб база не розросталась. */
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

/** Кнопка «+ фото»: камера чи галерея — вибирає телефон. */
function photoAdd(onBlob) {
  const input = h('input', {
    type: 'file', accept: 'image/*', hidden: true,
    onChange: async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      try { await onBlob(await shrinkPhoto(file)); } catch { toast('Не вдалося прочитати фото'); }
    },
  });
  return h('label', { class: 'photo-add', 'aria-label': 'Додати фото' }, icon('camera'), input);
}

/** Мініатюра фото: тап — на весь екран, ✕ — прибрати з операції. Фото з іншого телефона тут немає. */
function photoThumb(id, onRemove = null) {
  const box = h('span', { class: 'photo-thumb' });
  getFile(id).then((f) => {
    if (!f) { box.classList.add('missing'); box.append(h('span', {}, 'на іншому телефоні')); return; }
    const url = URL.createObjectURL(f.blob);
    box.prepend(h('button', { type: 'button', class: 'photo-open', 'aria-label': 'Відкрити фото', onClick: () => showPhoto(url) },
      h('img', { src: url, alt: '' })));
  });
  if (onRemove) box.append(h('button', { type: 'button', class: 'photo-x', 'aria-label': 'Прибрати фото', onClick: onRemove }, icon('close')));
  return box;
}

/** Перегляд фото поверх усього: не шторка, щоб не закрити екран суми під ним. */
function showPhoto(url) {
  const box = h('div', { class: 'photo-view', role: 'dialog', 'aria-label': 'Фото', onClick: () => box.remove() },
    h('img', { src: url, alt: 'Фото чека' }));
  document.body.append(box);
}

function viewWarranty() {
  const list = warrantyOps();
  if (!list.length) {
    return h('div', { class: 'page' }, emptyState('shield', 'Покупок з гарантією ще немає',
      'На екрані суми натисни 💬 «Деталі»: там дата «Гарантія до» і фото чека — не доведеться шукати папірець.'));
  }
  const row = (op) => {
    const left = daysLeft(op.warranty);
    const src = coinOr(op.from);
    // Скільки гарантійного строку вже минуло — смужкою: зелена, за місяць до кінця помаранчева, скінчилась — сіра
    const total = Math.max(1, Math.round((M.parseYmd(op.warranty) - M.parseYmd(op.date)) / 864e5));
    const used = Math.min(1, Math.max(0, (total - left) / total));
    const st = left < 0 ? 'over' : left <= WARRANTY_SOON ? 'soon' : 'ok';
    const pill = left < 0 ? 'скінчилась' : left === 0 ? 'останній день' : left < 60 ? `ще ${left} дн.` : `ще ${Math.round(left / 30.4)} міс.`;
    return h('div', { class: `war-row ${st}` },
      h('button', { type: 'button', class: 'sub-main', onClick: () => openAmount({ from: op.from, to: op.to, op }) },
        miniCoin(coinOr(op.to)),
        h('span', { class: 'sub-text' },
          h('b', {}, opName(op)),
          h('span', {}, `${dmy(op.date)} → ${dmy(op.warranty)}`)),
        h('span', { class: 'sub-right' },
          h('span', { class: 'sub-sum' }, M.money(op.amount, src.currency)),
          h('span', { class: `pill ${st === 'ok' ? 'ok' : st === 'soon' ? 'warn' : ''}` }, pill))),
      h('div', { class: 'war-bar', role: 'presentation', style: { '--p': `${Math.round(used * 100)}%` } }, h('span')),
      op.photos?.length ? h('div', { class: 'photo-row' }, op.photos.map((id) => photoThumb(id))) : null);
  };
  const active = list.filter((op) => daysLeft(op.warranty) >= 0);
  const over = list.filter((op) => daysLeft(op.warranty) < 0).reverse();
  return h('div', { class: 'page stack' },
    active.length ? h('div', { class: 'card' }, active.map(row)) : h('p', { class: 'empty' }, 'Діючих гарантій немає'),
    over.length ? h('details', { class: 'card fold-card' }, h('summary', {}, `Скінчились (${over.length})`), over.map(row)) : null,
    h('p', { class: 'foot-note' }, icon('camera'), 'Фото чеків зберігаються лише на цьому телефоні — у Google Диск і резервну копію вони не йдуть.'));
}

// ---------- покупки для Стрілецького журналу ----------

// Тег витрати → що записати в журнал: патрони на склад, тюнінг ствола, екіпірування
const SL_TAGS = [
  ['ammo', ['патрони', 'набої']],
  ['mod', ['тюнінг', 'тюнинг']],
  ['gear', ['екіпірування', 'спорядження']],
];
// Категорії екіпірування — ті самі ключі, що в журналі
const GEAR_KINDS = [['armor', 'Бронезахист'], ['carry', 'Розвантаження й підсумки'], ['clothes', 'Одяг і форма'], ['devices', 'Прилади'], ['other', 'Інше']];

/** Що ця витрата для журналу: вид за тегом, або null — не витрата, уже записано чи відмовились. op.ammo — з 0.2.6. */
function slKind(op) {
  if (opType(op) !== 'expense' || op.sl || op.ammo) return null;
  const tags = (op.tags ?? []).map((t) => t.toLowerCase());
  return SL_TAGS.find(([, names]) => names.some((n) => tags.includes(n)))?.[0] ?? null;
}

const slNote = (op) => op.sl?.text ?? (op.ammo?.qty ? `на склад: ${op.ammo.qty} шт` : '');

/** Чипи вибору однієї позиції групами: sel.id — вибране. */
function choiceGroups(groups, sel) {
  const btns = [];
  return groups.map(([cap, items]) => [cap ? h('p', { class: 'flabel' }, cap) : null, h('div', { class: 'chips' }, items.map(([id, label]) => {
    const b = h('button', {
      type: 'button', class: `chip${id === sel.id ? ' on' : ''}`,
      onClick: () => { sel.id = id; for (const x of btns) x.classList.toggle('on', x === b); },
    }, label);
    btns.push(b);
    return b;
  }))]);
}

const nameField = (value, placeholder) => h('input', { type: 'text', maxlength: 80, class: 'field', value, placeholder, 'aria-label': 'Назва' });
const gunLabel = (w) => `${w.name}${w.caliber ? ` · ${w.caliber}` : ''}`;
const byName = (a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'uk');

/** Патрони: який і скільки — рух «купівля» на склад. */
function ammoSpec({ j, rec, uah }) {
  if (!j.cartridges.length) return { empty: 'У журналі ще немає жодного патрона. Додай його там, а потім відкрий цю покупку й збережи ще раз.' };
  const sel = { id: j.cartridges.length === 1 ? j.cartridges[0].id : null };
  const qty = h('input', { type: 'number', inputmode: 'numeric', min: '1', step: '1', class: 'field', placeholder: 'Скільки штук', 'aria-label': 'Кількість, шт' });
  const each = h('p', { class: 'muted small' }, `Сума покупки: ${M.money(uah)}`);
  const showEach = () => {
    const n = Number(qty.value);
    each.textContent = n > 0 ? `${M.money(uah)} — це ${M.money(M.round2(uah / n))} за штуку` : `Сума покупки: ${M.money(uah)}`;
  };
  qty.addEventListener('input', showEach);
  // Чипи — типові пачки, як у журналі
  const quick = h('div', { class: 'chips' }, [20, 50, 100, 200, 500].map((n) => h('button', {
    type: 'button', class: 'chip', onClick: () => { qty.value = String(n); showEach(); },
  }, String(n))));
  // Групами за калібром, найбільший залишок — першим
  const byCal = new Map();
  for (const c of [...j.cartridges].sort((a, b) => b.stock - a.stock)) byCal.set(c.caliber || 'Інші', [...(byCal.get(c.caliber || 'Інші') ?? []), c]);
  return {
    title: 'Патрони на склад', ok: 'На склад',
    intro: 'Покупка з тегом #патрони — записати її на склад Стрілецького журналу?',
    body: [choiceGroups([...byCal].map(([cal, cs]) => [cal, cs.map((c) => [c.id, `${c.name} · ${c.stock} шт`])]), sel),
      h('label', { class: 'flabel' }, 'Скільки штук'), qty, quick, each],
    async store() {
      const c = j.cartridges.find((x) => x.id === sel.id);
      const n = Math.round(Number(qty.value));
      if (!c) { toast('Вибери патрон'); return null; }
      if (!(n > 0)) { toast('Скільки штук?'); qty.focus(); return null; }
      const mv = { id: uid(), kind: 'buy', date: rec.date, cartridgeId: c.id, caliber: c.caliber, qty: n, price: uah, note: rec.comment || 'Марнотрат' };
      await addRecord('movements', mv);
      return { sl: { kind: 'ammo', id: mv.id, text: `на склад: ${n} шт` }, text: `+${n} шт · ${c.name} — на складі`, undo: () => removeRecord('movements', mv.id) };
    },
  };
}

/** Тюнінг: до якого ствола і що — рядок у «Вкладено в ствол». */
function modSpec({ j, rec, uah }) {
  if (!j.weapons.length) return { empty: 'У журналі ще немає жодного ствола. Додай його там, а потім відкрий цю покупку й збережи ще раз.' };
  const guns = [...j.weapons].sort(byName);
  const sel = { id: guns.length === 1 ? guns[0].id : null };
  const name = nameField(rec.comment, 'Спуск, цівка, ДТК, приклад…');
  return {
    title: 'Тюнінг у журнал', ok: 'Записати',
    intro: `Покупка з тегом #тюнінг на ${M.money(uah)} — до якого ствола записати?`,
    body: [choiceGroups([['Ствол', guns.map((w) => [w.id, gunLabel(w)])]], sel), h('label', { class: 'flabel' }, 'Що саме'), name],
    async store() {
      const w = guns.find((x) => x.id === sel.id);
      const title = name.value.trim();
      if (!w) { toast('Вибери ствол'); return null; }
      if (!title) { toast('Напиши, що саме'); name.focus(); return null; }
      const mod = { id: uid(), created: Date.now(), name: title, price: uah, date: rec.date, note: 'Марнотрат' };
      if (!(await patchRecord('weapons', w.id, (old) => ({ ...old, mods: [...(old.mods ?? []), mod] })))) { toast('Ствол уже видалено з журналу'); return null; }
      return {
        sl: { kind: 'mod', id: mod.id, gun: w.id, text: `тюнінг: ${w.name}` }, text: `${title} → ${w.name}`,
        undo: () => patchRecord('weapons', w.id, (old) => ({ ...old, mods: (old.mods ?? []).filter((m) => m.id !== mod.id) })),
      };
    },
  };
}

/** Екіпірування: категорія й назва — новий запис у журналі. */
function gearSpec({ rec, uah }) {
  const sel = { id: null };
  const name = nameField(rec.comment, 'Плитоноска, шолом, підсумок…');
  return {
    title: 'Екіпірування в журнал', ok: 'Записати',
    intro: `Покупка з тегом #екіпірування на ${M.money(uah)} — записати її в Стрілецький журнал?`,
    body: [choiceGroups([['Категорія', GEAR_KINDS]], sel), h('label', { class: 'flabel' }, 'Що саме'), name],
    async store() {
      const title = name.value.trim();
      if (!sel.id) { toast('Вибери категорію'); return null; }
      if (!title) { toast('Напиши, що саме'); name.focus(); return null; }
      const g = { id: uid(), name: title, kind: sel.id, price: uah, date: rec.date, note: 'Марнотрат' };
      await addRecord('gear', g);
      return { sl: { kind: 'gear', id: g.id, text: `екіпірування: ${title}` }, text: `${title} — в екіпіруванні`, undo: () => removeRecord('gear', g.id) };
    },
  };
}

const SL_SPECS = { ammo: ammoSpec, mod: modSpec, gear: gearSpec };
const SL_TITLES = { ammo: 'Патрони на склад', mod: 'Тюнінг у журнал', gear: 'Екіпірування в журнал' };

/** Після покупки з тегом: шторка запису в журнал. «Не треба» запам'ятовується, «Скасувати» прибирає запис і з журналу. */
async function offerJournal(rec, kind) {
  if (!(await slAvailable())) return;
  let j;
  try { j = await readJournal(); } catch { return; }
  // Екран суми ще закривається через history.back — нова шторка має відкритись після нього, інакше він її й закриє
  if (history.state?.sheet) await new Promise((r) => { addEventListener('popstate', r, { once: true }); setTimeout(r, 600); });
  const latest = () => state.ops.find((o) => o.id === rec.id);
  const mark = async (sl) => {
    const cur = latest();
    if (cur) await save({ ops: { put: [{ ...cur, sl }] } });
  };
  const unmark = async () => {
    const o = latest();
    if (o) { const { sl, ammo, ...rest } = o; await save({ ops: { put: [rest] } }); }
  };
  const uah = M.round2(toUah(rec.amount, coinOr(rec.from).currency));
  const spec = SL_SPECS[kind]({ j, rec, uah });
  if (spec.empty) {
    const close = sheet(SL_TITLES[kind], h('div', { class: 'form' },
      h('p', {}, spec.empty),
      h('div', { class: 'btn-grid' },
        h('a', { class: 'btn', href: '../shooting-log/' }, 'Відкрити журнал'),
        h('button', { type: 'button', class: 'btn primary', onClick: () => close() }, 'Зрозуміло'))));
    return;
  }
  const store = async () => {
    let res;
    try { res = await spec.store(); } catch (err) { toast(`Не вдалося записати: ${err.message}`); return; }
    if (!res) return;
    close();
    await mark(res.sl);
    toast(res.text, { label: 'Скасувати', run: async () => { await res.undo(); await unmark(); } });
  };
  const close = sheet(spec.title, h('div', { class: 'form' },
    h('p', { class: 'muted small' }, spec.intro),
    spec.body,
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn', onClick: async () => { close(); await mark({ skip: true }); } }, 'Не треба'),
      h('button', { type: 'button', class: 'btn primary', onClick: store }, icon('check'), spec.ok))));
}

// ---------- звірка залишків ----------

/** Монета «Не пам'ятаю» потрібного типу: знайти чи створити (витрата — недостача, дохід — надлишок). */
function lostCoin(kind, extra) {
  const found = state.coins.find((c) => c.kind === kind && c.lost && !c.archived);
  if (found) return { coin: found, created: null };
  const coin = {
    id: uid(), kind, name: 'Не пам’ятаю', icon: 'circle-help', currency: 'UAH', budget: 0, start: 0,
    order: Date.now(), archived: false, lost: true,
  };
  extra.push(coin);
  return { coin, created: coin };
}

function viewReconcile() {
  const accs = coinsOf('account');
  if (!accs.length) return h('div', { class: 'page' }, emptyState('scale', 'Рахунків немає', 'Додай рахунок на головній — тоді буде що звіряти.'));
  const fields = accs.map((c) => h('input', {
    type: 'number', inputmode: 'decimal', step: '0.01', class: 'field', value: String(M.round2(balance(c))), 'aria-label': `Насправді: ${c.name}`,
  }));
  const diffs = accs.map(() => h('span', { class: 'rec-diff' }));
  const runText = h('span', {});
  const runBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => run() }, icon('check'), runText);
  const diffOf = (c, i) => {
    const real = Number(fields[i].value);
    return fields[i].value === '' || !Number.isFinite(real) ? 0 : M.round2(real - balance(c));
  };
  // Різниця видна одразу, поки вписуєш: плюс — знайшлось більше, мінус — недостача
  const paintDiffs = () => {
    let n = 0;
    accs.forEach((c, i) => {
      const v = diffOf(c, i);
      const on = Math.abs(v) >= 0.01;
      if (on) n += 1;
      diffs[i].textContent = on ? M.money(v, c.currency, { sign: v > 0 ? '+ ' : '− ' }) : 'збігається';
      diffs[i].className = `rec-diff ${on ? (v > 0 ? 'plus' : 'minus') : ''}`;
    });
    runBtn.disabled = !n;
    runText.textContent = n ? `Записати різницю (${n})` : 'Усе збігається';
  };
  for (const f of fields) {
    f.addEventListener('input', paintDiffs);
    f.addEventListener('focus', () => f.select());
  }
  const run = async () => {
    const today = M.ymd();
    const newCoins = [];
    const ops = [];
    accs.forEach((c, i) => {
      const diff = diffOf(c, i);
      if (Math.abs(diff) < 0.01) return;
      const base = { id: uid(), date: today, tags: [], comment: 'Звірка залишків', created: Date.now() };
      if (diff < 0) {
        // Недостача: витрата з рахунку на «Не пам'ятаю»; рахунок у валюті — друга сума в гривнях
        const { coin } = lostCoin('expense', newCoins);
        const op = { ...base, from: c.id, to: coin.id, amount: -diff };
        if (c.currency !== coin.currency) op.amountTo = M.round2(toUah(-diff, c.currency));
        ops.push(op);
      } else {
        // Надлишок: дохід «Не пам'ятаю» на рахунок
        const { coin } = lostCoin('income', newCoins);
        const op = { ...base, from: coin.id, to: c.id, amount: c.currency === coin.currency ? diff : M.round2(toUah(diff, c.currency)) };
        if (c.currency !== coin.currency) op.amountTo = diff;
        ops.push(op);
      }
    });
    if (!ops.length) { toast('Усе збігається — нічого записувати'); return; }
    await save({ coins: { put: newCoins }, ops: { put: ops } });
    toast(`Записано різниць: ${ops.length}`, {
      label: 'Скасувати', run: () => save({ ops: { del: ops.map((o) => o.id) }, coins: { del: newCoins.map((c) => c.id) } }),
    });
  };
  paintDiffs();
  return h('div', { class: 'page stack' },
    h('div', { class: 'card hero' },
      h('span', { class: 'hero-cap' }, 'Давно не вносив витрати?'),
      h('span', { class: 'hero-sub' }, 'Впиши, скільки зараз насправді на кожному рахунку. Різниця запишеться однією операцією: недостача — витратою «Не пам’ятаю», надлишок — доходом.')),
    h('div', { class: 'card' }, accs.map((c, i) => h('label', { class: 'rec-row' },
      h('span', { class: 'rec-name' }, miniCoin(c), h('span', {}, h('b', {}, c.name), h('span', { class: 'muted small' }, `в обліку ${coinMoney(balance(c), c.currency)}`))),
      h('span', { class: 'rec-in' }, fields[i], diffs[i])))),
    runBtn);
}

function openMenu() {
  // Пункт меню займає запис шторки в історії: «Назад» з екрана веде на головну, а не в закрите меню.
  // Звичайне закриття (history.back) скасувало б перехід, що йде слідом
  const pick = (key) => {
    close(true);
    history.replaceState(null, '', `#${key}`);
    route();
  };
  const here = location.hash.slice(1).split('/')[0];
  // Лічильник біля пункту: що чекає уваги (помаранчевий) чи просто скільки є
  const badge = (key) => {
    if (key === 'feed') { const n = dueCount(); return n ? [n, 'warn'] : null; }
    if (key === 'subs') { const n = state.ops.filter(activeRule).length; return n ? [n, ''] : null; }
    if (key === 'warranty') {
      const n = warrantyOps().filter((op) => daysLeft(op.warranty) >= 0 && daysLeft(op.warranty) <= WARRANTY_SOON).length;
      return n ? [n, 'warn'] : null;
    }
    return null;
  };
  const item = ([key, ico, label]) => {
    const b = badge(key);
    return h('button', { type: 'button', class: `menu-item${here === key ? ' on' : ''}`, onClick: () => pick(key) },
      icon(ico), h('span', { class: 'menu-label' }, label), b ? h('span', { class: `menu-badge ${b[1]}` }, String(b[0])) : null);
  };
  // Нагадування — як пункти меню: тап веде туди, де з ним розібратись
  const remind = alerts().map((a) => h('button', { type: 'button', class: `plan-hint ${a.cls}`, onClick: () => pick(a.to) },
    icon(a.ico), h('span', { class: 'menu-label' }, a.text), icon('next')));
  const close = sheet('Меню', h('nav', { class: 'menu' },
    h('div', { class: 'menu-head' },
      h('img', { class: 'menu-logo', src: './icons/icon-192.png', alt: '', width: 44, height: 44 }),
      h('span', {}, h('b', {}, 'Марнотрат'), h('span', {}, `на рахунках ${M.money(Math.round(totalBalance()))}`))),
    remind.length ? h('div', { class: 'menu-group remind' }, h('p', { class: 'menu-cap' }, 'Нагадування'), remind) : null,
    MENU.map(([title, items]) => h('div', { class: 'menu-group' }, h('p', { class: 'menu-cap' }, title), items.map(item))),
    h('div', { class: 'menu-foot' }, item(['settings', 'gear', 'Налаштування']), h('p', { class: 'menu-ver' }, `версія ${self.APP_VERSION}`))),
  { cls: 'drawer', bare: true });
}

function openFeed(id) {
  go(`feed/${id}`);
}

function go(hash) {
  if (hash === 'edit') {
    history.pushState({ edit: true }, '', '#edit');
    route();
    return;
  }
  location.hash = `#${hash}`;
}

const VIEWS = {
  main: { render: viewMain },
  edit: { render: viewMain },
  feed: { title: () => (feedCoin ? coinOr(feedCoin).name : 'Стрічка'), render: viewFeed },
  report: { title: 'Загальний', render: viewReport },
  days: { title: 'Звіт по днях', render: viewDays },
  settings: { title: 'Налаштування', render: viewSettings },
  subs: { title: 'Регулярні платежі', render: viewSubs },
  history: { title: 'Історія', render: viewHistory },
  warranty: { title: 'Гарантії', render: viewWarranty },
  reconcile: { title: 'Звірка залишків', render: viewReconcile },
};

function menuButton() {
  const n = editing() ? 0 : alerts().length;
  return h('button', { type: 'button', class: 'icon-btn', 'aria-label': n ? `Меню, нагадувань: ${n}` : 'Меню', onClick: openMenu },
    icon('menu'), n ? h('span', { class: 'menu-count' }, String(n)) : null);
}

function topbar() {
  const bar = $('topbar');
  if (view === 'main') {
    const open = recall('income-open') === '1';
    bar.className = 'topbar';
    bar.replaceChildren(...[
      menuButton(),
      headStats(),
      syncChip(),
      h('button', {
        type: 'button', class: `icon-btn${open ? ' chev-up' : ''}`, 'aria-label': open ? 'Сховати доходи' : 'Показати доходи', 'aria-expanded': String(open),
        onClick: () => { remember('income-open', open ? '0' : '1'); render(); },
      }, icon('chevron'))].filter(Boolean));
    return;
  }
  if (view === 'edit') {
    bar.className = 'topbar';
    bar.replaceChildren(
      h('h1', { class: 'edit-title' }, 'Редагування'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Готово', onClick: () => (history.state?.edit ? history.back() : go('main')) }, icon('check')));
    return;
  }
  const { title } = VIEWS[view];
  bar.className = 'topbar brand';
  // replaceChildren — не h(): null вивів би текстом «null», тож порожні кнопки відсіюємо
  bar.replaceChildren(...[
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Назад', onClick: () => (history.length > 1 ? history.back() : go('main')) }, icon('back')),
    h('h1', {}, typeof title === 'function' ? title() : title),
    syncChip(),
    view === 'feed' ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Зберегти в CSV', title: 'Зберегти в CSV', onClick: exportCsv }, icon('download')) : null,
    view === 'report' ? h('button', {
      type: 'button', class: `icon-btn${filterOn() ? ' has-dot' : ''}`, 'aria-label': filterOn() ? 'Фільтри (увімкнено)' : 'Фільтри', onClick: openReportFilter,
    }, icon('filter')) : null,
    view === 'report' ? h('button', {
      type: 'button', class: `icon-btn${reportTags ? ' on' : ''}`, 'aria-pressed': String(reportTags), 'aria-label': 'За тегами',
      onClick: () => { reportTags = !reportTags; reportPick = null; toast(reportTags ? 'Звіт за тегами' : 'Звіт за монетами'); render(); },
    }, icon('tag')) : null].filter(Boolean));
}

// Підпис монети, що не влазить у рядок, — дрібніше рівно настільки, щоб влізти, але не менше 9px
const NAME_MIN_PX = 9;

function fitNames() {
  for (const el of document.querySelectorAll('.coin-name')) {
    el.style.fontSize = '';
    if (el.scrollWidth <= el.clientWidth) continue;
    const px = parseFloat(getComputedStyle(el).fontSize);
    el.style.fontSize = `${Math.max(NAME_MIN_PX, Math.floor(px * (el.clientWidth / el.scrollWidth) * 0.96 * 10) / 10)}px`;
  }
}

function render() {
  shareMoney();
  Widget.scheduleWidget(widgetHead);
  topbar();
  // Ряд рахунків прилипає під шапку — їй висота з вирізом екрана, тож міряємо, а не вгадуємо
  document.documentElement.style.setProperty('--topbar-h', `${$('topbar').offsetHeight}px`);
  $('view').replaceChildren(VIEWS[view].render());
  if (onMain()) { fitNames(); animateSums(); }
}

function route() {
  let [key, arg] = location.hash.slice(1).split('/');
  // Кнопки віджета Android: #add/expense, #add/income — екран суми зі звичними монетами поверх головної
  if (key === 'add') {
    const pair = usualPair(arg === 'income' ? 'income' : 'expense');
    history.replaceState(null, '', '#main');
    [key, arg] = ['main', undefined];
    if (pair) setTimeout(() => openAmount(pair));
  }
  const next = VIEWS[key] ? key : 'main';
  const changed = next !== view || (next === 'feed' && (arg ?? null) !== feedCoin);
  view = next;
  feedLazy = changed;
  if (view === 'feed') {
    feedCoin = arg ?? null;
    if (changed) { feedDays = 60; feedQuery = ''; feedType = 'all'; }
  }
  render();
  if (changed) scrollTo(0, 0);
}

// ---------- оновлення застосунку ----------

function registerWorker() {
  // Локальна перевірка — без офлайн-кешу, інакше правки не видно до нової збірки
  if (!('serviceWorker' in navigator) || location.hostname === '127.0.0.1') return;
  const offer = (worker) => {
    upd.worker = worker;
    $('update').hidden = false;
    $('update-btn').onclick = () => worker.postMessage('skipWaiting');
    if (view === 'settings') render();
  };
  // updateViaCache 'none' — перевірка оновлення не бере sw.js і version.js з HTTP-кешу
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((reg) => {
    upd.reg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
      });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch((err) => console.warn('SW registration failed', err));
  // Перший візит: worker щойно взяв сторінку (clients.claim) — це не оновлення
  let controlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; }
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

async function init() {
  applyTheme();
  initLock({ key: 'marnotrat:lock', name: 'Марнотрат', icon: 'icons/icon-192.png' });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
  registerWorker();
  try {
    Object.assign(state, await loadAll());
    reportMonth = currentPeriod();
    // Фото скасованих і видалених операцій — геть; тихо, старт не чекає
    dropFilesExcept(new Set(state.ops.flatMap((op) => op.photos ?? []))).catch(() => {});
    if (!state.meta.some((m) => m.id === 'seeded')) {
      await save({ coins: { put: M.seedCoins(uid) }, meta: { put: [{ id: 'seeded', at: M.ymd() }] } }, { redraw: false });
    }
    // Демо-дані з колишньої кнопки «Демо-дані» — геть (операції й ціль з позначкою demo)
    const demoOps = state.ops.filter((o) => o.demo).map((o) => o.id);
    const demoCoins = state.coins.filter((c) => c.demo).map((c) => c.id);
    if (demoOps.length || demoCoins.length) await save({ ops: { del: demoOps }, coins: { del: demoCoins } }, { redraw: false });
    // Теги з великої чи з пробілом (до 0.2.18, з таблиці, з іншого телефона) — в одне написання, двійники зливаються
    await fixTags();
  } catch (err) {
    $('view').replaceChildren(h('p', { class: 'error' }, `Не вдалося відкрити сховище браузера: ${err.message}`));
    return;
  }
  window.addEventListener('hashchange', route);
  // Синхронізація: при відкритті й поверненні в застосунок; ключ Google оновлюємо з першого натискання
  if (Sync.syncOn()) { Sync.preload(); runSync(); }
  runCloud();
  Bot.scheduleBot(botPayload, 1500);
  // Адреса й ключ бота прийшли з Диска (спільний bot-settings.json) — одразу підсумки, у налаштуваннях — новий стан
  // Ключ вставили в іншому застосунку на цьому телефоні
  addEventListener('storage', (e) => {
    if (e.key !== 'vitaliylobko:bot') return;
    scheduleCloud(0);
    Bot.scheduleBot(botPayload, 0);
    render();
  });
  window.addEventListener('bot-config', () => {
    scheduleCloud(0);
    Bot.scheduleBot(botPayload, 0);
    if (view === 'settings') render();
  });
  showWhatsNew();
  document.addEventListener('pointerup', () => { if (Sync.syncOn() && !Sync.tokenValid()) runSync({ gesture: true }); }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { runSync(); scheduleCloud(300); Bot.scheduleBot(botPayload, 1500); Widget.scheduleWidget(widgetHead); }
  });
  addEventListener('online', () => { refreshChip(); scheduleCloud(500); });
  addEventListener('offline', refreshChip);
  addEventListener('resize', () => { if (onMain()) fitNames(); });
  bindPullToday();
  // Тінь під закріпленим рядом рахунків — лише коли під ним уже гортаються витрати
  addEventListener('scroll', () => {
    const row = onMain() && document.querySelector('.main .accounts');
    if (row) row.classList.toggle('stuck', row.getBoundingClientRect().top <= $('topbar').offsetHeight + 0.5 && scrollY > 0);
  }, { passive: true });
  route();
  // Курс НБУ — раз на день, тихо: без зв'язку лишається попередній
  fetchRates().then((changed) => { if (changed && view !== 'settings') render(); }).catch(() => {});
  // Новий день чи місяць — головна має перерахуватись
  let day = M.ymd();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && M.ymd() !== day) { day = M.ymd(); if (!$('layer').childElementCount) render(); }
  });
}

init();
