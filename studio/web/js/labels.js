// Words for what the server names: jobs, steps, tools, pages. The server
// writes its own sentences (job titles, step labels, notes, errors) in the
// language of each request; the interface words only the values it sends as
// plain codes (a status, a tool, an actor) and the page and version names.

import { t, tn, tv } from '/js/i18n.js';

export function toolName(tool) {
  return tv('tool', tool, tool || '');
}

export function actorName(actor) {
  return tv('actor', actor, actor || '');
}

/** "PG_001_002" -> "Page 2"; "CV_001" -> "Cover". */
export function pageName(id) {
  const m = /^PG_\d{3}_(\d{3})/.exec(String(id || ''));
  if (m) return t('page.n', { n: Number(m[1]) });
  if (/^CV_\d{3}/.test(String(id || ''))) return t('cover.name');
  return String(id || '');
}

/**
 * The scaffold's IDs inside a sentence, in words: "page PG_001_002" -> "page 2",
 * "PG_001_002" -> "Page 2", "ISS_001" -> "1", "ED_001_02" -> "2". The raw IDs
 * stay under "Details" where a screen shows them.
 */
export function plainIds(text) {
  return String(text == null ? '' : text)
    .replace(/\b(page|página)\s+PG_\d{3}_(\d{3})\b/gi, (m, word, n) => `${word} ${Number(n)}`)
    .replace(/\bPG_\d{3}_(\d{3})(?:_V(\d{2}))?\b/g, (m, n, v) => (v
      ? `${t('page.n', { n: Number(n) })}, ${t('version.n', { n: Number(v) }).toLowerCase()}`
      : t('page.n', { n: Number(n) })))
    .replace(/\bISS_(\d{3})\b/g, (m, n) => String(Number(n)))
    .replace(/\bED_\d{3}_(\d{2})\b/g, (m, n) => String(Number(n)));
}

/** "PG_001_002_V03" -> "Version 3". */
export function versionName(renderId) {
  const m = /_V(\d{2})$/.exec(String(renderId || ''));
  return m ? t('version.n', { n: Number(m[1]) }) : String(renderId || '');
}

/**
 * The title of a job. The server writes it in the language of the request;
 * the interface adds which page it is about.
 */
export function jobTitle(job) {
  if (!job) return '';
  const title = job.title || String(job.op || '');
  const p = job.params || {};
  if (job.op === 'pages.generate' && Array.isArray(p.pages)) {
    return p.pages.length === 1 ? `${title}: ${pageName(p.pages[0])}` : `${title} (${tn('job.pages_count', p.pages.length)})`;
  }
  if ((job.op === 'page.correct' || job.op === 'page.review') && (p.page || p.render)) {
    return `${title}: ${pageName(p.page || p.render)}`;
  }
  return title;
}

/** A step of a job, as the server words it in the language of the request. */
export function stepLabel(job, step) {
  return step.label || String(step.id);
}

export function stepStatus(status) {
  return tv('step_status', status);
}

export function jobStatus(job) {
  if (job.status === 'queued' && job.position) return t('job_status.queued_at', { n: job.position });
  return tv('job_status', job.status);
}

/** Where the result of a job is seen. */
export function jobLink(job) {
  const base = `/p/${encodeURIComponent(job.project)}`;
  const p = job.params || {};
  switch (job.op) {
    case 'story.draft':
    case 'story.complete':
    case 'story.suggest':
    case 'project.setup':
      return job.result && job.result.proposal ? `${base}/story?proposal=${encodeURIComponent(job.result.proposal)}` : `${base}/story`;
    case 'story.update': return `${base}/story`;
    case 'style.define':
    case 'style.look': return `${base}/style`;
    case 'character.create':
    case 'character.update':
    case 'character.sheet': return p.character ? `${base}/characters/${p.character}` : `${base}/characters`;
    case 'entities.derive': return `${base}/places`;
    case 'pages.plan':
    case 'pages.generate': return `${base}/pages`;
    case 'page.review': {
      const page = p.page || (p.render ? String(p.render).replace(/_V\d{2}$/, '') : null);
      if (page && page.startsWith('CV_')) return `${base}/cover`;
      return page ? `${base}/check/${page}` : `${base}/check`;
    }
    case 'page.correct': return p.page ? `${base}/corrections/${p.page}` : `${base}/corrections`;
    case 'page.manual':
      if (p.page) return `${base}/pages/${p.page}`;
      if (p.cover) return `${base}/cover`;
      if (p.entity && p.entity.startsWith('LOOK_')) return `${base}/style`;
      if (p.entity && p.entity.startsWith('CHAR_')) return `${base}/characters/${p.entity}`;
      return `${base}/places`;
    case 'cover.create':
    case 'cover.correct': return `${base}/cover`;
    case 'lettering.apply':
    case 'publish.build': return `${base}/publish`;
    default: return null;
  }
}

