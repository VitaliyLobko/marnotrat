// CSV для таблиць: запис стрічки у файл і читання операцій з файлу (свого чи з іншого обліку).

// Крапка з комою й десяткова кома — так Excel з українськими налаштуваннями відкриває файл одразу по колонках
const SEP = ';';

const quote = (v) => {
  const s = String(v ?? '');
  return /[;"\n\r,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Таблиця → текст CSV з BOM (інакше Excel читає кирилицю як каракулі). */
export function toCsv(rows) {
  return `﻿${rows.map((r) => r.map(quote).join(SEP)).join('\r\n')}\r\n`;
}

/** Сума для таблиці: десяткова кома, без пробілів між тисячами — щоб Excel бачив число. */
export const csvAmount = (v) => (v == null ? '' : String(Math.round(v * 100) / 100).replace('.', ','));

/** Текст CSV → рядки з комірками. Роздільник — ; , чи табуляція, за першим рядком; лапки з "" всередині. */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const head = src.slice(0, src.search(/\r?\n|$/));
  const sep = [';', '\t', ','].map((s) => [s, head.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** Дата з таблиці → «РРРР-ММ-ДД»: 2026-10-25, 25.10.2026, 25/10/2026, 25.10.26; час після дати відкидається. */
export function parseDate(s) {
  const t = String(s ?? '').trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymdOk(m[1], m[2], m[3]);
  m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) return ymdOk(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);
  return null;
}

function ymdOk(y, mo, d) {
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Сума з таблиці: «1 234,50», «1,234.50», «-350 грн» → 1234.5 / 350 (знак відкидаємо: напрям — у колонках). */
export function parseAmount(s) {
  let t = String(s ?? '').replace(/[\s  ]/g, '').replace(/[^\d.,-]/g, '').replace(/^-/, '');
  if (t.includes(',') && t.includes('.')) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (t.includes(',')) t = t.split(',').length > 2 ? t.replace(/,/g, '') : t.replace(',', '.');
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
}

/** Валюта з таблиці → UAH / USD / EUR; незнайома — null. */
export function parseCurrency(s) {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return null;
  if (['uah', 'грн', '₴', 'гривня'].some((x) => t.startsWith(x))) return 'UAH';
  if (['usd', '$', 'дол'].some((x) => t.startsWith(x))) return 'USD';
  if (['eur', '€', 'євро'].some((x) => t.startsWith(x))) return 'EUR';
  return null;
}

// Назви колонок, за якими впізнаємо, що де; порівнюються без регістру й зайвих пробілів
const COLUMNS = {
  date: ['дата', 'date'],
  type: ['тип', 'type'],
  from: ['звідки', 'з', 'from', 'рахунок'],
  to: ['куди', 'в', 'to', 'категорія'],
  amount: ['сума', 'amount'],
  currency: ['валюта', 'currency'],
  amountTo: ['сума в отримувача', 'сума отримувача'],
  currencyTo: ['валюта отримувача'],
  tags: ['теги', 'тег', 'мітки', 'tags'],
  comment: ['коментар', 'примітка', 'comment', 'опис'],
};

/** Рядок заголовків → { поле: номер колонки }; поля, якого нема, — нема. Друга «Сума»/«Валюта» — отримувача. */
export function mapHeader(head) {
  const norm = head.map((x) => x.trim().toLowerCase().replace(/\s+/g, ' '));
  const at = {};
  norm.forEach((name, i) => {
    for (const [key, names] of Object.entries(COLUMNS)) {
      if (!names.includes(name)) continue;
      if (!(key in at)) at[key] = i;
      else if (key === 'amount' && !('amountTo' in at)) at.amountTo = i;
      else if (key === 'currency' && !('currencyTo' in at)) at.currencyTo = i;
      break;
    }
  });
  return at;
}
