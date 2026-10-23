// Марнотрат: головна з монетами, екран суми, стрічка, звіти, налаштування.
import { loadAll, write, uid, replaceAll } from './db.js';
import * as M from './model.js';
import { $, h, icon, hasIcon, toast, sheet, closeSheet, chips, swipeStep, vibrate } from './ui.js';

const state = { coins: [], ops: [], meta: [] };
let view = 'main';
// Стрічка однієї монети (тап по монеті) — її id; інакше null
let feedCoin = null;
let feedDays = 60;
let reportKind = 'expense';
let reportMonth = M.monthOf(M.ymd());
let reportPick = null;
let dayDate = M.ymd();
// Оновлення застосунку: реєстрація service worker і нова версія, що чекає
const upd = { reg: null, worker: null };

// Ключі localStorage — з префіксом: origin спільний із shooting-log, weight-log, hobby-planner
const PREFIX = 'marnotrat:';

function remember(key, value) {
  try { localStorage.setItem(PREFIX + key, value ?? ''); } catch { /* приватний режим */ }
}

function recall(key) {
  try { return localStorage.getItem(PREFIX + key); } catch { return null; }
}

const coin = (id) => state.coins.find((c) => c.id === id);
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
  await write(changes);
  for (const [name, { put = [], del = [] }] of Object.entries(changes)) {
    const ids = new Set([...del, ...put.map((x) => x.id)]);
    state[name] = [...state[name].filter((x) => !ids.has(x.id)), ...put];
  }
  if (redraw) render();
}

// ---------- підрахунки ----------

function balance(acc) {
  let v = acc.start || 0;
  for (const op of state.ops) {
    if (op.to === acc.id) v += amountIn(op);
    if (op.from === acc.id) v -= op.amount;
  }
  return M.round2(v);
}

const inMonth = (op, ym) => op.date.startsWith(ym);

function monthSpent(c, ym) {
  return state.ops.reduce((s, op) => (op.to === c.id && inMonth(op, ym) ? s + amountIn(op) : s), 0);
}

function monthIncome(c, ym) {
  return state.ops.reduce((s, op) => (op.from === c.id && inMonth(op, ym) ? s + op.amount : s), 0);
}

/** Як операція міняє гроші на рахунках, у гривнях: дохід +, витрата −, переказ — лише різниця курсів. */
function accDelta(op) {
  const t = opType(op);
  if (t === 'income') return toUah(amountIn(op), coinOr(op.to).currency);
  if (t === 'expense') return -toUah(op.amount, coinOr(op.from).currency);
  return toUah(amountIn(op), coinOr(op.to).currency) - toUah(op.amount, coinOr(op.from).currency);
}

/** Витрати й доходи за період у гривнях (date — день чи місяць «2026-10»). */
function totals(prefix) {
  let expense = 0;
  let income = 0;
  for (const op of state.ops) {
    if (!op.date.startsWith(prefix)) continue;
    const t = opType(op);
    if (t === 'expense') expense += toUah(amountIn(op), coinOr(op.to).currency);
    else if (t === 'income') income += toUah(op.amount, coinOr(op.from).currency);
  }
  return { expense, income };
}

const totalBalance = () => coinsOf('account').reduce((s, a) => s + toUah(balance(a), a.currency), 0)
  + state.coins.filter((c) => c.kind === 'account' && c.archived).reduce((s, a) => s + toUah(balance(a), a.currency), 0);

// ---------- головна ----------

function headStats() {
  const { expense, income } = totals(M.monthOf(M.ymd()));
  // Підсумки в гривнях — без копійок: долари за курсом дають «54 451,10»
  const stat = (label, v) => h('div', {}, h('span', {}, label), h('b', {}, M.money(Math.round(v))));
  return h('div', { class: 'stats' }, stat('Баланс', totalBalance()), stat('Витрати', expense), stat('Доходи', income));
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
  } else {
    sum = monthSpent(c, ym);
    ({ st, fill } = M.budgetState(sum, c.budget));
    if (c.budget) sub = M.num(c.budget);
  }
  const face = h('div', { class: 'coin-face', style: { '--fill': String(fill) } },
    c.kind === 'expense' ? h('span', { class: 'coin-fill' }) : null,
    icon(hasIcon(c.icon) ? c.icon : 'coins', 'ico coin-ico'));
  const el = h('div', { class: `coin k-${c.kind}${st ? ` st-${st}` : ''}`, 'data-id': c.id, 'data-kind': c.kind },
    h('div', { class: 'coin-name' }, c.name),
    face,
    h('div', { class: 'coin-sum' }, M.money(sum, c.currency)),
    sub != null ? h('div', { class: 'coin-sub' }, sub) : null);
  bindCoin(el, face, c);
  return el;
}