/** The path a correction took, in the server's words. */
export function correctionPath(result) {
  if (!result || !result.path) return '';
  return result.path_label || result.path;
}

/** A result that passed and left notes to read. */
function hasNotes(result) {
  return result.outcome === 'notes' || (result.outcome === undefined && result.passes && result.open_findings > 0);
}

/** Why the automatic repairs stopped, in the server's words, after a flagged result. */
function withStop(text, r) {
  return !r.passes && r.stopped ? `${text} ${r.stopped}` : text;
}

/** One or two sentences about how a finished job went. */
export function jobOutcome(job) {
  const r = job.result;
  if (job.status === 'failed') {
    if (!job.error) return t('job.failed_plain');
    const text = job.error.message || t('job.failed_plain');
    const pages = job.error.details && Array.isArray(job.error.details.pages) ? job.error.details.pages : [];
    return pages.length ? `${t('job.failed_pages', { pages: pages.map((p) => pageName(p.page || p)).join(', ') })} ${text}` : text;
  }
  if (job.status === 'cancelled') return t('job.cancelled_plain');
  if (job.status !== 'done' || !r) return '';
  switch (job.op) {
    case 'pages.generate': {
      const assemble = Array.isArray(r.to_assemble) ? r.to_assemble.length : 0;
      const parts = assemble && !r.passed && !r.flagged ? [] : [tn('outcome.pages.passed', r.passed || 0)];
      if (assemble) parts.push(tn('outcome.pages.assemble', assemble));
      if (r.with_notes) parts.push(tn('outcome.pages.with_notes', r.with_notes));
      if (r.flagged) parts.push(tn('outcome.pages.flagged', r.flagged));
      if (r.failed) parts.push(tn('outcome.pages.failed', r.failed));
      return parts.join(' ');
    }
    case 'page.correct':
    case 'cover.correct':
      return withStop(`${correctionPath(r)} ${r.passes ? (hasNotes(r) ? t('outcome.correct.notes') : t('outcome.correct.passes')) : t('outcome.correct.flagged')}`, r);
    case 'page.review':
      return withStop(r.passes ? (hasNotes(r) ? t('outcome.review.notes') : t('outcome.review.passes')) : t('outcome.review.flagged'), r);
    case 'publish.build':
      return r.draft ? t('outcome.publish.draft', { edition: plainIds(r.edition) }) : t('outcome.publish.final', { edition: plainIds(r.edition) });
    case 'story.draft':
    case 'story.complete':
    case 'story.suggest':
    case 'project.setup':
      return r.proposal ? tn('outcome.proposal', r.parts || 0) : (r.summary || t('job.done_plain'));
    case 'style.look':
      return t('outcome.candidate');
    case 'character.sheet':
      return t('outcome.candidate');
    case 'lettering.apply':
      return r.failed ? tn('outcome.lettering.failed', r.failed) : t('outcome.lettering.done');
    case 'cover.create':
      if (r.drawn === false) return r.reason ? `${t('outcome.cover.written_only')} ${r.reason}` : t('outcome.cover.written_only');
      return withStop(`${r.written === false ? `${t('outcome.cover.as_written')} ` : ''}${r.passes ? (hasNotes(r) ? t('outcome.cover.notes') : t('outcome.cover.passes')) : t('outcome.cover.flagged')}`, r);
    case 'page.manual':
      if (r.handoff) return t('outcome.manual.handoff');
      return r.reviewed === false ? t('outcome.manual.stored_unreviewed') : (r.passes ? t('outcome.review.passes') : t('outcome.review.flagged'));
    default:
      return r.summary || t('job.done_plain');
  }
}

export function seconds(fromIso, toIso) {
  if (!fromIso) return 0;
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  return Math.max(0, (to - from) / 1000);
}
