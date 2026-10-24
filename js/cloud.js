// Обмін записами з базою бота Хобі-плану (Cloudflare D1, POST /api/records) — тим самим ключем, що й бот.
// Дані живуть у телефоні: без мережі все працює, змінене копиться й поїде, щойно з'явиться зв'язок.
// Новіший updated перемагає; видалене — запис deleted. Файл однаковий у marnotrat і weight-log — правити разом.

// За раз — не більше: перший обмін (уся історія) іде частинами
const CHUNK = 400;
const CHUNK_BYTES = 700_000;

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function set(k, v) {
  try {
    if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, String(v));
  } catch { /* приватний режим */ }
}

/**
 * Позначки обміну застосунку: since — час бота (що вже забрали), pushed — свій час (що вже віддали), last — коли;
 * owner — чий це бот: інша адреса — інша база, обмін з нуля (новий ключ до тієї ж адреси — та сама база).
 */
export function cursors(prefix) {
  return {
    since: () => Number(get(`${prefix}:cloud-since`) || 0),
    pushed: () => Number(get(`${prefix}:cloud-pushed`) || 0),
    last: () => Number(get(`${prefix}:cloud-last`) || 0),
    reset: () => { for (const k of ['since', 'pushed', 'last']) set(`${prefix}:cloud-${k}`, null); },
    // Записи зі старими мітками (злиття з файлу чи Диска) — наступний обмін віддасть усе своє ще раз
    rewind: () => set(`${prefix}:cloud-pushed`, null),
    own(url) {
      if (get(`${prefix}:cloud-owner`) === url) return;
      this.reset();
      set(`${prefix}:cloud-owner`, url);
    },
    commit: (since, pushed) => {
      set(`${prefix}:cloud-since`, since);
      set(`${prefix}:cloud-pushed`, pushed);
      set(`${prefix}:cloud-last`, Date.now());
    },
  };
}

function chunks(list) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const r of list) {
    const size = JSON.stringify(r).length;
    if (cur.length && (cur.length >= CHUNK || bytes + size > CHUNK_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(r);
    bytes += size;
  }
  if (cur.length || !out.length) out.push(cur);
  return out;
}

/**
 * Один обмін. records — усі свої записи [{ store, id, data, updated, deleted }] (віддаються лише новіші за pushed);
 * skipPush — нічого свого не віддавати (новий телефон: спершу взяти з бази). extra — додаткові поля запиту.
 * Повертає { rows, commit }: rows — змінене в боті; commit() — після того, як rows застосовано (не застосували —
 * наступний обмін забере їх ще раз). commit(false) — своє ще не в боті: наступний обмін віддасть усе;
 * commit(true) після skipPush — своє замінено взятим з бази, віддавати нічого.
 * Помилка: 'key' — ключ не підходить, інакше — мережа чи бот.
 */
export async function exchange({ url, key, app, prefix, records, skipPush = false, extra = {} }) {
  const cur = cursors(prefix);
  cur.own(url);
  // Позначку беремо ДО знімка: запис, змінений під час обміну, поїде наступного разу
  const startedAt = Date.now();
  const pushed = cur.pushed();
  const out = skipPush ? [] : records.filter((r) => (r.updated || 0) > pushed);
  const parts = chunks(out);
  let res = null;
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const r = await fetch(`${url}/api/records`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ app, since: cur.since(), put: parts[i], pull: last, ...extra }),
    });
    if (!r.ok) throw Object.assign(new Error(r.status === 401 ? 'key' : `HTTP ${r.status}`), { status: r.status });
    res = await r.json();
  }
  return { rows: res.rows ?? [], commit: (synced = !skipPush) => cur.commit(res.now, synced ? startedAt : 0) };
}
