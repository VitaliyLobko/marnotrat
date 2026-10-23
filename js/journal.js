// Стрілецький журнал: той самий сайт (vitaliylobko.github.io), тому його база доступна напряму.
// Записи — у форматі самого журналу; на Google Диск підуть з його синхронізацією.
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

/** Патрони (з залишком — сума qty рухів) і стволи журналу, без архівних. */
export function readJournal() {
  return withSL(['cartridges', 'movements', 'weapons'], 'readonly', (tx, done) => {
    const cr = tx.objectStore('cartridges').getAll();
    const wp = tx.objectStore('weapons').getAll();
    const mv = tx.objectStore('movements').getAll();
    // Запити однієї транзакції виконуються по черзі: коли готові рухи, решта вже прочитана
    mv.onsuccess = () => {
      const stock = new Map();
      for (const m of mv.result) if (m.cartridgeId) stock.set(m.cartridgeId, (stock.get(m.cartridgeId) ?? 0) + (Number(m.qty) || 0));
      done({
        cartridges: cr.result.filter((c) => !c.archived).map((c) => ({ ...c, stock: stock.get(c.id) ?? 0 })),
        weapons: wp.result.filter((w) => !w.archived),
      });
    };
  });
}

/** Новіша мітка, ніж у запису, навіть коли годинник іншого телефона поспішав — як робить сам журнал. */
const stamp = (old) => Math.max(Date.now(), (old?.updated ?? 0) + 1);

/** Записати новий запис у сховище журналу (рух, екіпірування). */
export function addRecord(store, rec) {
  return withSL([store], 'readwrite', (tx) => {
    tx.objectStore(store).put({ created: Date.now(), ...rec, updated: Date.now() });
  });
}

/** Змінити запис журналу: fn отримує поточний і повертає новий. Запису вже немає — нічого не робить. */
export function patchRecord(store, id, fn) {
  return withSL([store], 'readwrite', (tx, done) => {
    const os = tx.objectStore(store);
    os.get(id).onsuccess = (e) => {
      const old = e.target.result;
      if (!old) { done(false); return; }
      os.put({ ...fn(old), updated: stamp(old) });
      done(true);
    };
  });
}

/** Видалити запис — з надгробком, як видаляє сам журнал, інакше синхронізація повернула б його. */
export function removeRecord(store, id) {
  return withSL([store, 'tombstones'], 'readwrite', (tx) => {
    tx.objectStore('tombstones').put({ id, store, updated: Date.now() });
    tx.objectStore(store).delete(id);
  });
}