function addCoinEl(kind) {
  return h('button', { type: 'button', class: 'coin coin-add', 'aria-label': `Додати: ${M.KINDS[kind].toLowerCase()}`, onClick: () => editCoin(null, kind) },
    h('div', { class: 'coin-name' }, ' '),
    h('div', { class: 'coin-face' }, icon('plus')));
}

function viewMain() {
  const ym = M.monthOf(M.ymd());
  const incomeOpen = recall('income-open') === '1';
  return h('div', { class: 'main' },
    incomeOpen ? h('div', { class: 'coin-row incomes' }, coinsOf('income').map((c) => coinEl(c, ym)), addCoinEl('income')) : null,
    h('div', { class: 'coin-row accounts' }, coinsOf('account').map((c) => coinEl(c, ym)), addCoinEl('account')),
    h('div', { class: 'coin-grid expenses' }, coinsOf('expense').map((c) => coinEl(c, ym)), addCoinEl('expense')),
    state.ops.length ? null : h('p', { class: 'muted small main-hint' },
      'Тягни монету пальцем: дохід — на рахунок, рахунок — на витрату чи інший рахунок. Тап — історія монети, довге натискання — змінити.'));
}

// ---------- перетягування монет ----------

/** Куди можна тягнути: дохід → рахунок; рахунок → рахунок чи витрата. */
function canDrop(src, dst) {
  if (!dst || src.id === dst.id) return false;
  if (src.kind === 'income') return dst.kind === 'account';
  if (src.kind === 'account') return dst.kind === 'account' || dst.kind === 'expense';
  return false;
}

