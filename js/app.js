// Марнотрат: головна з монетами, екран суми, стрічка, звіти, налаштування.
import { loadAll, write, uid, replaceAll, putFile, getFile, dropFilesExcept } from './db.js';
import { slAvailable, readJournal, addRecord, patchRecord, removeRecord } from './journal.js';
import * as M from './model.js';
import * as Sync from './sync.js';
import { demoChanges, demoRemoval, hasDemo } from './demo.js';
import { CHANGES, changesSince } from './changes.js';
import { $, h, icon, hasIcon, toast, sheet, closeSheet, chips, swipeStep, vibrate } from './ui.js';

const state = { coins: [], ops: [], meta: [] };
let view = 'main';
// Стрічка однієї монети (тап по монеті) — її id; інакше null
let feedCoin = null;
let feedDays = 60;
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

const coin = (id) => state.coins.find((c) => c.id === id);
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

/** Один прохід синхронізації. gesture — викликано з натискання: можна оновити ключ Google. */
async function runSync({ gesture = false, loud = false } = {}) {
  if (!Sync.syncOn() || !navigator.onLine) return;
  if (sync.busy) { sync.again = true; return; }
  sync.busy = true;
  try {
    if (loud) await Sync.ensureToken();
    else if (!Sync.tokenValid() && !(gesture && await Sync.refreshByGesture())) return;
    // Свого на цьому телефоні ще нічого — беремо Диск як є, без злиття стартових монет
    const fresh = !Sync.lastSync() && !state.ops.some((o) => !o.demo);
    const merged = await Sync.syncNow(snapshot(), { fresh, envelope: { version: self.APP_VERSION } });
    sync.error = '';
    if (merged) {
      // Поки ходили на Диск, тут могли щось змінити — зливаємо ще раз зі свіжим станом
      const final = fresh ? merged : Sync.merge(snapshot(), merged);
      await replaceAll(final);
      Object.assign(state, final);
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
  }
}

// ---------- підрахунки ----------

function balance(acc, ops = state.ops) {
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

function monthSpent(c, ym) {
  return state.ops.reduce((s, op) => (op.to === c.id && inMonth(op, ym) ? s + amountIn(op) : s), 0);
}

function monthIncome(c, ym) {
  return state.ops.reduce((s, op) => (op.from === c.id && inMonth(op, ym) ? s + op.amount : s), 0);
}

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
  let expense = 0;
  let income = 0;
  const hit = key.length === 7 ? (op) => inMonth(op, key) : (op) => op.date === key;
  for (const op of state.ops) {
    if (!hit(op)) continue;
    const t = opType(op);
    if (t === 'expense') expense += toUah(amountIn(op), coinOr(op.to).currency);
    else if (t === 'income') income += toUah(op.amount, coinOr(op.from).currency);
  }
  return { expense, income };
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
    // «В планах» — скільки ще можна витратити цього місяця: бюджети мінус уже витрачене
    plan ? stat('В планах', plan - expense, report('expense'), plan - expense < 0 ? 'minus' : '')
      : stat('Доходи', income, report('income')));
}

