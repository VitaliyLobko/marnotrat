// Дрібні будівельні блоки інтерфейсу: елементи, іконки, тост, шторка, перемикачі, свайп.
import { ICONS } from './icons.js';
import { LUCIDE } from './icons-lucide.js';

export const $ = (id) => document.getElementById(id);

/** h('div', { class: 'x', onClick: fn, style: { '--c': 'red' } }, ...діти) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    } else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/** Іконка з власного набору чи Lucide: розмітка SVG своя, не з даних, тому innerHTML тут безпечний. */
export function icon(name, cls = 'ico') {
  const span = h('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name] ?? LUCIDE[name] ?? ''}</svg>`;
  return span;
}

export const hasIcon = (name) => Boolean(ICONS[name] ?? LUCIDE[name]);

/** Відгук пальцю; pattern — [вібрація, пауза, …]. */
export function vibrate(pattern = 25) {
  try { navigator.vibrate?.(pattern); } catch { /* не підтримується */ }
}

let toastTimer;
/** Тост унизу; action — { label, run } для кнопки «Скасувати». */
export function toast(text, action) {
  const box = $('toast');
  box.replaceChildren(h('span', {}, text));
  if (action) {
    box.append(h('button', { type: 'button', onClick: () => { box.hidden = true; action.run(); } }, action.label));
  }
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 5000 : 2500);
}

// Шторка має запис в історії: системна «Назад» на Android закриває її, а не йде з екрана.
let openSheet = null;

window.addEventListener('popstate', () => {
  if (openSheet) openSheet.close(true);
});

/**
 * Шторка поверх екрана. bare — без смужки й заголовка (екран суми, меню); cls — вигляд: 'screen' на весь екран,
 * 'drawer' — меню зліва. Повертає close().
 */
export function sheet(title, content, { onClose, cls = '', bare = false } = {}) {
  // Шторка міняє шторку (тип монети «Витрата» → «Ціль»): запис в історії той самий. Інакше history.back
  // від старої прийшов би вже після відкриття нової й закрив би її — форма зникала без сліду
  const replacing = Boolean(openSheet);
  openSheet?.close(true);
  const layer = $('layer');
  const close = (fromHistory = false) => {
    if (openSheet !== api) return;
    openSheet = null;
    layer.replaceChildren();
    document.body.classList.remove('layer-open');
    if (!fromHistory && history.state?.sheet) history.back();
    onClose?.();
  };
  const api = { close };
  const panel = h('div', { class: `sheet ${cls}`.trim(), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    bare ? null : h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    bare ? null : h('h2', { class: 'sheet-title' }, title),
    content);
  const backdrop = h('div', { class: `backdrop ${cls ? `${cls}-backdrop` : ''}`.trim(), onClick: () => close() });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  layer.replaceChildren(backdrop, panel);
  document.body.classList.add('layer-open');
  openSheet = api;
  if (!replacing || !history.state?.sheet) history.pushState({ sheet: true }, '');
  // Фокус на саму шторку, не на поле: інакше на телефоні одразу вискакує клавіатура
  panel.focus({ preventScroll: true });
  return close;
}

export function closeSheet() {
  openSheet?.close();
}

export const sheetOpen = () => Boolean(openSheet);

/** Рядок перемикачів: items — [[значення, підпис]]. */
export function chips(items, value, onChange) {
  const row = h('div', { class: 'chips', role: 'group' });
  let current = value;
  const paint = () => {
    for (const b of row.children) {
      const on = b.dataset.v === current;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  for (const [v, label] of items) {
    row.append(h('button', {
      type: 'button', class: 'chip', 'data-v': v,
      onClick: () => { current = v; onChange(v); paint(); },
    }, label));
  }
  paint();
  return row;
}

/** Горизонтальний свайп по елементу — крок вперед (1) чи назад (-1). step повертає true, якщо крок зроблено. */
export function swipeStep(el, step) {
  // Вертикально гортає браузер, горизонтальний рух — наш
  el.style.touchAction = 'pan-y';
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('input, textarea, select')) return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId, axis: null };
  });
  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id || start.axis) return;
    const mx = e.clientX - start.x;
    const my = e.clientY - start.y;
    if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
    start.axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
  });
  const finish = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const { x, axis } = start;
    start = null;
    const dx = e.clientX - x;
    if (e.type !== 'pointerup' || axis !== 'x' || Math.abs(dx) < 40) return;
    if (step(dx < 0 ? 1 : -1)) vibrate();
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  return el;
}