const LONG_PRESS = 500;
const EDGE = 70;

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
      editCoin(c);
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
      for (const t of document.querySelectorAll('.coin[data-id]')) {
        if (canDrop(c, coin(t.dataset.id))) t.classList.add('drop-ok');
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
        if (c.kind === 'expense') { cleanup(); return; }
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
      cleanup();
      if (wasDrag && target && ev.type === 'pointerup') openAmount({ from: c.id, to: target.dataset.id });
      else if (tap) openFeed(c.id);
    };
    function cleanup() {
      clearTimeout(timer);
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      removeEventListener('pointercancel', onUp);
      if (!drag) return;
      cancelAnimationFrame(drag.raf);
      drag.ghost.remove();
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
function openAmount({ from, to, op = null }) {
  const src = coinOr(from);
  const dst = coinOr(to);
  const two = src.currency !== dst.currency;
  const d = {
    a: op ? M.toExpr(op.amount) : '',
    b: op && two ? M.toExpr(amountIn(op)) : '',
    bOwn: Boolean(op && two),
    bTyped: Boolean(op && two),
    active: 'a',
    tags: [...(op?.tags ?? [])],
    comment: op?.comment ?? '',
    date: op?.date ?? M.ymd(),
    panel: null,
  };
  const autoB = () => M.round2(M.calc(d.a) * rate(src.currency) / rate(dst.currency));

  const lineA = h('button', { type: 'button', class: 'amt-line', onClick: () => { d.active = 'a'; paint(); } });
  const lineB = h('button', { type: 'button', class: 'amt-line second', onClick: () => { d.active = 'b'; if (!d.bOwn) { d.b = M.toExpr(autoB()); d.bOwn = true; } paint(); } });
  const res = h('div', { class: 'amt-res' });
  const note = h('div', { class: 'amt-note' });
  const tagBar = h('div', { class: 'amt-tags' });
  const lower = h('div', {});

  const line = (el, expr, cur, on, placeholder) => {
    el.classList.toggle('on', on);
    el.replaceChildren(h('span', { class: 'amt-val' }, expr || placeholder), h('span', { class: 'amt-cur' }, cur));
  };
  const paint = () => {
    line(lineA, d.a, src.currency, d.active === 'a', '0');
    if (two) line(lineB, d.bOwn ? d.b : M.toExpr(autoB()), dst.currency, d.active === 'b', '0');
    const expr = d.active === 'a' ? d.a : d.b;
    const v = M.calc(expr);
    res.textContent = M.hasOp(expr) ? (Number.isNaN(v) ? 'помилка' : `= ${M.num(v)}`) : '';
    note.textContent = [d.tags.map((t) => `#${t}`).join(' '), d.comment].filter(Boolean).join(' · ');
    paintTags();
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
      id: op?.id ?? uid(), from, to, amount: a, date: date || d.date,
      tags: d.tags, comment: d.comment.trim(), created: op?.created ?? Date.now(),
    };
    if (two) rec.amountTo = b;
    closeSheet();
    await save({ ops: { put: [rec] } });
    const t = opType(rec);
    const sign = t === 'expense' ? '−' : t === 'income' ? '+' : '';
    const what = `${dst.name}: ${M.money(t === 'income' ? amountIn(rec) : rec.amount, t === 'income' ? dst.currency : src.currency, { sign })}`;
    toast(op ? 'Операцію змінено' : what, {
      label: 'Скасувати',
      run: () => save(op ? { ops: { put: [{ ...op }] } } : { ops: { del: [rec.id] } }),
    });
  };
  const remove = async () => {
    closeSheet();
    await save({ ops: { del: [op.id] } });
    toast('Операцію видалено', { label: 'Скасувати', run: () => save({ ops: { put: [{ ...op }] } }) });
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
      key(icon('comment'), () => showPanel('comment'), 'Коментар'),
      key(icon('refresh'), () => toast('Повторювані операції — у наступній версії'), 'Повторювати'),
      key('−', () => operator('−'), 'Мінус'), key('%', () => operator('%'), 'Відсоток'),
      key('+', () => operator('+'), 'Плюс'), key('×', () => operator('×'), 'Помножити'),
      key('=', equals, 'Дорівнює'), key('÷', () => operator('÷'), 'Поділити')));

  const dates = op
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
    if (kind === 'comment') {
      const ta = h('textarea', { rows: 3, maxlength: 200, placeholder: 'Наприклад: Екофлоу', class: 'field' }, d.comment);
      lower.replaceChildren(h('div', { class: 'amt-panel form' },
        h('label', { class: 'flabel' }, 'Коментар'), ta,
        h('div', { class: 'btn-grid' }, h('button', {
          type: 'button', class: 'btn primary', onClick: () => { d.comment = ta.value; hidePanel(); },
        }, icon('check'), 'Готово'))));
      ta.focus();
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

  const screen = h('div', { class: 'amt' },
    h('div', { class: 'amt-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Скасувати', onClick: () => closeSheet() }, icon('close')),
      h('div', { class: 'amt-route' }, h('span', {}, src.name), icon('next'), h('span', {}, dst.name)),
      op ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Видалити', onClick: remove }, icon('trash')) : null,
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Зберегти', onClick: () => store() }, icon('check'))),
    h('div', { class: 'amt-body' }, lineA, two ? lineB : null, res, note));
  lower.replaceChildren(pad, dates);
  sheet(`${src.name} → ${dst.name}`, [screen.firstChild, screen.lastChild, dst.kind === 'expense' ? tagBar : null, lower], { cls: 'screen', bare: true });
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
  const note = [(op.tags ?? []).map((x) => `#${x}`).join(' '), op.comment].filter(Boolean);
  const second = op.amountTo != null && t === 'transfer' ? ` → ${M.money(op.amountTo, dst.currency)}` : '';
  return h('button', { type: 'button', class: 'op-row', onClick: () => openAmount({ from: op.from, to: op.to, op }) },
    h('span', { class: 'op-ends' }, h('span', { class: 'op-from' }, src.name), h('span', { class: 'op-to' }, dst.name)),
    h('span', { class: 'op-right' },
      h('span', { class: `op-sum ${t}` }, M.money(v, cur, { sign }) + second),
      note.map((x) => h('span', { class: 'op-note' }, x))));
}

const byNewest = (a, b) => b.date.localeCompare(a.date) || (b.created ?? b.updated ?? 0) - (a.created ?? a.updated ?? 0);

