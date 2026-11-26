// Every visible string of the interface goes through t(). Two dictionaries,
// the same keys in both. The language follows the project's setting, then a
// choice made on this machine, then the browser.

import en from '/js/i18n/en.js';
import es from '/js/i18n/es.js';

const DICTS = { en, es };
export const LANGUAGES = ['en', 'es'];
const STORE_KEY = 'studio.lang';

let current = 'en';
const listeners = new Set();

function browserLanguage() {
  const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  for (const tag of list) {
    const short = String(tag).slice(0, 2).toLowerCase();
    if (LANGUAGES.includes(short)) return short;
  }
  return 'en';
}

/** The language to use when no project says otherwise. */
export function localLanguage() {
  let stored = null;
  try { stored = localStorage.getItem(STORE_KEY); } catch (err) { /* storage is off */ }
  return LANGUAGES.includes(stored) ? stored : browserLanguage();
}

export function rememberLanguage(lang) {
  try { localStorage.setItem(STORE_KEY, lang); } catch (err) { /* storage is off */ }
}

export function getLang() {
  return current;
}

export function setLang(lang) {
  const next = LANGUAGES.includes(lang) ? lang : 'en';
  if (next === current) return false;
  current = next;
  document.documentElement.lang = next;
  for (const fn of listeners) fn(next);
  return true;
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function fill(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined || params[name] === null ? '' : String(params[name])));
}

export function has(key) {
  return Object.prototype.hasOwnProperty.call(DICTS[current], key) || Object.prototype.hasOwnProperty.call(DICTS.en, key);
}

/** Looks a key up and fills {name} from params. A missing key shows itself. */
export function t(key, params) {
  const text = DICTS[current][key] !== undefined ? DICTS[current][key] : DICTS.en[key];
  return text === undefined ? key : fill(text, params);
}

/** Plural: looks up key.one or key.other by n, with {n} filled in. */
export function tn(key, n, params) {
  return t(`${key}.${Number(n) === 1 ? 'one' : 'other'}`, Object.assign({ n }, params));
}

/**
 * A string whose key is built from a value the server sent (a status, an
 * error code). Falls back to the given text, else to the value in words.
 */
export function tv(prefix, value, fallback, params) {
  const key = `${prefix}.${value}`;
  if (has(key)) return t(key, params);
  if (fallback !== undefined && fallback !== null) return fallback;
  return String(value === null || value === undefined ? '' : value).replace(/[_-]+/g, ' ');
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat(current, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat(current, { dateStyle: 'medium' }).format(date);
}

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat(current, { timeStyle: 'medium' }).format(date);
}

/** 75 -> "1 min 15 s". */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t('time.seconds', { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('time.minutes', { m, s: s % 60 });
  return t('time.hours', { h: Math.floor(m / 60), m: m % 60 });
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
