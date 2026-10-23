// Модель: дати, гроші, калькулятор, стартові монети. Без DOM — лише розрахунки.

// ---------- дати ----------

const pad2 = (n) => String(n).padStart(2, '0');

export function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const parseYmd = (s) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));

export function addDays(date, n) {
  const d = parseYmd(date);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** «2026-10» */
export const monthOf = (date) => date.slice(0, 7);

export function addMonths(ym, n) {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const WEEKDAYS = ['НД', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];

/** «жовтень 2026» */
export const monthTitle = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** «23 жовтня 2026» */
export const dateTitle = (date) => `${Number(date.slice(8, 10))} ${MONTHS_GEN[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;

/** Заголовок дня в стрічці, як у CoinKeeper: «СЬОГОДНІ, 23 жовтня», «ВЧОРА, …», «ПН, 12 жовтня»; інший рік — з роком. */
export function dayHead(date, today = ymd()) {
  const day = `${Number(date.slice(8, 10))} ${MONTHS_GEN[Number(date.slice(5, 7)) - 1]}`;
  const tail = date.slice(0, 4) === today.slice(0, 4) ? day : `${day} ${date.slice(0, 4)}`;
  if (date === today) return `СЬОГОДНІ, ${tail}`;
  if (date === addDays(today, -1)) return `ВЧОРА, ${tail}`;
  return `${WEEKDAYS[parseYmd(date).getDay()]}, ${tail}`;
}

// ---------- гроші ----------

export const CURRENCIES = [['UAH', '₴ грн'], ['USD', '$ долар'], ['EUR', '€ євро']];
const SIGN = { UAH: 'грн', USD: '$', EUR: '€' };

export const round2 = (v) => Math.round(v * 100) / 100;

/** «5 494 грн», «$ 120», «€ 12,50»: копійки — лише коли вони є. */
export function money(v, cur = 'UAH', { sign = '' } = {}) {
  const n = round2(Math.abs(v));
  const s = new Intl.NumberFormat('uk-UA', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2,
  }).format(n);
  const body = cur === 'UAH' ? `${s} грн` : `${SIGN[cur] ?? cur} ${s}`;
  return `${sign}${body}`;
}

/** Число без валюти: «9 000» */
export const num = (v) => new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(round2(v));

// ---------- калькулятор ----------

export const OPS = ['+', '−', '×', '÷'];

/**
 * Вираз з клавіатури суми: числа з комою, + − × ÷ і % після числа.
 * «200+10%» — це 220 (відсоток від уже набраного), «200×10%» — 20. Помилка (ділення на нуль) — NaN.
 */
export function calc(expr) {
  const toks = String(expr).match(/\d+,?\d*|,\d+|[+−×÷%]/g) ?? [];
  const items = [];
  for (const t of toks) {
    if (OPS.includes(t)) items.push(t);
    else if (t === '%') { const last = items.at(-1); if (typeof last === 'object') last.pct = true; }
    else items.push({ v: Number(t.replace(',', '.')) || 0, pct: false });
  }
  if (typeof items[0] !== 'object') return 0;
  let total = 0;
  let term = items[0].pct ? items[0].v / 100 : items[0].v;
  for (let i = 1; i + 1 < items.length; i += 2) {
    const op = items[i];
    const n = items[i + 1];
    if (typeof n !== 'object') break;
    if (op === '+' || op === '−') {
      const v = n.pct ? (total + term) * n.v / 100 : n.v;
      total += term;
      term = op === '+' ? v : -v;
    } else {
      const v = n.pct ? n.v / 100 : n.v;
      term = op === '×' ? term * v : term / v;
    }
  }
  const res = total + term;
  return Number.isFinite(res) ? round2(res) : NaN;
}

export const hasOp = (expr) => /[+−×÷%]/.test(expr);

/** Число → рядок для клавіатури: «42000», «12,5». */
export const toExpr = (v) => (v ? String(round2(v)).replace('.', ',') : '');

// ---------- монети ----------

export const KINDS = { income: 'Дохід', account: 'Рахунок', expense: 'Витрата', goal: 'Ціль' };

/** Стан витрати за бюджетом: колір монети й частка заливки (0–1). */
export function budgetState(spent, budget) {
  if (!spent) return { st: 'zero', fill: 0 };
  // Без бюджету монета не заливається: «повна зелена» читалась би як «усе в нормі на 100 %»
  if (!budget) return { st: 'free', fill: 0 };
  const share = spent / budget;
  if (share > 1) return { st: 'over', fill: 1 };
  return { st: share >= WARN_SHARE ? 'warn' : 'ok', fill: share };
}

// Поріг «близько до ліміту» — помаранчевий
export const WARN_SHARE = 0.8;

// Іконки монет групами, як у Хобі-плані. Ключ, якого немає у власному наборі (icons.js), береться з Lucide
// (icons-lucide.js; після правки списку — перезібрати: scripts/make_lucide.py).
// Ключ зберігається в монеті — уже наявні ключі не перейменовувати й не прибирати.
export const ICON_GROUPS = [
  { title: 'Гроші й рахунки', icons: [
    ['wallet', 'Гаманець'], ['card', 'Картка'], ['credit-card', 'Кредитка'], ['banknote', 'Готівка'],
    ['coins', 'Монети'], ['piggy-bank', 'Скарбничка'], ['landmark', 'Банк'], ['vault', 'Сейф'],
    ['hand-coins', 'Позика'], ['handshake', 'Борг'], ['badge-percent', 'Відсотки'], ['percent', 'Знижка'],
    ['trending-up', 'Інвестиції'], ['chart', 'Акції'], ['bitcoin', 'Крипта'], ['dollar-sign', 'Долари'],
    ['euro', 'Євро'], ['receipt', 'Чек'], ['calc', 'Рахунки'], ['scale', 'Податки'],
    ['briefcase', 'Робота'], ['laptop', 'Фриланс'], ['gift', 'Подарунок'], ['trophy', 'Премія'],
    ['award', 'Бонус'], ['ticket-percent', 'Кешбек'], ['arrow-left-right', 'Переказ'], ['repeat', 'Підписка'],
  ] },
  { title: 'Продукти й їжа', icons: [
    ['shopping-cart', 'Візок'], ['shopping-basket', 'Кошик'], ['store', 'Магазин'], ['apple', 'Фрукти'],
    ['carrot', 'Овочі'], ['beef', "М'ясо"], ['ham', 'Ковбаса'], ['fish', 'Риба'],
    ['egg', 'Яйця'], ['milk', 'Молоко'], ['wheat', 'Хліб'], ['croissant', 'Випічка'],
    ['candy', 'Солодке'], ['cookie', 'Печиво'], ['cake', 'Торт'], ['ice-cream-cone', 'Морозиво'],
    ['utensils', 'Ресторан'], ['cook', 'Кухня'], ['chef-hat', 'Кулінарія'], ['soup', 'Суп'],
    ['salad', 'Салат'], ['pizza', 'Піца'], ['sandwich', 'Фастфуд'], ['coffee', 'Кава'],
    ['cup-soda', 'Напої'], ['wine', 'Вино'], ['beer', 'Пиво'], ['martini', 'Бар'],
  ] },
  { title: 'Дім і комуналка', icons: [
    ['house', 'Дім'], ['building', 'Квартира'], ['key', 'Оренда'], ['sofa', 'Меблі'],
    ['bed', 'Спальня'], ['lamp', 'Світло'], ['plug', 'Електрика'], ['zap', 'Енергія'],
    ['flame', 'Газ'], ['droplet', 'Вода'], ['thermometer', 'Опалення'], ['wifi', 'Інтернет'],
    ['phone', 'Телефон'], ['smartphone', 'Мобільний'], ['tv', 'ТБ'], ['router', 'Роутер'],
    ['washing-machine', 'Пральна'], ['refrigerator', 'Холодильник'], ['microwave', 'Техніка'], ['bath', 'Ванна'],
    ['spray-can', 'Побутова хімія'], ['trash-2', 'Вивіз сміття'], ['hammer', 'Ремонт'], ['wrench', 'Майстер'],
    ['tool', 'Інструменти'], ['drill', 'Дриль'], ['paint-roller', 'Фарба'], ['archive', 'Зберігання'],
    ['box', 'Посилки'], ['novaposhta', 'Нова пошта'], ['plant', 'Рослини'], ['sprout', 'Город'],
    ['flower', 'Квіти'], ['shovel', 'Дача'],
  ] },
  { title: 'Транспорт', icons: [
    ['car', 'Авто'], ['fuel', 'Пальне'], ['circle-parking', 'Паркування'], ['car-front', 'Мийка'],
    ['cog', 'СТО'], ['gauge', 'Техогляд'], ['shield-check', 'Страховка'], ['bus', 'Автобус'],
    ['tram-front', 'Трамвай'], ['train-front', 'Потяг'], ['car-taxi-front', 'Таксі'], ['bike', 'Велосипед'],
    ['plane', 'Літак'], ['ship', 'Пором'], ['truck', 'Доставка'],
    ['caravan', 'Автодім'], ['route', 'Дорога'],
  ] },
  { title: "Здоров'я й краса", icons: [
    ['heart', "Здоров'я"], ['heart-pulse', 'Кардіо'], ['pill', 'Ліки'], ['briefcase-medical', 'Аптечка'],
    ['stethoscope', 'Лікар'], ['hospital', 'Лікарня'], ['syringe', 'Щеплення'], ['smile-plus', 'Стоматолог'],
    ['eye', 'Окуліст'], ['glasses', 'Окуляри'], ['brain', 'Психолог'], ['dumbbell', 'Зал'],
    ['biceps-flexed', 'Тренування'], ['run', 'Біг'], ['swim', 'Басейн'], ['ball', 'Спорт'],
    ['scissors', 'Перукар'], ['sparkles', 'Косметика'], ['flower-2', 'Спа'], ['hand', 'Манікюр'],
  ] },
  { title: 'Одяг і покупки', icons: [
    ['shirt', 'Одяг'], ['footprints', 'Взуття'], ['shopping-bag', 'Шопінг'], ['gem', 'Прикраси'],
    ['watch', 'Годинник'], ['umbrella', 'Парасоля'], ['backpack', 'Рюкзак'],
    ['package', 'Замовлення'], ['tag', 'Розпродаж'], ['monitor', "Комп'ютер"], ['tablet', 'Планшет'],
    ['headphones', 'Навушники'], ['camera', 'Фото'], ['gamepad-2', 'Приставка'], ['printer', 'Принтер'],
  ] },
  { title: 'Дозвілля й хобі', icons: [
    ['film', 'Кіно'], ['popcorn', 'Попкорн'], ['tickets', 'Квитки'], ['drama', 'Театр'],
    ['music', 'Музика'], ['piano', 'Інструменти'], ['mic', 'Караоке'], ['game', 'Ігри'],
    ['dice', 'Настолки'], ['chess', 'Шахи'], ['puzzle', 'Пазли'], ['book', 'Книги'],
    ['book-open', 'Читання'], ['palette', 'Творчість'], ['brush', 'Малювання'], ['party-popper', 'Свята'],
    ['cake-slice', 'День народження'], ['target', 'Стрільба'], ['crosshair', 'Патрони'], ['binoculars', 'Оптика'],
    ['tent', 'Похід'], ['tent-tree', 'Табір'], ['fish-symbol', 'Риболовля'], ['mountain', 'Гори'],
    ['luggage', 'Відпустка'], ['map', 'Подорожі'], ['map-pin', 'Місця'], ['hotel', 'Готель'],
    ['tree-palm', 'Море'],
  ] },
  { title: 'Освіта й робота', icons: [
    ['graduation-cap', 'Навчання'], ['school', 'Школа'], ['notebook-pen', 'Канцелярія'], ['languages', 'Мови'],
    ['code', 'Курси'], ['globe', 'Сервіси'], ['cloud', 'Хмара'], ['server', 'Хостинг'],
    ['calendar', 'Події'], ['file-text', 'Документи'], ['stamp', 'Нотаріус'], ['gavel', 'Юрист'],
    ['printer-check', 'Друк'], ['mail', 'Пошта'],
  ] },
  { title: 'Люди й тварини', icons: [
    ['users', "Сім'я"], ['baby', 'Діти'], ['user', 'Я'], ['user-round', 'Вона'],
    ['smile', 'Друзі'], ['hand-heart', 'Допомога'], ['hand-helping', 'Волонтерство'], ['shield', 'ЗСУ'],
    ['church', 'Церква'], ['paw', 'Тварини'], ['cat', 'Кіт'], ['dog', 'Пес'],
    ['bird', 'Птахи'], ['bone', 'Корм'],
  ] },
  { title: 'Інше', icons: [
    ['star', 'Зірка'], ['heart-handshake', 'Подяка'], ['bell', 'Нагадування'], ['clock', 'Час'],
    ['flag', 'Прапор'], ['bookmark', 'Закладка'], ['circle-help', 'Невідоме'], ['cigarette', 'Цигарки'],
    ['skull', 'Шкідливе'], ['dices', 'Азарт'], ['ghost', 'Втрачене'], ['rocket', 'Мрія'],
  ] },
];

/**
 * Стартові монети при першому запуску — загальні, без особистого: свої категорії, людей і бюджети
 * людина задає сама (довге натискання на монету).
 */
export function seedCoins(uid) {
  let order = 0;
  const c = (kind, name, ico, extra = {}) => ({
    id: uid(), kind, name, icon: ico, currency: 'UAH', budget: 0, start: 0, order: order++, archived: false, ...extra,
  });
  return [
    c('income', 'Зарплата', 'banknote'),
    c('income', 'Інше', 'trophy'),
    c('account', 'Готівка', 'wallet'),
    c('account', 'Monobank', 'card'),
    c('account', 'Приват', 'card'),
    c('account', 'Долари', 'wallet', { currency: 'USD' }),
    c('expense', 'Продукти', 'shopping-basket'),
    c('expense', 'Їжа поза домом', 'utensils'),
    c('expense', "Здоров'я і спорт", 'briefcase-medical'),
    c('expense', 'Хобі й відпочинок', 'heart'),
    c('expense', 'Дім', 'house'),
    c('expense', 'Комуналка', 'calc'),
    c('expense', 'Одяг і взуття', 'shirt'),
    c('expense', 'Машина', 'car'),
    c('expense', 'Транспорт', 'bus'),
    c('expense', 'Різне', 'coins'),
  ];
}
