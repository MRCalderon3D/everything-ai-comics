'use strict';
/**
 * The screens of a project, as the chat and its links name them.
 *
 * A screen has a key (the chat keys of chats.js, such as `story` or
 * `page:PG_001_002`, plus a few screens that have no files of their own:
 * `home`, `check`, `corrections`, `history`, `settings`), a label for the
 * person, and the route of the browser app that shows it. The routes are
 * the ones studio/web/ uses today; they are listed in studio/docs/api.md.
 */

const S = require('./scaffold');
const chats = require('./chats');
const { msg } = require('./i18n');
const { HttpError } = require('./util');

const NAV_ONLY = ['home', 'check', 'corrections', 'history', 'settings'];

function number(id) {
  return parseInt(String(id).slice(-3), 10);
}

function nameOf(load, root, id) {
  try {
    const doc = load(root, id);
    return (doc && doc.name) || id;
  } catch (err) {
    return id;
  }
}

/** The route of the browser app for a screen key, or null. Pure. An issue after the first goes in ?issue=. */
function routeOf(projectId, key) {
  const base = `/p/${encodeURIComponent(projectId)}`;
  const [kind, id] = String(key).split(':');
  const issue = id && id !== 'ISS_001' && /^ISS_\d{3}$/.test(id) ? `?issue=${id}` : '';
  switch (kind) {
    case 'home': return base;
    case 'story': return `${base}/story`;
    case 'style': return `${base}/style`;
    case 'options':
    case 'settings': return `${base}/settings`;
    case 'characters': return `${base}/characters`;
    case 'character': return `${base}/characters/${id}`;
    case 'places': return `${base}/places`;
    case 'location': return `${base}/places/location/${id}`;
    case 'prop': return `${base}/places/prop/${id}`;
    case 'pages': return `${base}/pages${issue}`;
    case 'page': return `${base}/pages/${id}`;
    case 'cover': return `${base}/cover${issue}`;
    case 'publish': return `${base}/publish${issue}`;
    case 'check': return `${base}/check`;
    case 'corrections': return `${base}/corrections`;
    case 'history': return `${base}/history`;
    default: return null;
  }
}

/** The label of a screen key: a message descriptor. */
function labelOf(project, key) {
  const root = project.root;
  const [kind, id] = String(key).split(':');
  switch (kind) {
    case 'character': return msg('screen_label.character', { name: nameOf(S.ws.loadCharacter, root, id) });
    case 'location': return msg('screen_label.location', { name: nameOf(S.ws.loadLocation, root, id) });
    case 'prop': return msg('screen_label.prop', { name: nameOf(S.ws.loadProp, root, id) });
    case 'pages': return msg('screen_label.pages', { n: number(id) });
    case 'page': return msg('screen_label.page', { n: number(id) });
    case 'cover': return msg('screen_label.cover', { n: number(id) });
    case 'publish': return msg('screen_label.publish', { n: number(id) });
    default: return msg(`screen_label.${kind}`);
  }
}

/** True when the key names a screen that exists in the project. Never throws. */
function exists(project, key) {
  if (NAV_ONLY.includes(key)) return true;
  try {
    chats.contextOf(project, key);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * { key, label, route } of a screen of the project.
 * @throws 400 bad_chat_key / 404 chat_target_not_found like chats.contextOf
 */
function screenOf(project, key) {
  if (!NAV_ONLY.includes(key)) chats.contextOf(project, key);
  return { key, label: labelOf(project, key), route: routeOf(project.id, key) };
}

/**
 * The screen a chat message says it was sent from, checked. `given` is
 * { key, label?, route? } from the browser, or a bare key. The key must name
 * a screen with files (a chat key); label and route are the browser's when
 * it sends them, else the server's.
 */
function checkScreen(project, given) {
  const value = typeof given === 'string' ? { key: given } : (given && typeof given === 'object' ? given : null);
  if (!value || typeof value.key !== 'string') {
    throw new HttpError(400, 'bad_params', '"screen" must be { "key": "<screen key>", "label": "...", "route": "..." }.');
  }
  const base = screenOf(project, value.key);
  if (NAV_ONLY.includes(value.key)) {
    throw new HttpError(400, 'bad_chat_key', `"${value.key}" has no files of its own; send the message from a screen that has them.`);
  }
  const label = typeof value.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 120) : base.label;
  const route = typeof value.route === 'string' && /^\/[^\s]{0,299}$/.test(value.route) ? value.route : base.route;
  return { key: base.key, label, route };
}

/** The screen key a route of this project points at, or null. */
function keyOfRoute(project, route) {
  const text = String(route || '').split(/[?#]/)[0].replace(/\/+$/, '');
  const asked = (/[?&]issue=(ISS_\d{3})/.exec(String(route || '')) || [])[1] || null;
  const base = `/p/${encodeURIComponent(project.id)}`;
  if (text === base) return 'home';
  if (!text.startsWith(`${base}/`)) return null;
  const rest = text.slice(base.length + 1).split('/');
  const issue = () => {
    if (asked) return asked;
    const list = S.ws.listIssues(project.root);
    return list[0] || 'ISS_001';
  };
  switch (rest[0]) {
    case 'story':
    case 'style':
    case 'check':
    case 'corrections':
    case 'history':
    case 'settings':
      return rest.length === 1 ? rest[0] : (rest[0] === 'check' || rest[0] === 'corrections' ? rest[0] : null);
    case 'characters': return rest.length === 1 ? 'characters' : `character:${rest[1]}`;
    case 'places':
      if (rest.length === 1) return 'places';
      return rest[1] === 'location' || rest[1] === 'prop' ? `${rest[1]}:${rest[2]}` : null;
    case 'pages': return rest.length === 1 ? `pages:${issue()}` : `page:${rest[1]}`;
    case 'cover': return `cover:${issue()}`;
    case 'publish': return `publish:${issue()}`;
    default: return null;
  }
}

/**
 * Navigation suggestions of a reply, checked against the real screens of the
 * project. Each item may name a screen by `screen` (or `key`) or by
 * `route`; anything that does not resolve to an existing screen is dropped.
 * @returns {{links: {key, route, label, screen_label}[], dropped: number}}
 */
function checkLinks(project, list) {
  const links = [];
  let dropped = 0;
  for (const item of Array.isArray(list) ? list.slice(0, 12) : []) {
    if (!item || typeof item !== 'object') {
      dropped += 1;
      continue;
    }
    let key = typeof item.screen === 'string' ? item.screen : typeof item.key === 'string' ? item.key : null;
    if (!key && typeof item.route === 'string') key = keyOfRoute(project, item.route);
    if (!key || !exists(project, key) || links.some((l) => l.key === key)) {
      dropped += 1;
      continue;
    }
    const screen = screenOf(project, key);
    const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 120) : null;
    links.push({ key, route: screen.route, label: label || screen.label, screen_label: screen.label });
  }
  return { links, dropped };
}

module.exports = { NAV_ONLY, routeOf, labelOf, exists, screenOf, checkScreen, keyOfRoute, checkLinks };