/** Колір монети витрати за поточний місяць — з темпом і кількістю операцій. */
function coinBudget(c, spent, ym = currentPeriod()) {
  const count = state.ops.filter((op) => op.to === c.id && inMonth(op, ym)).length;
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
    if (c.budget) sub = M.num(c.budget);
    if (c.budget && sum >= c.budget) st = 'done';
  } else {
    sum = monthSpent(c, ym);
    ({ st, fill } = coinBudget(c, sum, ym));
    if (c.budget) sub = M.num(c.budget);
  }
  const face = h('div', { class: 'coin-face', style: { '--fill': String(fill) } },
    c.kind === 'expense' ? h('span', { class: 'coin-fill' }) : null,
    icon(hasIcon(c.icon) ? c.icon : 'coins', 'ico coin-ico'));
  const el = h('div', { class: `coin k-${c.kind}${st ? ` st-${st}` : ''}`, 'data-id': c.id, 'data-kind': c.kind },
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
  const track = h('div', { class: 'pager-track', 'data-pager': key },
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

/** Рядок на головній: заплановані повтори, яким уже пора, — тап веде в стрічку. */
function planHint() {
  if (editing()) return null;
  const n = dueCount();
  // Борги, яким настав строк і які ще не закриті
  const late = coinsOf('debt').filter((c) => c.due && c.due <= M.ymd() && Math.abs(balance(c)) >= 0.01);
  const rows = late.map((c) => {
    const bal = balance(c);
    return h('button', { type: 'button', class: 'plan-hint debt', onClick: () => openFeed(c.id) }, icon('handshake'),
      `${c.name}: ${bal > 0 ? 'час повернути тобі' : 'час віддати'} ${M.money(Math.abs(bal), c.currency)}`, icon('next'));
  });
  if (n) rows.unshift(h('button', { type: 'button', class: 'plan-hint', onClick: () => go('feed') }, icon('refresh'), `До проведення: ${n}`, icon('next')));
  // Гарантія спливає за місяць — ще є час звернутись
  const ending = warrantyOps().filter((op) => daysLeft(op.warranty) >= 0 && daysLeft(op.warranty) <= WARRANTY_SOON);
  if (ending.length) {
    const first = ending[0];
    rows.push(h('button', { type: 'button', class: 'plan-hint warranty', onClick: () => go('warranty') }, icon('shield'),
      ending.length === 1 ? `Гарантія: ${opName(first)} — до ${dmy(first.warranty)}` : `Гарантія спливає: ${ending.length} покупки за місяць`, icon('next')));
  }
  return rows.length ? rows : null;
}

function viewMain() {
  const ym = currentPeriod();
  const incomeOpen = recall('income-open') === '1';
  // Цілі стоять у сітці витрат, як копилка
  const grid = state.coins.filter((c) => (c.kind === 'expense' || c.kind === 'goal') && !c.archived).sort((a, b) => a.order - b.order);
  return h('div', { class: `main${editing() ? ' editing' : ''}` },
    incomeOpen ? pager('income', [...coinsOf('income').map((c) => coinEl(c, ym)), addCoinEl('income')], 4, 'coin-row incomes') : null,
    pager('account', [...state.coins.filter((c) => (c.kind === 'account' || c.kind === 'debt') && !c.archived)
      .sort((a, b) => a.order - b.order).map((c) => coinEl(c, ym)), addCoinEl('account')], 4, 'coin-row accounts'),
    planHint(),
    pager('expense', [...grid.map((c) => coinEl(c, ym)), addCoinEl('expense')], 16, 'expenses'),
    state.ops.length ? null : h('p', { class: 'muted small main-hint' },
      'Тягни монету пальцем: дохід — на рахунок, рахунок — на витрату чи інший рахунок. Тап — історія монети, довге натискання — змінити.'));
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

/** Перестановка: монета стає на місце тієї, на яку її кинули; решта ряду зсувається. */
async function reorder(src, dstId) {
  const list = state.coins.filter((c) => rowOf(c) === rowOf(src) && !c.archived).sort((a, b) => a.order - b.order);
  const from = list.findIndex((c) => c.id === src.id);
  const to = list.findIndex((c) => c.id === dstId);
  if (from < 0 || to < 0) return;
  list.splice(to, 0, list.splice(from, 1)[0]);
  const put = list.map((c, i) => (c.order === i ? null : { ...c, order: i })).filter(Boolean);
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
      const dir = !r ? 0 : at.x < r.left + PAGE_EDGE ? -1 : at.x > r.right - PAGE_EDGE ? 1 : 0;
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
      const hit = wasDrag && target && ev.type === 'pointerup';
      cleanup(hit ? target : null);
      if (hit) {
        if (editing()) reorder(c, target.dataset.id);
        else openAmount({ from: c.id, to: target.dataset.id });
      } else if (tap) {
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

/**
 * Введення суми після перетягування (op — правка наявної операції).
 * Різні валюти «звідки» й «куди» — два рядки; другий рахується за курсом, поки його не змінили руками.
 */
function openAmount({ from, to, op = null, preset = null }) {
  // preset — запланований повтор: поля з правила, зберігається новою операцією з fromRule
  const base = op ?? preset;
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
    note.textContent = [d.tags.map((t) => `#${t}`).join(' '), d.comment, d.repeat.every ? `⟳ ${M.repeatLabel(d.repeat.every)}${d.repeat.until ? ` до ${M.dateTitle(d.repeat.until)}` : ''}` : '',
      d.warranty ? `гарантія до ${dmy(d.warranty)}` : '', d.photos.length ? `фото: ${d.photos.length}` : ''].filter(Boolean).join(' · ');
    paintTags();
    pad.querySelector('[aria-label="Повторювати"]')?.classList.toggle('on', Boolean(d.repeat.every));
    pad.querySelector('[aria-label="Деталі"]')?.classList.toggle('on', Boolean(d.warranty || d.photos.length));
  };
  const paintTags = () => {
    const sugg = [...new Set([...d.tags, ...tagsFor(to)])].slice(0, 8);
    tagBar.replaceChildren(
      h('div', { class: 'amt-tags-list' }, sugg.map((t) => h('button', {
        type: 'button', class: `amt-tag${d.tags.includes(t) ? ' on' : ''}`, 'aria-pressed': String(d.tags.includes(t)),
        onClick: () => { toggleTag(t); },
      }, t))),
      h('button', { type: 'button', class: 'amt-more', 'aria-label': 'Усі теги', onClick: () => showPanel('tags') }, icon('dots')));
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

  const dates = base
    ? h('div', { class: 'dates' }, h('button', {
      type: 'button', onClick: () => pickDate((v) => { d.date = v; dates.firstChild.textContent = M.dateTitle(v); }),
    }, M.dateTitle(d.date)), dateInput)
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
      const ta = h('textarea', { rows: 2, maxlength: 200, placeholder: 'Наприклад: Екофлоу', class: 'field' }, d.comment);
      // Гарантія: дата кінця або швидко — роки від дати покупки
      const until = h('input', { type: 'date', class: 'field', value: d.warranty, min: d.date, 'aria-label': 'Гарантія до' });
      const years = (n) => M.addDays(`${Number(d.date.slice(0, 4)) + n}${d.date.slice(4)}`, 0);
      const quick = h('div', { class: 'chips' }, [[1, '1 рік'], [2, '2 роки'], [3, '3 роки']].map(([n, label]) => h('button', {
        type: 'button', class: 'chip', onClick: () => { until.value = years(n); },
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
    const input = h('input', { type: 'text', maxlength: 40, placeholder: 'Новий тег, напр. подарунки', class: 'field', enterkeyhint: 'done' });
    const list = h('div', { class: 'chips' });
    const drawList = () => list.replaceChildren(...[...new Set([...allTags(), ...d.tags])].map((t) => h('button', {
      type: 'button', class: `chip${d.tags.includes(t) ? ' on' : ''}`, onClick: () => { toggleTag(t); drawList(); },
    }, `#${t}`)));
    const addTag = () => {
      const t = input.value.trim().replace(/^#+/, '').replace(/\s+/g, ' ');
      if (t && !d.tags.includes(t)) d.tags.push(t);
      input.value = '';
      drawList();
      paint();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
    drawList();
    lower.replaceChildren(h('div', { class: 'amt-panel form' },
      h('label', { class: 'flabel' }, 'Теги'), input, list,
      h('div', { class: 'btn-grid' },
        h('button', { type: 'button', class: 'btn', onClick: addTag }, icon('plus'), 'Додати'),
        h('button', { type: 'button', class: 'btn primary', onClick: () => { addTag(); hidePanel(); } }, icon('check'), 'Готово'))));
  };
  const hidePanel = () => { d.panel = null; lower.replaceChildren(pad, dates); paint(); };

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
      op ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Видалити', onClick: remove }, icon('trash')) : null,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Зберегти', onClick: () => store() }, icon('check'))),
    h('div', { class: 'amt-body' }, lineA, lineB, res, avail, note));
  lower.replaceChildren(pad, dates);
  sheet(`${src.name} → ${dst.name}`, [screen.firstChild, screen.lastChild, tagBar, lower], { cls: 'screen', bare: true });
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
  // Запланований повтор: тап — провести з правкою суми, свайп вправо — провести як є, вліво — пропустити чи зупинити
  if (op.plan) {
    const row = h('button', { type: 'button', class: `op-row plan${op.date <= M.ymd() ? ' due' : ''}`, onClick: () => openAmount({ from: op.from, to: op.to, preset: op }) },
      h('span', { class: 'op-ends' }, h('span', { class: 'op-from' }, src.name), h('span', { class: 'op-to' }, dst.name)),
      h('span', { class: 'op-right' },
        h('span', { class: `op-sum ${t}` }, M.money(v, cur, { sign }) + second),
        note.map((x) => h('span', { class: 'op-note' }, x)),
        h('span', { class: 'op-note plan-tag' }, op.date <= M.ymd() ? 'провести →' : 'заплановано')));
    return swipeRow(row, { onLeft: () => planMenu(op), onRight: () => confirmPlan(op), labels: ['Провести', 'Пропустити'] });
  }
  const row = h('button', { type: 'button', class: 'op-row', onClick: () => openAmount({ from: op.from, to: op.to, op }) },
    h('span', { class: 'op-ends' }, h('span', { class: 'op-from' }, src.name), h('span', { class: 'op-to' }, dst.name)),
    h('span', { class: 'op-right' },
      h('span', { class: `op-sum ${t}` }, M.money(v, cur, { sign }) + second),
      note.map((x) => h('span', { class: 'op-note' }, x))));
  return swipeRow(row, { onLeft: () => deleteOp(op), onRight: () => openAmount({ from: op.from, to: op.to, op }) });
}

async function deleteOp(op) {
  if (refuse([], [op.id])) return;
  await save({ ops: { del: [op.id] } });
  toast('Операцію видалено', { label: 'Скасувати', run: () => save({ ops: { put: [{ ...op }] } }) });
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
  const out = [];
  for (const rule of state.ops) {
    if (!rule.repeat?.every) continue;
    const done = new Set(state.ops.filter((o) => o.fromRule === rule.id).map((o) => o.ruleDate));
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

const byNewest = (a, b) => b.date.localeCompare(a.date) || (b.created ?? b.updated ?? 0) - (a.created ?? a.updated ?? 0);

/**
 * Підсумок дня в стрічці однієї монети — «зміна» в її валюті: витрата — мінус витрачене,
 * дохід — плюс отримане, рахунок і ціль — прихід мінус розхід.
 */
function coinDayFoot(c, dayOps) {
  if (!c) return null;
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

/** Список днів стрічки під поточні монету, пошук і тип. */
function feedList() {
  const q = searchKey(feedQuery);
  const filtered = Boolean(q) || feedType !== 'all';
  const ops = [...state.ops, ...planned()]
    .filter((op) => !feedCoin || op.from === feedCoin || op.to === feedCoin)
    .filter((op) => feedType === 'all' || opType(op) === feedType)
    .filter((op) => opMatches(op, q))
    .sort(byNewest);
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
  for (const date of shown) {
    const dayOps = ops.filter((op) => op.date === date);
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
    out.push(h('section', { class: 'day' }, h('h2', { class: 'day-title' }, M.dayHead(date, today)),
      h('div', { class: 'card' }, dayOps.map(opRow), foot)));
  }
  if (days.length > shown.length) out.push(h('button', { type: 'button', class: 'more-btn', onClick: () => { feedDays += 60; render(); } }, 'Показати ще'));
  return out;
}

function viewFeed() {
  const list = h('div', { class: 'stack feed' }, feedList());
  let timer = 0;
  const search = h('input', {
    type: 'search', class: 'field', value: feedQuery, enterkeyhint: 'search', 'aria-label': 'Пошук у стрічці',
    placeholder: feedCoin ? 'Пошук: тег, коментар, сума…' : 'Пошук: рахунок, категорія, тег, коментар…',
    // Список — без перемальовування всього екрана: поле не втрачає фокус і клавіатура не ховається
    onInput: (e) => { feedQuery = e.target.value; clearTimeout(timer); timer = setTimeout(() => list.replaceChildren(...feedList()), 150); },
  });
  const types = feedCoin ? null : chips(FEED_TYPES, feedType, (v) => { feedType = v; list.replaceChildren(...feedList()); });
  return h('div', { class: 'page stack feed-page' }, h('div', { class: 'feed-tools' }, search, types), list);
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
  const top = list.slice(0, SLOTS).map((x, i) => ({ ...x, color: `var(--s${i + 1})` }));
  const rest = list.slice(SLOTS);
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
  const body = h('div', { class: 'page stack' },
    nav,
    total ? donut(parts, total, picked
      ? [h('span', {}, picked.c.name), h('b', {}, M.money(picked.v)), h('span', {}, `${Math.round((picked.v / total) * 100)}%`)]
      : [h('span', {}, custom ? shortRange() : periodTitle(reportMonth)), h('b', {}, M.money(real))])
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
    h('div', { class: 'card' },
      h('div', { class: 'kv' }, h('b', {}, 'Дохід'), h('span', { class: 'plus' }, signed(income))),
      h('div', { class: 'kv' }, h('b', {}, 'Витрата'), h('span', { class: 'minus' }, signed(-expense)))));
  return swipeStep(body, step);
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
  const paint = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === d.icon));
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
  return h('div', { class: 'icon-picker' }, search, h('div', { class: 'icon-groups' }, empty, groups));
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
    kind !== 'account' && !debt ? [h('label', { class: 'flabel' }, budgetLabel), budget] : null,
    holds ? [h('label', { class: 'flabel' }, startLabel), start] : null,
    h('p', { class: 'flabel' }, 'Іконка'), grid,
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn primary', onClick: store }, icon('check'), 'Зберегти'),
      orig ? h('button', { type: 'button', class: 'btn danger', onClick: remove }, icon('trash'), used ? 'Сховати' : 'Видалити') : null)));
}

// ---------- налаштування ----------

const THEMES = [['auto', 'Як у системі'], ['light', 'Світла'], ['dark', 'Темна']];

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
    h('p', { class: 'muted small' }, 'З якого дня рахувати місяць: бюджети, «Витрати», «В планах» і звіт «Загальний». Зручно — з дня зарплати.'),
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
  const theme = chips(THEMES, recall('theme') || 'auto', (v) => { remember('theme', v); applyTheme(); });
  return h('div', { class: 'page stack' },
    aboutPanel(),
    h('section', { class: 'card set-card' }, h('h2', {}, 'Тема'), theme),
    periodCard(),
    h('section', { class: 'card set-card' },
      h('h2', {}, 'Курси до гривні'),
      h('div', { class: 'rate-row' }, h('b', {}, '$'), rateInput('USD')),
      h('div', { class: 'rate-row' }, h('b', {}, '€'), rateInput('EUR')),
      rateStatus,
      h('button', {
        type: 'button', class: 'btn', onClick: async () => {
          try { await fetchRates(true); toast('Курс НБУ оновлено'); render(); } catch (err) { toast(err instanceof TypeError ? 'Немає зв’язку з НБУ' : err.message); }
        },
      }, icon('refresh'), 'Курс НБУ на сьогодні')),
    syncCard(),
    demoCard(),
    h('section', { class: 'card set-card' },
      h('h2', {}, 'Резервна копія'),
      h('p', { class: 'muted small' }, Sync.syncOn()
        ? 'Файл JSON з усіма даними — про всяк випадок, окремо від Google Диска.'
        : 'Без Google Диска все зберігається лише на цьому телефоні. Копія — файл JSON: зберігай його, щоб не втратити дані.'),
      h('div', { class: 'btn-grid' },
        h('button', { type: 'button', class: 'btn', onClick: exportBackup }, icon('archive'), 'Зберегти копію'),
        h('button', { type: 'button', class: 'btn', onClick: () => file.click() }, icon('undo'), 'Відновити')),
      file),
    h('section', { class: 'card set-card' },
      h('h2', {}, 'Почати з чистого'),
      h('p', { class: 'muted small' }, Sync.syncOn()
        ? 'Стерти всі монети й операції — тут, на Google Диску й на інших твоїх телефонах. Лишаться стартові монети.'
        : 'Стерти всі монети й операції на цьому телефоні. Лишаться стартові монети.'),
      h('button', { type: 'button', class: 'btn danger', onClick: wipeAll }, icon('close'), 'Стерти всі дані')),
    aboutCard());
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
        h('h2', {}, 'Про застосунок'),
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
      h('li', {}, 'Хочеш спершу подивитись — «Демо-дані» вище, потім «Прибрати демо».'))),
    h('p', { class: 'muted small' },
      link('https://github.com/VitaliyLobko/marnotrat/issues/new', 'Повідомити про помилку'), ' · ',
      link('https://github.com/VitaliyLobko/marnotrat', 'Вихідний код')));
}

