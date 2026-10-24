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

/** Відкритий журнал (інша вкладка) — нехай перечитає базу й синхронізується: сам він про наш запис не знає. */
function notify() {
  try {
    const ch = new BroadcastChannel(SL);
    ch.postMessage({ type: 'external-change' });
    ch.close();
  } catch { /* старий браузер — журнал побачить запис при наступному відкритті */ }
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
      tx.oncomplete = () => {
        db.close();
        if (mode === 'readwrite') notify();
        resolve(out);
      };
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

/** Видалити запис — з надгробком, як видаляє сам журнал, інакше синхронізація повернула б його. Повертає видалений запис. */
export function removeRecord(store, id) {
  return withSL([store, 'tombstones'], 'readwrite', (tx, done) => {
    const os = tx.objectStore(store);
    os.get(id).onsuccess = (e) => {
      const old = e.target.result;
      tx.objectStore('tombstones').put({ id, store, updated: stamp(old) });
      os.delete(id);
      done(old ?? null);
    };
  });
}

/** Повернути видалений запис («Скасувати»): новіший за надгробок, щоб синхронізація його не прибрала. */
function restoreRecord(store, rec) {
  return withSL([store, 'tombstones'], 'readwrite', (tx) => {
    const tombs = tx.objectStore('tombstones');
    tombs.get(rec.id).onsuccess = (e) => {
      tx.objectStore(store).put({ ...rec, updated: stamp(e.target.result ?? rec) });
      tombs.delete(rec.id);
    };
  });
}

/**
 * Операцію видалили в Марнотраті — прибрати й те, що вона записала в журнал (sl з операції).
 * Повертає «Скасувати» (повернути як було) або null, якщо в журналі нічого не було.
 */
export async function unlinkJournal(sl) {
  if (!sl?.id || sl.skip || !(await slAvailable())) return null;
  if (sl.kind === 'ammo' || sl.kind === 'gear') {
    const store = sl.kind === 'ammo' ? 'movements' : 'gear';
    const old = await removeRecord(store, sl.id);
    return old ? () => restoreRecord(store, old) : null;
  }
  if (sl.kind === 'mod' && sl.gun) {
    let mod = null;
    await patchRecord('weapons', sl.gun, (w) => {
      mod = (w.mods ?? []).find((m) => m.id === sl.id) ?? null;
      return { ...w, mods: (w.mods ?? []).filter((m) => m.id !== sl.id) };
    });
    return mod ? () => patchRecord('weapons', sl.gun, (w) => ({ ...w, mods: [...(w.mods ?? []), mod] })) : null;
  }
  return null;
}
