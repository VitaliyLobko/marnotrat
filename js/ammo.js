// Патрони на склад Стрілецького журналу: той самий сайт (vitaliylobko.github.io), тому його база доступна напряму.
// Покупка — рух kind 'buy' у сховищі movements, як записує сам журнал; на Google Диск піде з його синхронізацією.
const SL = 'shooting-log';

/** Чи є на цьому телефоні Стрілецький журнал: базу не створюємо, якщо її немає. */
export async function slAvailable() {
  try {
    return (await indexedDB.databases()).some((d) => d.name === SL);
  } catch {
    return false;
  }
}

/** Відкрити чужу базу без версії й закрити одразу після запиту — щоб не заважати її оновленню. */
function withSL(stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SL);
    // Бази немає — не створюємо порожню замість журналу
    req.onupgradeneeded = () => req.transaction.abort();
    req.onerror = () => reject(req.error ?? new Error('Стрілецький журнал не знайдено'));
    req.onsuccess = () => {
      const db = req.result;
      if (!stores.every((s) => db.objectStoreNames.contains(s))) { db.close(); reject(new Error('Стрілецький журнал не знайдено')); return; }
      const tx = db.transaction(stores, mode);
      let out;
      fn(tx, (v) => { out = v; });
      tx.oncomplete = () => { db.close(); resolve(out); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error('Запис скасовано')); };
    };
  });
}

/** Патрони журналу (без архівних) із залишком: сума qty рухів. */
export function cartridges() {
  return withSL(['cartridges', 'movements'], 'readonly', (tx, done) => {
    const cr = tx.objectStore('cartridges').getAll();
    const mv = tx.objectStore('movements').getAll();
    // Запити однієї транзакції виконуються по черзі: коли готові рухи, патрони вже прочитані
    mv.onsuccess = () => {
      const stock = new Map();
      for (const m of mv.result) if (m.cartridgeId) stock.set(m.cartridgeId, (stock.get(m.cartridgeId) ?? 0) + (Number(m.qty) || 0));
      done(cr.result.filter((c) => !c.archived).map((c) => ({ ...c, stock: stock.get(c.id) ?? 0 })));
    };
  });
}

/** Записати покупку: price — уся сума в гривнях, як у журналі. */
export function addBuy(mv) {
  const now = Date.now();
  return withSL(['movements'], 'readwrite', (tx) => {
    tx.objectStore('movements').put({ ...mv, kind: 'buy', created: now, updated: now });
  });
}

/** Скасувати покупку: з надгробком, як видаляє сам журнал, — інакше синхронізація повернула б її. */
export function removeBuy(id) {
  return withSL(['movements', 'tombstones'], 'readwrite', (tx) => {
    tx.objectStore('tombstones').put({ id, store: 'movements', updated: Date.now() });
    tx.objectStore('movements').delete(id);
  });
}
