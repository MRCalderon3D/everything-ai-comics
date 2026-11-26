'use strict';
/**
 * The server's own text, in the languages the interface has.
 *
 * Code never builds a sentence for the person. It builds a message
 * descriptor, msg('step.pages.plan.gates', { n: 2 }), and the descriptor is
 * turned into text when a response or an event is sent, in the language of
 * the request. Descriptors are what jobs and history entries store, so the
 * same job reads in Spanish to one person and in English to another, and
 * still reads right after the interface language of a project changes.
 *
 * In a response every text field that came from a descriptor has two
 * siblings: `<field>_code` (the dictionary key, stable) and `<field>_params`
 * (the values that went into the sentence), so a client can write its own
 * wording.
 *
 * The dictionaries are in ./i18n-text.js: one object per language, the same
 * keys in both, the same {placeholders} in each pair.
 */

const DICT = require('./i18n-text');

const LANGS = Object.keys(DICT);
const DEFAULT_LANG = 'en';

/** A message descriptor. Params may hold other descriptors. */
function msg(code, params) {
  return { $t: String(code), params: params || {} };
}

function isMsg(value) {
  return !!value && typeof value === 'object' && typeof value.$t === 'string' && !Array.isArray(value);
}

function has(code) {
  return DICT[DEFAULT_LANG][code] !== undefined ||
    (DICT[DEFAULT_LANG][`${code}.one`] !== undefined && DICT[DEFAULT_LANG][`${code}.many`] !== undefined);
}

/** "es-ES" -> "es"; null for a language the server has no text in. */
function normalize(lang) {
  const code = String(lang || '').trim().toLowerCase().slice(0, 2);
  return LANGS.includes(code) ? code : null;
}

function paramText(lang, value) {
  if (value === undefined || value === null) return '';
  if (isMsg(value)) return t(lang, value.$t, value.params);
  if (Array.isArray(value)) return value.map((v) => paramText(lang, v)).join(', ');
  return String(value);
}

/**
 * The text of a key in a language. A key with `.one` and `.many` variants
 * picks one by params.n. A language without the key falls back to English;
 * a key nobody has comes back as params.detail, or as the key itself.
 */
function t(lang, code, params = {}) {
  const dict = DICT[normalize(lang) || DEFAULT_LANG];
  const find = (d) => {
    if (d[code] !== undefined) return d[code];
    const variant = `${code}.${Number(params.n) === 1 ? 'one' : 'many'}`;
    return d[variant];
  };
  let template = find(dict);
  if (template === undefined) template = find(DICT[DEFAULT_LANG]);
  if (template === undefined) return params.detail !== undefined ? paramText(lang, params.detail) : String(code);
  return template.replace(/\{([a-z_]+)\}/g, (m, name) => paramText(lang, params[name]));
}

/** Text of a value that may be a descriptor or already a string. */
function render(lang, value) {
  return isMsg(value) ? t(lang, value.$t, value.params) : value;
}

/** Params with nested descriptors turned into text. */
function plainParams(lang, params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (isMsg(value)) out[key] = t(lang, value.$t, value.params);
    else if (Array.isArray(value)) out[key] = value.map((v) => (isMsg(v) ? t(lang, v.$t, v.params) : v));
    else out[key] = value;
  }
  return out;
}

/**
 * A deep copy of a value with every descriptor turned into text. A property
 * `x` that held a descriptor comes out as `x` (the text), `x_code` and
 * `x_params`. A descriptor inside a list becomes its text.
 */
function localize(lang, value) {
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return value;
  if (isMsg(value)) return t(lang, value.$t, value.params);
  if (Array.isArray(value)) return value.map((v) => localize(lang, v));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (isMsg(v)) {
      out[key] = t(lang, v.$t, v.params);
      out[`${key}_code`] = v.$t;
      out[`${key}_params`] = plainParams(lang, v.params);
    } else {
      out[key] = localize(lang, v);
    }
  }
  return out;
}

/** The first language of an Accept-Language header the server has text in. */
function fromAcceptLanguage(header) {
  const parts = String(header || '').split(',')
    .map((part) => {
      const [tag, ...rest] = part.trim().split(';');
      const q = rest.map((r) => /^\s*q=([\d.]+)/.exec(r)).find(Boolean);
      return { tag, q: q ? Number(q[1]) : 1 };
    })
    .filter((p) => p.tag)
    .sort((a, b) => b.q - a.q);
  for (const part of parts) {
    const lang = normalize(part.tag);
    if (lang) return lang;
  }
  return null;
}

/**
 * The language of a request: an explicit ?lang= wins, then the interface
 * language of the project the route is about, then Accept-Language, then
 * English.
 */
function pickLang({ query, projectLanguage, acceptLanguage }) {
  return normalize(query) || normalize(projectLanguage) || fromAcceptLanguage(acceptLanguage) || DEFAULT_LANG;
}

/** The dictionary key of an error code: its own entry, or the catch-all. */
function errorKey(code) {
  return has(`error.${code}`) ? `error.${code}` : 'error.other';
}

/**
 * The descriptor of an error: `detail` is the technical text (a scaffold
 * script's own message, what a CLI said), which a template may quote.
 */
function errorMsg(code, detail, params) {
  const all = Object.assign({ detail: detail === undefined || detail === null ? '' : String(detail) }, params || {});
  let key = errorKey(code);
  // A sentence that would come out with a hole in it gives way to the detail.
  if (!complete(key, all)) key = 'error.other';
  return msg(key, all);
}

/** True when params has a value for every placeholder of a key, in every form of it. */
function complete(code, params) {
  const dict = DICT[DEFAULT_LANG];
  const templates = [dict[code], dict[`${code}.one`], dict[`${code}.many`]].filter((text) => text !== undefined);
  return templates.every((text) => (text.match(/\{([a-z_]+)\}/g) || []).every((p) => {
    const value = params[p.slice(1, -1)];
    return value !== undefined && value !== null && value !== '';
  }));
}

module.exports = {
  LANGS, DEFAULT_LANG, DICT,
  msg, isMsg, has, t, render, localize, plainParams, normalize, fromAcceptLanguage, pickLang, errorKey, errorMsg,
};