function viewFeed() {
  const ops = state.ops.filter((op) => !feedCoin || op.from === feedCoin || op.to === feedCoin).sort(byNewest);
  if (!ops.length) return h('p', { class: 'empty' }, feedCoin ? 'У цієї монети ще немає операцій' : 'Ще немає операцій — потягни монету на головній');
  const days = [...new Set(ops.map((op) => op.date))];
  const shown = days.slice(0, feedDays);
  // Залишок на кінець дня: від сьогоднішнього назад віднімаємо зміни пізніших днів
  const delta = new Map();
  for (const op of state.ops) delta.set(op.date, (delta.get(op.date) ?? 0) + accDelta(op));
  let bal = totalBalance();
  const later = [...delta.keys()].filter((dt) => dt > shown[0]);
  for (const dt of later) bal -= delta.get(dt);
  const today = M.ymd();
  const blocks = [];
  for (const date of shown) {
    const dayOps = ops.filter((op) => op.date === date);
    const { expense, income } = totals(date);
    const change = income - expense;
    blocks.push(h('h2', { class: 'day-title' }, M.dayHead(date, today)),
      h('div', { class: 'card' },
        dayOps.map(opRow),
        feedCoin ? null : h('div', { class: 'day-foot' },
          h('div', {}, h('b', {}, M.money(Math.round(bal))), h('span', {}, 'на рахунках')),
          h('div', {}, h('b', { class: change > 0 ? 'plus' : change < 0 ? 'minus' : '' }, M.money(change, 'UAH', { sign: change > 0 ? '+ ' : change < 0 ? '− ' : '' })), h('span', {}, 'зміна')))));
    bal -= delta.get(date) ?? 0;
  }
  return h('div', { class: 'stack' }, blocks,
    days.length > shown.length ? h('button', { type: 'button', class: 'more-btn', onClick: () => { feedDays += 60; render(); } }, 'Показати ще') : null);
}

// ---------- звіти ----------

const SLOTS = 7;

/** Частки за місяць: [{ c, v, color }] за спаданням; понад 7 — у «Інше». */
function reportParts(kind, ym) {
  const list = state.coins.filter((c) => c.kind === kind)
    .map((c) => ({ c, v: kind === 'expense' ? toUah(monthSpent(c, ym), c.currency) : toUah(monthIncome(c, ym), c.currency) }))
    .filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
  const top = list.slice(0, SLOTS).map((x, i) => ({ ...x, color: `var(--s${i + 1})` }));
  const rest = list.slice(SLOTS);
  if (rest.length) top.push({ c: { id: 'other', name: `Інше (${rest.length})` }, v: rest.reduce((s, x) => s + x.v, 0), color: 'var(--s-other)', rest });
  return top;
}

function donut(parts, total, center) {
  const R = 100;
  const C = 2 * Math.PI * R;
  const GAP = parts.length > 1 ? 2 : 0;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '-140 -140 280 280');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', parts.map((p) => `${p.c.name} ${Math.round((p.v / total) * 100)}%`).join(', '));
  let acc = 0;
  for (const p of parts) {
    const share = p.v / total;
    const len = Math.max(share * C - GAP, 0.5);
    const seg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    seg.setAttribute('r', R);
    seg.setAttribute('class', `donut-seg${reportPick && reportPick !== p.c.id ? ' dim' : ''}`);
    seg.setAttribute('stroke', p.color);
    seg.setAttribute('stroke-dasharray', `${len} ${C - len}`);
    seg.setAttribute('stroke-dashoffset', String(-acc * C));
    seg.setAttribute('transform', 'rotate(-90)');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = `${p.c.name}: ${M.money(p.v)}`;
    seg.append(title);
    seg.addEventListener('click', () => { reportPick = reportPick === p.c.id ? null : p.c.id; render(); });
    svg.append(seg);
    // Підпис відсотка — лише для помітних часток, щоб не налазили
    if (share >= 0.05) {
      const mid = (acc + share / 2) * 2 * Math.PI - Math.PI / 2;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', String(Math.cos(mid) * (R + 22)));
      t.setAttribute('y', String(Math.sin(mid) * (R + 22) + 4));
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('class', 'donut-label');
      t.textContent = `${Math.round(share * 100)}%`;
      svg.append(t);
    }
    acc += share;
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
  const parts = reportParts(reportKind, reportMonth);
  const total = parts.reduce((s, p) => s + p.v, 0);
  const picked = parts.find((p) => p.c.id === reportPick);
  const stepMonth = (n) => { reportMonth = M.addMonths(reportMonth, n); reportPick = null; render(); return true; };
  const body = h('div', { class: 'page stack' },
    periodNav(M.monthTitle(reportMonth), stepMonth),
    total ? donut(parts, total, picked
      ? [h('span', {}, picked.c.name), h('b', {}, M.money(picked.v)), h('span', {}, `${Math.round((picked.v / total) * 100)}%`)]
      : [h('span', {}, M.monthTitle(reportMonth)), h('b', {}, M.money(total))])
      : h('p', { class: 'empty' }, reportKind === 'expense' ? 'Цього місяця витрат немає' : 'Цього місяця доходів немає'),
    total ? h('div', { class: 'card' }, parts.map((p) => h('button', {
      type: 'button', class: `rep-row${reportPick === p.c.id ? ' on' : ''}`,
      onClick: () => { if (p.rest) { reportPick = reportPick === p.c.id ? null : p.c.id; render(); } else openFeed(p.c.id); },
    },
    h('span', { class: 'rep-dot', style: { background: p.color } }),
    h('span', { class: 'rep-name' }, p.c.name),
    h('span', { class: 'rep-pct' }, `${Math.round((p.v / total) * 100)}%`),
    h('span', { class: 'rep-sum' }, M.money(p.v))))) : null);
  swipeStep(body, stepMonth);
  const tab = (k, label) => h('button', { type: 'button', class: reportKind === k ? 'on' : '', onClick: () => { reportKind = k; reportPick = null; render(); } }, label);
  return h('div', {}, h('div', { class: 'tabs-bar' }, tab('expense', 'Витрати'), tab('income', 'Доходи')), body);
}

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

