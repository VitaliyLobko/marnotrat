// Демо-дані для перевірки: три місяці операцій поверх стартових монет. Усе з позначкою demo — прибирається однією кнопкою.
import * as M from './model.js';

// Детермінований «випадок»: однакові демо-дані на кожному пристрої й при кожному натисканні
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Витрати за назвою стартової монети: [разів на місяць, від, до, теги, коментарі]
const SPEND = {
  'Продукти': [12, 180, 1400, ['сільпо', 'атб', 'ринок'], ['', '', 'на тиждень']],
  'Їжа поза домом': [6, 120, 650, ['кава', 'обід'], ['', 'з колегами']],
  "Здоров'я і спорт": [2, 300, 1800, ['аптека', 'зал'], ['', 'абонемент']],
  'Хобі й відпочинок': [3, 200, 2500, ['кіно', 'патрони'], ['', '']],
  'Дім': [2, 150, 1200, ['епіцентр'], ['', 'лампочки']],
  'Комуналка': [1, 1800, 2600, ['світло', 'газ'], ['']],
  'Одяг і взуття': [1, 600, 3200, [], ['кросівки', '']],
  'Машина': [3, 800, 1900, ['пальне', 'мийка'], ['', '']],
  'Транспорт': [4, 15, 120, ['таксі', 'метро'], ['']],
  'Різне': [3, 50, 600, [], ['подарунок', '']],
};
const BUDGET = {
  'Продукти': 9000, 'Їжа поза домом': 2500, "Здоров'я і спорт": 2000, 'Хобі й відпочинок': 3000, 'Дім': 1500,
  'Комуналка': 2600, 'Одяг і взуття': 2000, 'Машина': 4000, 'Транспорт': 600, 'Різне': 1000,
};

/**
 * Зміни для save(): операції за поточний і два попередні місяці (до сьогодні), ціль «Відпустка»
 * і бюджети витратам, у яких їх ще немає. coins — усі монети, uid — генератор id.
 */
export function demoChanges(coins, uid, today = M.ymd()) {
  const live = coins.filter((c) => !c.archived);
  const ofKind = (k) => live.filter((c) => c.kind === k).sort((a, b) => a.order - b.order);
  const incomes = ofKind('income');
  const uah = ofKind('account').filter((c) => c.currency === 'UAH');
  const usd = ofKind('account').find((c) => c.currency === 'USD');
  const expenses = ofKind('expense');
  if (!incomes.length || !uah.length || !expenses.length) return null;

  const rnd = rng(20261023);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => Math.round(a + rnd() * (b - a));
  const card = uah[1] ?? uah[0];
  const cash = uah[0];
  const ops = [];
  const op = (from, to, amount, date, extra = {}) => {
    if (date > today) return;
    ops.push({ id: uid(), from: from.id, to: to.id, amount, date, tags: [], comment: '', created: Date.now(), demo: true, ...extra });
  };

  const maxOrder = Math.max(0, ...coins.map((c) => c.order ?? 0));
  const goal = {
    id: uid(), kind: 'goal', name: 'Відпустка', icon: 'plane', currency: 'UAH', budget: 30000, start: 0,
    order: maxOrder + 1, archived: false, demo: true,
  };

  for (let back = 2; back >= 0; back -= 1) {
    const ym = M.addMonths(M.monthOf(today), -back);
    const day = (d) => `${ym}-${String(d).padStart(2, '0')}`;
    op(incomes[0], card, 42000, day(5), { comment: 'аванс + зарплата' });
    op(incomes[0], card, 18000, day(20));
    if (incomes[1]) op(incomes[1], cash, between(1500, 4000), day(between(8, 25)), { comment: 'продав на OLX' });
    op(card, cash, 5000, day(6), { comment: 'зняв готівку' });
    op(card, goal, 6000, day(21));
    if (usd) op(card, usd, 4150, day(12), { amountTo: 100, comment: 'обмінник' });
    for (const coin of expenses) {
      const plan = SPEND[coin.name] ?? [2, 100, 800, [], ['']];
      const [times, lo, hi, tags, notes] = plan;
      for (let i = 0; i < times; i += 1) {
        const tag = tags.length && rnd() < 0.7 ? [pick(tags)] : [];
        op(rnd() < 0.3 ? cash : card, coin, between(lo, hi), day(between(1, 28)), { tags: tag, comment: pick(notes) });
      }
    }
  }
  const budgets = expenses
    .filter((c) => !c.budget)
    .map((c) => ({ ...c, budget: BUDGET[c.name] ?? 1500 }));
  return { coins: { put: [goal, ...budgets] }, ops: { put: ops } };
}

/** Зміни для save(), що прибирають усе демо: операції й монети з позначкою demo. */
export function demoRemoval(state) {
  const ops = state.ops.filter((o) => o.demo).map((o) => o.id);
  const coins = state.coins.filter((c) => c.demo).map((c) => c.id);
  if (!ops.length && !coins.length) return null;
  return { ops: { del: ops }, coins: { del: coins } };
}

export const hasDemo = (state) => state.ops.some((o) => o.demo) || state.coins.some((c) => c.demo);
