// IndexedDB: одна база, по сховищу на сутність, ключ — поле id.
// Ім'я бази з префіксом застосунку: на vitaliylobko.github.io поруч живуть shooting-log, weight-log, hobby-planner.
const DB_NAME = 'marnotrat';
const DB_VERSION = 2;
// coins — монети (доходи, рахунки, витрати); ops — операції; meta — курси й інше дрібне
export const STORES = ['coins', 'ops', 'meta'];
// files — фото чеків: лише на цьому телефоні, у стан, синхронізацію й резервну копію не йдуть
const FILES = 'files';

let opening;

function open() {
  // Невдале відкриття не запам'ятовуємо: наступний запит відкриє заново
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [...STORES, FILES]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      // Нову версію бази відкрили в іншій вкладці — віддаємо з'єднання, інакше там оновлення зависне
      req.result.onversionchange = () => { req.result.close(); location.reload(); };
      resolve(req.result);
    };
    req.onerror = () => { opening = null; reject(req.error); };
    req.onblocked = () => { opening = null; reject(new Error('База зайнята іншою вкладкою — закрий її')); };
  });
  return opening;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    fn(tx);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Запис скасовано'));
  });
}

export function uid() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadAll() {
  const state = {};
  await run(STORES, 'readonly', (tx) => {
    for (const name of STORES) {
      const req = tx.objectStore(name).getAll();
      req.onsuccess = () => { state[name] = req.result; };
    }
  });
  return state;
}

/**
 * changes: { store: { put: [obj], del: [id] } } — усе однією транзакцією, з міткою часу updated.
 * Мітка — не менша за наявну + 1 (а в надгробка — за мітку видаленого запису): годинник іншого телефона
 * може бути попереду, а правка тут мусить бути новішою за те, що правили. Спершу читаємо, потім пишемо.
 */
export async function write(changes) {
  const now = Date.now();
  const names = Object.keys(changes);
  await run(names, 'readwrite', (tx) => {
    const jobs = [];
    for (const [name, { put = [] }] of Object.entries(changes)) {
      for (const obj of put) {
        const reads = [[name, obj.id]];
        if (name === 'meta' && obj.id.startsWith('del:') && names.includes(obj.store)) reads.push([obj.store, obj.ref]);
        jobs.push({ name, obj, reads, olds: [] });
      }
    }
    const flush = () => {
      for (const { name, obj, olds } of jobs) {
        obj.updated = Math.max(now, ...olds.map((o) => (Number(o?.updated) || 0) + 1));
        tx.objectStore(name).put(obj);
      }
      for (const [name, { del = [] }] of Object.entries(changes)) for (const id of del) tx.objectStore(name).delete(id);
    };
    let pending = 0;
    for (const job of jobs) {
      for (const [name, id] of job.reads) {
        pending += 1;
        tx.objectStore(name).get(id).onsuccess = (e) => {
          job.olds.push(e.target.result);
          pending -= 1;
          if (!pending) flush();
        };
      }
    }
    if (!pending) flush();
  });
  return now;
}

/** Фото: { id, blob, created }. */
export const putFile = (rec) => run([FILES], 'readwrite', (tx) => { tx.objectStore(FILES).put(rec); });

export async function getFile(id) {
  let out = null;
  await run([FILES], 'readonly', (tx) => {
    const req = tx.objectStore(FILES).get(id);
    req.onsuccess = () => { out = req.result ?? null; };
  });
  return out;
}

/** Прибрати фото, на які не посилається жодна операція (видалені, скасовані, замінені). */
export async function dropFilesExcept(keep) {
  await run([FILES], 'readwrite', (tx) => {
    const req = tx.objectStore(FILES).getAllKeys();
    req.onsuccess = () => { for (const id of req.result) if (!keep.has(id)) tx.objectStore(FILES).delete(id); };
  });
}

/** Повна заміна вмісту з резервної копії. */
export async function replaceAll(data) {
  return run(STORES, 'readwrite', (tx) => {
    for (const name of STORES) {
      const store = tx.objectStore(name);
      store.clear();
      for (const obj of data[name] ?? []) store.put(obj);
    }
  });
}