function aboutCard() {
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' },
    upd.worker ? 'Нова версія завантажена — оновлення займе секунду, дані залишаться'
      : (upd.checked ? `У тебе остання версія · перевірено о ${upd.checked}` : ''));
  return h('section', { class: 'card set-card' },
    h('h2', {}, 'Марнотрат'),
    h('p', { class: 'muted small' }, `Версія ${self.APP_VERSION ?? '?'} · збірка ${self.APP_BUILD ?? '?'}`),
    status,
    h('div', { class: 'btn-grid' },
      upd.worker
        ? h('button', { type: 'button', class: 'btn primary', onClick: () => upd.worker.postMessage('skipWaiting') }, icon('refresh'), 'Оновити')
        : h('button', { type: 'button', class: 'btn', onClick: () => checkUpdate(status) }, icon('refresh'), 'Перевірити оновлення'),
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
  const off = () => sheet('Відключити Google Диск?', h('div', { class: 'form' },
    h('p', {}, 'Дані лишаються і тут, і на Диску — просто перестануть синхронізуватись.'),
    h('div', { class: 'btn-grid' },
      h('button', { type: 'button', class: 'btn danger', onClick: () => { closeSheet(); Sync.disconnect(); render(); } }, 'Відключити'),
      h('button', { type: 'button', class: 'btn', onClick: closeSheet }, 'Залишити'))));
  return h('section', { class: 'card set-card' },
    h('h2', {}, 'Google Диск'),
    h('p', { class: 'muted small' }, on
      ? (sync.error ? `Помилка: ${sync.error}` : last ? `Синхронізовано ${when}` : 'Ще не синхронізовано')
      : 'Дані спільні для всіх твоїх телефонів: файл marnotrat-sync.json на твоєму Диску. Застосунок бачить лише свої файли.'),
    on
      ? h('div', { class: 'btn-grid' },
        h('button', { type: 'button', class: 'btn primary', onClick: () => runSync({ loud: true }) }, icon('refresh'), 'Синхронізувати'),
        h('button', { type: 'button', class: 'btn', onClick: off }, icon('close'), 'Відключити'))
      : h('button', { type: 'button', class: 'btn primary', onClick: connect }, icon('refresh'), 'Підключити Google Диск'));
}

function demoCard() {
  const add = async () => {
    const changes = demoChanges(state.coins, uid);
    if (!changes) { toast('Потрібні хоча б один дохід, рахунок у гривнях і витрата'); return; }
    await save(changes, { redraw: false });
    toast(`Додано ${changes.ops.put.length} демо-операцій`);
    go('main');
  };
  const remove = async () => {
    const changes = demoRemoval(state);
    if (!changes) return;
    await save(changes);
    toast('Демо прибрано');
  };
  const has = hasDemo(state);
  return h('section', { class: 'card set-card' },
    h('h2', {}, 'Демо-дані'),
    h('p', { class: 'muted small' }, has
      ? 'Демо зараз у застосунку. «Прибрати» видалить лише демо-операції й ціль «Відпустка» — твоє лишиться.'
      : 'Три місяці вигаданих операцій, ціль і бюджети — щоб подивитись, як усе виглядає з даними.'),
    has
      ? h('button', { type: 'button', class: 'btn danger', onClick: remove }, icon('close'), 'Прибрати демо')
      : h('button', { type: 'button', class: 'btn', onClick: add }, icon('plus'), 'Додати демо-дані'));
}

const backupData = () => ({ app: 'marnotrat', version: self.APP_VERSION, exported: new Date().toISOString(), ...state });

function exportBackup() {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backupData(), null, 1)], { type: 'application/json' }));
  const a = h('a', { href: url, download: `marnotrat-${M.ymd()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importBackup(f) {
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { toast('Файл не читається як JSON'); return; }
  if (data?.app !== 'marnotrat' || !Array.isArray(data.coins) || !Array.isArray(data.ops)) { toast('Це не копія Марнотрата'); return; }
  sheet('Відновити з копії?', h('div', { class: 'form' },
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
  const keys = Array.from({ length: HIST_N }, (_, i) => M.addMonths(cur, i - HIST_N + 1));
  const vals = keys.map((k) => s.value(k));
  // Прогноз на поточний період — лише для витрат: темп «скільки вже» ÷ «яка частка минула»
  const el = periodElapsed(cur);
  const fc = s.kind === 'exp' && el > 0 && el < 1 && vals.at(-1) > 0 ? vals.at(-1) / el : null;
  // Середнє — по повних періодах, відколи є операції (місяці до першої операції — не нулі, а «ще не було»)
  const firstOp = state.ops.reduce((m, op) => (op.date < m ? op.date : m), '9999');
  const since = firstOp === '9999' ? cur : periodOf(firstOp);
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
  const slot = W / HIST_N;
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
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hist-svg', role: 'img', 'aria-label': `${s.name} за ${HIST_N} місяців` },
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
    tile(`Разом за ${HIST_N} міс.`, fmt(sum12)));
  const table = h('details', { class: 'card fold-card' }, h('summary', {}, 'Таблицею'),
    h('table', { class: 'hist-table' }, h('tbody', {}, [...keys].reverse().map((k) => h('tr', {},
      h('td', {}, periodTitle(k)), h('td', {}, fmt(vals[keys.indexOf(k)])))))));
  return h('div', { class: 'page stack' },
    histSelect(),
    h('div', { class: 'card hist-card' }, readout, svg,
      h('p', { class: 'hist-key muted small' },
        fc ? h('span', { class: 'hist-key-fc' }, 'пунктир — прогноз') : null,
        avg != null ? h('span', { class: 'hist-key-avg' }, 'лінія — середнє') : null)),
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
  const close = sheet('Меню', h('nav', { class: 'menu' },
    h('div', { class: 'menu-head' },
      h('img', { class: 'menu-logo', src: './icons/icon-192.png', alt: '', width: 44, height: 44 }),
      h('span', {}, h('b', {}, 'Марнотрат'), h('span', {}, `на рахунках ${M.money(Math.round(totalBalance()))}`))),
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

function topbar() {
  const bar = $('topbar');
  if (view === 'main') {
    const open = recall('income-open') === '1';
    bar.className = 'topbar';
    bar.replaceChildren(
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Меню', onClick: openMenu }, icon('menu')),
      headStats(),
      h('button', {
        type: 'button', class: `icon-btn${open ? ' chev-up' : ''}`, 'aria-label': open ? 'Сховати доходи' : 'Показати доходи', 'aria-expanded': String(open),
        onClick: () => { remember('income-open', open ? '0' : '1'); render(); },
      }, icon('chevron')));
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
  topbar();
  // Ряд рахунків прилипає під шапку — їй висота з вирізом екрана, тож міряємо, а не вгадуємо
  document.documentElement.style.setProperty('--topbar-h', `${$('topbar').offsetHeight}px`);
  $('view').replaceChildren(VIEWS[view].render());
  if (onMain()) { fitNames(); animateSums(); }
}

function route() {
  const [key, arg] = location.hash.slice(1).split('/');
  const next = VIEWS[key] ? key : 'main';
  const changed = next !== view || (next === 'feed' && (arg ?? null) !== feedCoin);
  view = next;
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
  } catch (err) {
    $('view').replaceChildren(h('p', { class: 'error' }, `Не вдалося відкрити сховище браузера: ${err.message}`));
    return;
  }
  window.addEventListener('hashchange', route);
  // Синхронізація: при відкритті й поверненні в застосунок; ключ Google оновлюємо з першого натискання
  if (Sync.syncOn()) { Sync.preload(); runSync(); }
  showWhatsNew();
  document.addEventListener('pointerup', () => { if (Sync.syncOn() && !Sync.tokenValid()) runSync({ gesture: true }); }, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync(); });
  addEventListener('resize', () => { if (onMain()) fitNames(); });
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
