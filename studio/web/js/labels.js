// Words for the things the server names with codes: jobs, steps, tools,
// pages. The server writes its titles in English; these go through the
// dictionaries, and fall back to the server's text for anything new.

import { t, tn, tv, has } from '/js/i18n.js';

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

/** "PG_001_002_V03" -> "Version 3". */
export function versionName(renderId) {
  const m = /_V(\d{2})$/.exec(String(renderId || ''));
  return m ? t('version.n', { n: Number(m[1]) }) : String(renderId || '');
}

export function jobTitle(job) {
  if (!job) return '';
  if (job.op === 'pages.generate' && job.params && Array.isArray(job.params.pages)) {
    return tn('job.pages.generate.count', job.params.pages.length);
  }
  if ((job.op === 'page.correct' || job.op === 'page.review') && job.params && (job.params.page || job.params.render)) {
    return `${tv('job', job.op, job.title)}: ${pageName(job.params.page || job.params.render)}`;
  }
  return tv('job', job.op, job.title);
}

export function stepLabel(job, step) {
  const op = job.op;
  const id = String(step.id);
  const colon = id.indexOf(':');
  const scope = colon === -1 ? null : id.slice(0, colon);
  let base = colon === -1 ? id : id.slice(colon + 1);
  let n = null;
  const numbered = /^(repair|review)-(\d+)$/.exec(base);
  if (numbered) {
    base = numbered[1] === 'repair' ? 'repair' : 'review_repair';
    n = Number(numbered[2]);
  }
  const path = job.params && job.params.path;
  const keys = [path ? `step.${op}.${base}.${path}` : null, `step.${op}.${base}`, `step.any.${base}`].filter(Boolean);
  const key = keys.find((k) => has(k));
  if (!key) return step.label || id;
  const text = t(key, { n });
  if (!scope) return text;
  return `${/^PG_|^CV_/.test(scope) ? pageName(scope) : scope}: ${text}`;
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
    case 'project.setup':
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

/** The path a correction took, in plain words. */
export function correctionPath(result) {
  if (!result || !result.path) return '';
  return tv('correction.path', result.path, result.path_label || result.path);
}

/** A result that passed and left notes to read. */
function hasNotes(result) {
  return result.outcome === 'notes' || (result.outcome === undefined && result.passes && result.open_findings > 0);
}

/** One or two sentences about how a finished job went. */
export function jobOutcome(job) {
  const r = job.result;
  if (job.status === 'failed') {
    if (!job.error) return t('job.failed_plain');
    const text = has(`error.${job.error.code}`) ? t(`error.${job.error.code}`) : job.error.message;
    const pages = job.error.details && Array.isArray(job.error.details.pages) ? job.error.details.pages : [];
    return pages.length ? `${t('job.failed_pages', { pages: pages.map((p) => pageName(p.page || p)).join(', ') })} ${text}` : text;
  }
  if (job.status === 'cancelled') return t('job.cancelled_plain');
  if (job.status !== 'done' || !r) return '';
  switch (job.op) {
    case 'pages.generate': {
      const parts = [tn('outcome.pages.passed', r.passed || 0)];
      if (r.with_notes) parts.push(tn('outcome.pages.with_notes', r.with_notes));
      if (r.flagged) parts.push(tn('outcome.pages.flagged', r.flagged));
      if (r.failed) parts.push(tn('outcome.pages.failed', r.failed));
      return parts.join(' ');
    }
    case 'page.correct':
    case 'cover.correct':
      return `${correctionPath(r)} ${r.passes ? (hasNotes(r) ? t('outcome.correct.notes') : t('outcome.correct.passes')) : t('outcome.correct.flagged')}`;
    case 'page.review':
      return r.passes ? (hasNotes(r) ? t('outcome.review.notes') : t('outcome.review.passes')) : t('outcome.review.flagged');
    case 'publish.build':
      return r.draft ? t('outcome.publish.draft', { edition: r.edition }) : t('outcome.publish.final', { edition: r.edition });
    case 'style.look':
      return t('outcome.candidate');
    case 'character.sheet':
      return t('outcome.candidate');
    case 'lettering.apply':
      return r.failed ? tn('outcome.lettering.failed', r.failed) : t('outcome.lettering.done');
    case 'cover.create':
      if (r.drawn === false) return t('outcome.cover.written_only');
      return r.passes ? (hasNotes(r) ? t('outcome.cover.notes') : t('outcome.cover.passes')) : t('outcome.cover.flagged');
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