function editCoin(orig, kind = orig?.kind) {
  const d = orig ? structuredClone(orig)
    : { id: uid(), kind, name: '', icon: kind === 'account' ? 'wallet' : kind === 'income' ? 'banknote' : 'shopping-cart', currency: 'UAH', budget: 0, start: 0, order: Date.now(), archived: false };
  const used = orig && state.ops.some((op) => op.from === orig.id || op.to === orig.id);
  const name = h('input', { type: 'text', maxlength: 30, value: d.name, placeholder: 'Назва', autocomplete: 'off', 'aria-label': 'Назва' });
  const amountField = (value, label) => h('input', { type: 'number', inputmode: 'decimal', step: '0.01', min: '0', value: value || '', placeholder: '0', 'aria-label': label });
  const budget = amountField(d.budget, kind === 'income' ? 'План на місяць' : 'Бюджет на місяць');
  const start = amountField(orig ? balance(orig) : 0, 'Залишок зараз');
  const icons = M.COIN_ICONS.filter(hasIcon);
  const grid = h('div', { class: 'icon-grid', role: 'group', 'aria-label': 'Іконка' });
  const paintIcons = () => {
    for (const b of grid.children) b.setAttribute('aria-pressed', String(b.dataset.v === d.icon));
  };
  for (const k of icons) {
    grid.append(h('button', { type: 'button', class: 'icon-opt', 'data-v': k, 'aria-label': k, onClick: () => { d.icon = k; paintIcons(); } }, icon(k)));
  }
  paintIcons();
  const store = async () => {
    const rec = { ...d, name: name.value.trim() };
    if (!rec.name) { toast('Дай назву'); return; }
    rec.budget = Math.max(0, Number(budget.value) || 0);
    if (kind === 'account') {
      // Залишок задають «скільки зараз»: різницю переносимо в стартовий, операції не чіпаємо
      const now = Number(start.value) || 0;
      rec.start = M.round2((d.start || 0) + now - (orig ? balance(orig) : 0));
    }
    closeSheet();
    await save({ coins: { put: [rec] } });
  };
  const remove = async () => {
    closeSheet();
    if (used) {
      await save({ coins: { put: [{ ...orig, archived: true }] } });
      toast(`«${orig.name}» сховано — операції лишились`, { label: 'Скасувати', run: () => save({ coins: { put: [{ ...orig }] } }) });
    } else {
      await save({ coins: { del: [orig.id] } });
      toast(`«${orig.name}» видалено`, { label: 'Скасувати', run: () => save({ coins: { put: [{ ...orig }] } }) });
    }
  };
  sheet(orig ? orig.name : `Нова монета: ${M.KINDS[kind].toLowerCase()}`, h('div', { class: 'form' },
    h('label', { class: 'flabel' }, 'Назва'), name,
    kind !== 'expense' || !used ? [h('p', { class: 'flabel' }, 'Валюта'), chips(M.CURRENCIES, d.currency, (v) => { d.currency = v; })] : null,
    kind === 'account' ? [h('label', { class: 'flabel' }, `Залишок зараз`), start] : null,
    kind !== 'account' ? [h('label', { class: 'flabel' }, kind === 'income' ? 'План на місяць (не обов’язково)' : 'Бюджет на місяць'), budget] : null,
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
    h('section', { class: 'card set-card' }, h('h2', {}, 'Тема'), theme),
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
    h('section', { class: 'card set-card' },
      h('h2', {}, 'Резервна копія'),
      h('p', { class: 'muted small' }, 'Усе зберігається лише на цьому телефоні. Копія — файл JSON: зберігай його, щоб не втратити дані.'),
      h('div', { class: 'btn-grid' },
        h('button', { type: 'button', class: 'btn', onClick: exportBackup }, icon('archive'), 'Зберегти копію'),
        h('button', { type: 'button', class: 'btn', onClick: () => file.click() }, icon('undo'), 'Відновити')),
      file),
    h('section', { class: 'card set-card' },
      h('h2', {}, 'Марнотрат'),
      h('p', { class: 'muted small' }, `Версія ${self.APP_VERSION ?? '?'} · збірка ${self.APP_BUILD ?? '?'}`),
      upd.worker ? h('button', { type: 'button', class: 'btn primary', onClick: () => upd.worker.postMessage('skipWaiting') }, icon('refresh'), 'Оновити') : null));
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
    h('p', {}, `Монет: ${data.coins.length}, операцій: ${data.ops.length}. Поточні дані на цьому телефоні буде замінено.`),
    h('div', { class: 'btn-grid' },
      h('button', {
        type: 'button', class: 'btn danger', onClick: async () => {
          closeSheet();
          await replaceAll(data);
          Object.assign(state, await loadAll());
          toast('Відновлено');
          render();
        },
      }, icon('check'), 'Відновити'),
      h('button', { type: 'button', class: 'btn', onClick: () => closeSheet() }, 'Скасувати'))));
}

