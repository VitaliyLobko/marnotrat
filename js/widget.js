// Віджет на головному екрані Android (окремий застосунок marnotrat-widget) бере шапку з сервера синхронізації:
// сервер рахує її сам із записів Марнотрату (/api/records), тож звідси йдуть лише адреса й ключ — при встановленні.
import * as Bot from './bot.js';

/** Посилання з Налаштувань: є застосунок — передати адресу й ключ, немає — Chrome качає APK. */
export const APK_URL = 'https://github.com/VitaliyLobko/marnotrat-widget/releases/latest/download/marnotrat-widget.apk';
const PACKAGE = 'ua.vitaliylobko.marnotrat.widget';

export function setupLink() {
  const cfg = Bot.botConfig();
  if (!cfg) return null;
  const q = new URLSearchParams({ url: cfg.url, key: cfg.key });
  return `intent://setup?${q}#Intent;scheme=marnotrat-widget;package=${PACKAGE};S.browser_fallback_url=${encodeURIComponent(APK_URL)};end`;
}
