// What changed while the person was elsewhere (TODO item 12).
//
// Built from what the server already sends: the jobs of the project (their
// results, their failures, the questions they wait on) over the event stream.
// Each finished job becomes one or more news entries, each about one item a
// screen shows (a character, a page, a plan, the cover, a story proposal),
// with a short line of what is new. The side navigation shows a dot with the
// count per screen; inside a screen the same item carries a marker.
//
// An entry stops being new when the person opens its item (the character,
// the page, the screen itself for a plan, a proposal or the cover), not when
// the job ends; "Mark all as seen" clears a screen. What was open during a
// visit keeps its marker until the person leaves, so they see what was new.
//
// Seen state is kept per project in localStorage and survives a reload. A
// job that ended before the project was first opened in this browser is old
// news. A job that waits for an answer, or failed, is an alert: a different
// colour, counted first. A waiting job stops being one when it is answered.

import { t, tv } from '/js/i18n.js';
import { state, bus, ENDED } from '/js/store.js';

const KEEP_PROCESSED = 400;
const SCREENS = ['story', 'style', 'characters', 'places', 'pages', 'check', 'corrections', 'cover', 'publish'];

let data = null; // { since, processed: [], entries: { [id]: entry } }
let projectId = null;
let visit = new Map(); // item -> entries shown during this visit

function key(id) {
  return `studio.unseen.${id}`;
}

function load(id) {
  projectId = id;
  visit = new Map();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key(id)) || 'null'); } catch (err) { saved = null; }
  if (!saved || typeof saved !== 'object' || !saved.since) {
    saved = { since: new Date().toISOString(), processed: [], entries: {} };
  }
  data = { since: saved.since, processed: Array.isArray(saved.processed) ? saved.processed : [], entries: saved.entries || {} };
  save();
}

function save() {
  if (!data || !projectId) return;
  try { localStorage.setItem(key(projectId), JSON.stringify(data)); } catch (err) { /* storage is off: news lasts until reload */ }
}

function emit() {
  bus.emit('unseen');
}

// --- from a job to news ---------------------------------------------------------

function add(list, screen, item, text, params = {}, { tone = 'new', also = [], link = null } = {}) {
  if (!item) return;
  list.push({ screen, also, item, text, params, tone, link });
}

/** The news a finished job brings: [{ screen, also, item, text, params, tone, link }]. */
function newsOf(job) {
  const out = [];
  const p = job.params || {};
  const r = job.result || {};
  const issue = p.issue || r.issue || 'ISS_001';
  const base = `/p/${encodeURIComponent(job.project || state.projectId)}`;
  const failed = job.status === 'failed';
  const title = job.title || job.op;
  const story = () => {
    const proposals = [...(r.proposal ? [{ id: r.proposal, parts: r.parts || 0 }] : []), ...(Array.isArray(job.story_proposals) ? job.story_proposals : [])];
    for (const prop of proposals) add(out, 'story', `proposal:${prop.id}`, 'unseen.proposal', { n: prop.parts || 0 }, { link: `${base}/story?proposal=${encodeURIComponent(prop.id)}` });
  };
  const entityNews = () => {
    for (const e of Array.isArray(job.added_entities) ? job.added_entities : []) {
      const screen = e.kind === 'character' ? 'characters' : 'places';
      const item = `${e.kind}:${e.id}`;
      const link = e.kind === 'character' ? `${base}/characters/${e.id}` : `${base}/places/${e.kind}/${e.id}`;
      if (e.duplicates && e.duplicates.length) {
        add(out, screen, item, 'unseen.possible_duplicate', { name: e.name, other: e.duplicates[0].name }, { tone: 'alert', link, also: ['pages'] });
      } else {
        add(out, screen, item, e.kind === 'character' ? 'unseen.added_character' : 'unseen.added_place', { name: e.name }, { link });
      }
    }
  };
  if (failed) {
    const target = targetOf(job, base, issue);
    if (target) add(out, target.screen, target.item, 'unseen.failed', { title }, { tone: 'alert', link: target.link, also: target.also });
    story();
    return out;
  }
  switch (job.op) {
    case 'character.create':
    case 'character.update':
    case 'character.sheet': {
      const char = p.character || r.character;
      const link = char ? `${base}/characters/${char}` : `${base}/characters`;
      if (job.op === 'character.create') add(out, 'characters', `character:${char}`, 'unseen.character_new', { name: p.name || char }, { link });
      else if (job.op === 'character.update' && !r.sheet) add(out, 'characters', `character:${char}`, 'unseen.character_changed', {}, { link });
      else add(out, 'characters', `character:${char}`, 'unseen.sheet', { sheet: p.sheet || 'turnaround' }, { link });
      break;
    }
    case 'style.look': add(out, 'style', 'style', 'unseen.look_page', {}, { link: `${base}/style` }); break;
    case 'style.define': add(out, 'style', 'style', 'unseen.style_written', {}, { link: `${base}/style` }); break;
    case 'entities.derive': add(out, 'places', 'places', 'unseen.places_added', {}, { link: `${base}/places` }); break;
    case 'pages.plan': {
      const n = Array.isArray(r.pages) ? r.pages.length : (p.pages || 0);
      add(out, 'pages', `plan:${issue}`, 'unseen.plan', { n }, { link: `${base}/pages` });
      break;
    }
    case 'pages.generate':
      for (const pg of Array.isArray(r.pages) ? r.pages : []) {
        const id = pg.page || pg.id;
        if (!id || pg.error || pg.failed) continue;
        add(out, 'pages', `page:${id}`, pg.passes === false || pg.flagged ? 'unseen.page_flagged' : 'unseen.page_drawn', { n: Number(String(id).slice(-3)) }, { also: ['check'], link: `${base}/pages/${id}` });
      }
      break;
    case 'page.correct':
    case 'page.review':
    case 'page.manual': {
      const id = p.page || (p.render && /^PG_/.test(p.render) ? String(p.render).replace(/_V\d{2}$/, '') : null);
      if (id) add(out, job.op === 'page.correct' ? 'corrections' : 'check', `page:${id}`, job.op === 'page.correct' ? 'unseen.page_repaired' : 'unseen.page_checked', { n: Number(String(id).slice(-3)) }, { also: ['pages'], link: `${base}/pages/${id}` });
      else add(out, 'cover', `cover:${issue}`, 'unseen.cover_drawn', {}, { link: `${base}/cover` });
      break;
    }
    case 'cover.create':
    case 'cover.correct': add(out, 'cover', `cover:${issue}`, 'unseen.cover_drawn', {}, { link: `${base}/cover` }); break;
    case 'lettering.apply': add(out, 'publish', `publish:${issue}`, 'unseen.lettered', {}, { link: `${base}/publish` }); break;
    case 'publish.build': add(out, 'publish', `publish:${issue}`, 'unseen.edition', {}, { link: `${base}/publish` }); break;
    default: break;
  }
  entityNews();
  story();
  return out;
}