// ---------- меню й маршрути ----------

const MENU = [
  ['feed', 'feed', 'Стрічка'],
  ['days', 'daily', 'Звіт по днях'],
  ['report', 'pie', 'Загальний'],
  ['settings', 'gear', 'Налаштування'],
];

function openMenu() {
  // Пункт меню займає запис шторки в історії: «Назад» з екрана веде на головну, а не в закрите меню.
  // Звичайне закриття (history.back) скасувало б перехід, що йде слідом
  const pick = (key) => {
    close(true);
    history.replaceState(null, '', `#${key}`);
    route();
  };
  const close = sheet('Меню', h('nav', { class: 'menu' },
    h('div', { class: 'menu-brand' }, 'Марнотрат'),
    MENU.map(([key, ico, label]) => h('button', { type: 'button', class: 'menu-item', onClick: () => pick(key) }, icon(ico), label))),
  { cls: 'drawer', bare: true });
}

function openFeed(id) {
  go(`feed/${id}`);
}

function go(hash) {
  location.hash = `#${hash}`;
}

const VIEWS = {
  main: { render: viewMain },
  feed: { title: () => (feedCoin ? coinOr(feedCoin).name : 'Стрічка'), render: viewFeed },
  report: { title: 'Загальний', render: viewReport },
  days: { title: 'Звіт по днях', render: viewDays },
  settings: { title: 'Налаштування', render: viewSettings },
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
  const { title } = VIEWS[view];
  bar.className = 'topbar brand';
  bar.replaceChildren(
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Назад', onClick: () => (history.length > 1 ? history.back() : go('main')) }, icon('back')),
    h('h1', {}, typeof title === 'function' ? title() : title));
}

function render() {
  topbar();
  $('view').replaceChildren(VIEWS[view].render());
}

function route() {
  const [key, arg] = location.hash.slice(1).split('/');
  const next = VIEWS[key] ? key : 'main';
  const changed = next !== view || (next === 'feed' && (arg ?? null) !== feedCoin);
  view = next;
  if (view === 'feed') {
    feedCoin = arg ?? null;
    if (changed) feedDays = 60;
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
    if (!state.meta.some((m) => m.id === 'seeded')) {
      await save({ coins: { put: M.seedCoins(uid) }, meta: { put: [{ id: 'seeded', at: M.ymd() }] } }, { redraw: false });
    }
  } catch (err) {
    $('view').replaceChildren(h('p', { class: 'error' }, `Не вдалося відкрити сховище браузера: ${err.message}`));
    return;
  }
  window.addEventListener('hashchange', route);
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
