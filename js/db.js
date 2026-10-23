// IndexedDB: одна база, по сховищу на сутність, ключ — поле id.
// Ім'я бази з префіксом застосунку: на vitaliylobko.github.io поруч живуть shooting-log, weight-log, hobby-planner.
const DB_NAME = 'marnotrat';
const DB_VERSION = 1;
// coins — монети (доходи, рахунки, витрати); ops — операції; meta — курси й інше дрібне
export const STORES = ['coins', 'ops', 'meta'];

let opening;

function open() {
  // Невдале відкриття не запам'ятовуємо: наступний запит відкриє заново
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
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

/** changes: { store: { put: [obj], del: [id] } } — усе однією транзакцією, з міткою часу updated. */
export async function write(changes) {
  const now = Date.now();
  await run(Object.keys(changes), 'readwrite', (tx) => {
    for (const [name, { put = [], del = [] }] of Object.entries(changes)) {
      const store = tx.objectStore(name);
      for (const obj of put) {
        obj.updated = now;
        store.put(obj);
      }
      for (const id of del) store.delete(id);
    }
  });
  return now;
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