/** The screen and item a job is about, for an alert. */
function targetOf(job, base, issue) {
  const p = job.params || {};
  switch (job.op) {
    case 'character.create': case 'character.update': case 'character.sheet':
      return { screen: 'characters', item: p.character ? `character:${p.character}` : 'characters', link: p.character ? `${base}/characters/${p.character}` : `${base}/characters` };
    case 'style.define': case 'style.look': return { screen: 'style', item: 'style', link: `${base}/style` };
    case 'project.setup': case 'story.update': case 'story.draft': case 'story.complete': case 'story.suggest':
      return { screen: 'story', item: `job:${job.id}`, link: `${base}/story` };
    case 'entities.derive': return { screen: 'places', item: 'places', link: `${base}/places` };
    case 'pages.plan': return { screen: 'pages', item: `plan:${issue}`, link: `${base}/pages` };
    case 'pages.generate': {
      const first = Array.isArray(p.pages) && p.pages.length ? p.pages[0] : null;
      return first ? { screen: 'pages', item: `page:${first}`, link: `${base}/pages/${first}`, also: ['check'] } : { screen: 'pages', item: `plan:${issue}`, link: `${base}/pages` };
    }
    case 'page.correct': case 'page.review': case 'page.manual':
      return p.page ? { screen: job.op === 'page.correct' ? 'corrections' : 'check', item: `page:${p.page}`, link: `${base}/pages/${p.page}`, also: ['pages'] } : { screen: 'cover', item: `cover:${issue}`, link: `${base}/cover` };
    case 'cover.create': case 'cover.correct': return { screen: 'cover', item: `cover:${issue}`, link: `${base}/cover` };
    case 'lettering.apply': case 'publish.build': return { screen: 'publish', item: `publish:${issue}`, link: `${base}/publish` };
    default: return null;
  }
}

function take(job) {
  if (!data || !job || !job.id || job.op === 'chat.turn') return;
  if (!ENDED.includes(job.status) || job.status === 'cancelled') return;
  if (data.processed.includes(job.id)) return;
  if (!job.ended_at || job.ended_at < data.since) return;
  data.processed.push(job.id);
  if (data.processed.length > KEEP_PROCESSED) data.processed.splice(0, data.processed.length - KEEP_PROCESSED);
  for (const n of newsOf(job)) {
    // A later success settles an earlier failure of the same item.
    if (n.tone === 'new') {
      const failed = data.entries[`${n.item}|alert`];
      if (failed && failed.text === 'unseen.failed') delete data.entries[`${n.item}|alert`];
    }
    // One entry per item and kind of news: the newest wins.
    const id = `${n.item}|${n.tone}`;
    data.entries[id] = Object.assign({ id, at: job.ended_at, job: job.id }, n);
  }
  save();
  emit();
}

// --- reading ----------------------------------------------------------------------

/** Jobs waiting for an answer: alerts that last until the answer is given. */
function waitingAlerts() {
  const out = [];
  const base = `/p/${encodeURIComponent(state.projectId || '')}`;
  for (const job of state.jobs.values()) {
    // A job paused for a tool's quota is an alert too, until it is resumed or cancelled.
    if (job.status !== 'needs_decision' && !(job.status === 'paused' && job.paused && !job.paused.by)) continue;
    const target = targetOf(job, base, (job.params && job.params.issue) || 'ISS_001') || { screen: 'pages', item: `job:${job.id}`, link: null };
    out.push({ id: `wait|${job.id}`, screen: target.screen, also: target.also || [], item: target.item, text: job.status === 'paused' ? 'unseen.paused' : 'unseen.waiting', params: { title: job.title || job.op }, tone: 'alert', link: target.link, job: job.id, live: true });
  }
  return out;
}

function all() {
  return [...waitingAlerts(), ...(data ? Object.values(data.entries) : [])];
}

function onScreen(entry, screen) {
  return entry.screen === screen || (entry.also || []).includes(screen);
}

/** { n, alert } for the side navigation. */
export function countFor(screen) {
  const list = all().filter((e) => onScreen(e, screen));
  const items = new Set(list.map((e) => e.item));
  return { n: items.size, alert: list.some((e) => e.tone === 'alert') };
}

/** The entries about an item: the ones still new, and the ones shown during this visit. */
export function newsFor(item) {
  const live = all().filter((e) => e.item === item);
  const shown = visit.get(item) || [];
  const seen = new Set(live.map((e) => e.id));
  return [...live, ...shown.filter((e) => !seen.has(e.id))];
}

/** The text of an entry, in the interface language. */
export function entryText(entry) {
  const params = Object.assign({}, entry.params || {});
  if (params.sheet) params.sheet = tv('sheet', params.sheet, params.sheet).toLowerCase();
  // A job's title in the language shown now (the jobs are loaded again when it changes).
  const job = entry.job ? state.jobs.get(entry.job) : null;
  if (params.title && job && job.title) params.title = job.title;
  return t(entry.text, params);
}

/** Every entry of a screen, alerts first, newest first. */
export function newsOfScreen(screen) {
  const list = all().filter((e) => onScreen(e, screen));
  for (const shown of visit.values()) for (const e of shown) if (onScreen(e, screen) && !list.some((x) => x.id === e.id)) list.push(Object.assign({ shown: true }, e));
  return list.sort((a, b) => (a.tone === b.tone ? String(b.at || '').localeCompare(String(a.at || '')) : a.tone === 'alert' ? -1 : 1));
}

// --- seeing ------------------------------------------------------------------------

function markItems(test) {
  if (!data) return;
  let changed = false;
  for (const [id, e] of Object.entries(data.entries)) {
    if (!test(e)) continue;
    if (!visit.has(e.item)) visit.set(e.item, []);
    visit.get(e.item).push(e);
    delete data.entries[id];
    changed = true;
  }
  if (changed) {
    save();
    emit();
  }
}

/** The person opened an item: its news is seen (and stays visible until they leave). */
export function markSeen(item) {
  markItems((e) => e.item === item);
}

/** "Mark all as seen" on a screen. */
export function markScreenSeen(screen) {
  markItems((e) => onScreen(e, screen));
  visit = new Map();
  emit();
}

/**
 * A screen is opened. What it shows in full counts as seen: the item of a
 * detail screen, the plan on the Pages screen, a proposal on the Story
 * screen, the cover, the publish screen, the look.
 */
export function openScreen(screen, params = {}, issue = null) {
  visit = new Map();
  if (!data) return;
  const items = [];
  if (params.char) items.push(`character:${params.char}`);
  if (params.page) items.push(`page:${params.page}`);
  if (params.entity) items.push(`${/^LOC_/.test(params.entity) ? 'location' : 'prop'}:${params.entity}`);
  if (screen === 'pages' && !params.page && issue) items.push(`plan:${issue}`);
  if (screen === 'cover' && issue) items.push(`cover:${issue}`);
  if (screen === 'publish' && issue) items.push(`publish:${issue}`);
  if (screen === 'style') items.push('style');
  if (screen === 'places' && !params.entity) items.push('places');
  markItems((e) => items.includes(e.item) || (screen === 'story' && e.screen === 'story'));
}

export const UNSEEN_SCREENS = SCREENS;

export function startUnseen() {
  bus.on('project', (id) => {
    if (id) load(id);
    else {
      data = null;
      projectId = null;
      visit = new Map();
    }
    for (const job of state.jobs.values()) take(job);
    emit();
  });
  bus.on('job', ({ job }) => {
    if (state.projectId && projectId !== state.projectId) load(state.projectId);
    take(job);
    if (job.status === 'needs_decision' || job.status === 'paused' || (job && ENDED.includes(job.status))) emit();
  });
}
