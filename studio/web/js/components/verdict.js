// How a review is shown. A verdict never stands alone: it comes with what
// was expected and what is visible, it says it is an automated reading, and
// it says whether the tool that checked the image is the one that drew it.
// The person's approval is a separate thing and is shown apart.
//
// A review has one of three outcomes:
//   pass     the check found nothing
//   notes    the page passes, and the check wrote down minor things it saw;
//            each note can be turned into a correction. Not an error.
//   flagged  a blocking finding, a failed gate or an open change request

import { h } from '/js/dom.js';
import { t, tn, tv, formatDate } from '/js/i18n.js';
import { api } from '/js/api.js';
import { pageName, versionName } from '/js/labels.js';
import { notice, facts, actionButton } from '/js/components/ui.js';
import { confirmDialog } from '/js/components/dialog.js';
import { toast } from '/js/components/toast.js';

export const CHECKS = ['identity', 'cast_count', 'position', 'movement', 'role_causality', 'object_identity',
  'object_custody', 'physical_state', 'wardrobe', 'spatial_logic', 'drawing_clarity', 'lettering',
  'page_structure', 'style_fidelity'];

const OUTCOMES = ['pass', 'notes', 'flagged'];

function openCount(v) {
  if (Array.isArray(v.findings)) return v.findings.filter((f) => f.status === 'open').length;
  return v.open_findings || 0;
}

/**
 * The outcome of a review or of a page summary: pass, notes or flagged, or
 * null when nothing was checked. The server states it as `outcome`; for a
 * response without the field it is worked out from the verdict and the open
 * findings, by the same rule.
 */
export function outcomeOf(v) {
  if (!v || !v.verdict) return null;
  if (OUTCOMES.includes(v.outcome)) return v.outcome;
  if (v.verdict === 'flagged' || v.flagged === true) return 'flagged';
  return openCount(v) > 0 ? 'notes' : 'pass';
}

/**
 * Whether the person approved this render against a flagged check. The
 * server records it as data on the review and on the page and cover
 * summaries (`overruled`, `overruled_at`, `overrule_note`), so a list can say
 * it without opening each review.
 */
export function isOverruled(v) {
  return !!(v && v.overruled === true);
}

/** The person's approval, from a review ({ status }) or a summary (a string). */
export function approvalOf(v) {
  if (!v || !v.human_approval) return null;
  return typeof v.human_approval === 'string' ? v.human_approval : v.human_approval.status || null;
}

/** Minor findings the person accepted by approving: from the count, else from the list. */
function acceptedNotes(v) {
  if (typeof v.accepted_notes === 'number') return v.accepted_notes;
  return Array.isArray(v.findings) ? v.findings.filter((f) => f.status === 'accepted' && f.severity === 'minor').length : 0;
}

/** Approved by the person with the check's notes accepted (not an overrule). */
export function approvedWithNotes(v) {
  return !!v && !isOverruled(v) && approvalOf(v) === 'approved' && acceptedNotes(v) > 0;
}

/** The class that colours a verdict: the outcome, or "overruled". */
export function verdictClass(v) {
  if (!v || !v.verdict) return 'none';
  return isOverruled(v) ? 'overruled' : outcomeOf(v);
}

/** The verdict in a few words, for lists. Always words, never a mark alone. */
export function verdictWords(v) {
  if (!v || !v.verdict) return t('verdict.none');
  if (isOverruled(v)) return t('verdict.overruled');
  if (approvedWithNotes(v)) return tn('verdict.approved_notes', acceptedNotes(v));
  const outcome = outcomeOf(v);
  const open = openCount(v);
  if (outcome === 'flagged') return open ? tn('verdict.flagged_open', open) : t('verdict.flagged');
  if (outcome === 'notes') return open ? tn('verdict.notes', open) : t('verdict.notes_plain');
  // "Repaired" is said only when a repair happened: a verdict of "fixed"
  // also covers a page whose notes the person accepted.
  const list = Array.isArray(v.findings) ? v.findings : [];
  if (v.repair_cycle > 0 || list.some((f) => f.status === 'fixed')) return t('verdict.fixed');
  return t('verdict.pass');
}

/**
 * A compact verdict for a thumbnail or a row: the words, whether the check
 * was independent, and the person's own approval when there is one.
 * v: { verdict, outcome, open_findings, independent, human_approval }
 */
export function verdictChip(v) {
  if (!v || !v.verdict) return h('span', { class: 'verdict none' }, t('verdict.none'));
  const approval = approvalOf(v);
  return h('span', { class: 'verdict-group' },
    h('span', { class: `verdict ${verdictClass(v)}` }, verdictWords(v)),
    v.independent === false ? h('span', { class: 'verdict-note' }, t('verdict.not_independent_short')) : null,
    approval === 'approved' && !isOverruled(v) && !approvedWithNotes(v) ? h('span', { class: 'verdict-human' }, t('verdict.approved_by_you')) : null);
}

function checkRow(key, check) {
  const result = check ? check.result : 'not_performed';
  return h('li', { class: 'check-row', dataset: { result } },
    h('div', { class: 'check-name' },
      h('strong', null, tv('check', key)),
      h('span', { class: 'check-result' }, tv('check_result', result))),
    h('p', { class: 'check-evidence' }, check && check.evidence ? check.evidence : t('review.no_evidence')));
}

/**
 * One finding. `note` marks an observation on a page that passes; with
 * `onCorrect` an open finding gets a button that turns it into a correction.
 */
function findingCard(f, panels, { note = false, onCorrect } = {}) {
  const panel = f.panel ? (panels && panels[f.panel] ? t('review.panel_n', { n: panels[f.panel] }) : f.panel) : t('review.whole_page');
  const mine = f.source === 'user_request';
  return h('li', { class: `finding${note ? ' note' : ''}`, dataset: { status: f.status, severity: f.severity } },
    h('div', { class: 'finding-head' },
      h('strong', null, mine ? t('review.your_request') : tv('check', f.check, t('review.finding'))),
      h('span', { class: 'finding-tags' },
        h('span', null, panel),
        note ? null : h('span', null, tv('severity', f.severity)),
        h('span', { class: 'finding-status' }, mine && f.status === 'accepted' ? t('finding_status.dropped') : (note ? t('finding_status.note') : tv('finding_status', f.status))))),
    facts([
      [t('review.visible'), f.visible],
      [t('review.expected'), f.expected],
      [mine ? t('review.asked') : (note ? t('review.suggested') : t('review.repair')), f.repair],
      f.recheck ? [t('review.recheck', { version: versionName(f.recheck.render) }), f.recheck.evidence] : null,
      f.region ? [t('review.region'), t('region.readout', {
        x: Math.round(f.region.x * 100), y: Math.round(f.region.y * 100), w: Math.round(f.region.w * 100), h: Math.round(f.region.h * 100),
      })] : null,
    ]),
    onCorrect && f.status === 'open' && !mine
      ? h('div', { class: 'row' }, actionButton(t('review.correct_this'), () => onCorrect(f), { small: true, kind: note ? '' : 'primary' }))
      : null);
}

/**
 * Ask before a finding becomes a correction: the text can be changed first.
 * Resolves to the text to send, or null.
 */
export async function confirmCorrection(finding) {
  const result = await confirmDialog({
    title: t('review.correct_title'),
    body: t('review.correct_body'),
    note: { label: t('review.correct_label'), required: true, value: finding.repair || finding.visible || '' },
    confirm: t('review.correct_confirm'),
  });
  return result ? result.note : null;
}

/** What the person decided against the check: when, about what, and in their words. */
function overruleNote(review) {
  const items = review.overruled_items || [];
  const findings = items.filter((i) => !/^gate /.test(i)).map((i) => i.replace(/!$/, ''));
  const gates = items.filter((i) => /^gate /.test(i)).map((i) => i.slice(5));
  const what = [
    findings.length ? tn('review.overruled_findings', findings.length, { ids: findings.join(', ') }) : null,
    ...gates.map((g) => t('review.overruled_gate', { gate: tv('gate', g) })),
  ].filter(Boolean);
  return h('div', { class: 'overrule-note stack-s' },
    h('p', { class: 'strong-note' }, review.overruled_at ? t('review.overruled_on', { date: formatDate(review.overruled_at) }) : t('review.overruled_plain')),
    what.length ? h('p', { class: 'small' }, what.join(' ')) : null,
    review.overrule_note ? h('p', null, h('span', { class: 'muted' }, t('review.overrule_note')), ' ', h('q', null, review.overrule_note)) : null);
}

/**
 * The whole review of one render.
 *   review        the render's review (or null)
 *   panels        { PN_id: number } to name panels
 *   repairLimit   automatic repairs allowed
 *   onCorrect     (finding) => void: turn an open finding into a correction
 */
export function reviewPanel(review, { panels, repairLimit, onCorrect } = {}) {
  if (!review) {
    return h('div', { class: 'review' }, notice('info', h('strong', null, t('verdict.none')), ' ', t('review.none_hint')));
  }
  const human = review.reviewer === 'human';
  const checks = review.checks || {};
  const order = [...CHECKS].sort((a, b) => {
    const rank = (k) => ({ fail: 0, not_performed: 1, pass: 2, not_applicable: 3 }[(checks[k] || {}).result] ?? 1);
    return rank(a) - rank(b);
  });
  const failed = CHECKS.filter((k) => (checks[k] || {}).result === 'fail').length;
  const unjudged = CHECKS.filter((k) => !checks[k] || checks[k].result === 'not_performed').length;
  const approval = review.human_approval || { status: 'pending' };
  const findings = review.findings || [];
  const overruled = isOverruled(review);
  const outcome = outcomeOf(review);
  // On a page that passes, what is still open is a note, not a defect.
  const notes = outcome === 'notes' ? findings.filter((f) => f.status === 'open') : [];
  const others = findings.filter((f) => !notes.includes(f));
  return h('div', { class: 'review', dataset: { outcome: overruled ? 'overruled' : outcome } },
    h('div', { class: `review-verdict ${verdictClass(review)}` },
      h('h3', null, verdictWords(review)),
      overruled ? overruleNote(review) : null,
      !overruled && approvedWithNotes(review) ? h('p', null, tn('review.notes_accepted', acceptedNotes(review))) : null,
      !overruled && outcome === 'notes' ? h('p', null, t('review.notes_intro')) : null,
      h('p', null, human ? t('review.opened_by_request') : t('review.automated')),
      human ? null : h('p', { class: review.independent ? '' : 'strong-note' },
        review.independent ? t('review.independent') : t('review.not_independent')),
      review.reviewed_at ? h('p', { class: 'small faint' }, t('review.reviewed_at', { date: formatDate(review.reviewed_at) }),
        repairLimit !== undefined && review.repair_cycle !== undefined
          ? ` · ${t('review.repair_cycle', { n: review.repair_cycle, limit: repairLimit })}` : '') : null),
    h('div', { class: `review-human ${approval.status}` },
      h('strong', null, t('review.your_decision')), ' ',
      approval.status === 'approved'
        ? t('review.human_approved', { date: formatDate(approval.at) })
        : (approval.status === 'rejected' ? t('review.human_rejected') : t('review.human_pending'))),
    notes.length
      ? h('section', null, h('h4', null, tn('review.notes_title', notes.length)),
        h('ul', { class: 'finding-list' }, notes.map((f) => findingCard(f, panels, { note: true, onCorrect }))))
      : null,
    others.length
      ? h('section', null, h('h4', null, notes.length ? tn('review.settled_title', others.length) : tn('review.findings', others.length)),
        h('ul', { class: 'finding-list' }, others.map((f) => findingCard(f, panels, { onCorrect }))))
      : null,
    h('section', null,
      h('h4', null, t('review.checks_title')),
      h('p', { class: 'small muted' },
        failed ? tn('review.checks_failed', failed) : (unjudged ? tn('review.checks_unjudged', unjudged) : t('review.checks_all_clear'))),
      h('ul', { class: 'check-list' }, order.map((k) => checkRow(k, checks[k])))),
    review.gates ? h('section', null, h('h4', null, t('review.gates')),
      facts([
        [t('gate.style_fidelity'), tv('check_result', review.gates.style_fidelity)],
        [t('gate.narrative_continuity'), tv('check_result', review.gates.narrative_continuity)],
      ])) : null,
    review.compared_against ? h('section', null, h('h4', null, t('review.compared')),
      facts([
        [t('review.compared_refs'), (review.compared_against.references || []).join(', ') || t('review.compared_nothing')],
        [t('review.compared_pages'), (review.compared_against.neighbors || []).join(', ') || t('review.compared_nothing')],
      ])) : null,
    review.notes && typeof review.notes === 'string' ? h('p', { class: 'small muted' }, review.notes) : null);
}

/**
 * The person approves a page or a cover. When the check flagged it, the
 * approval is an overrule: it is said in so many words, the open findings are
 * listed, and a note is recorded. A page that passes with notes is approved
 * like any other page that passes.
 *   target: { kind: 'page', page, render } or { kind: 'cover', issue, render }
 */
export async function approveRender(ctx, target, review) {
  const call = (extra) => (target.kind === 'cover'
    ? api.approveCover(ctx.projectId, Object.assign({ issue: target.issue, render: target.render }, extra))
    : api.approvePage(ctx.projectId, Object.assign({ page: target.page, render: target.render }, extra)));
  const name = target.kind === 'cover' ? t('cover.name') : pageName(target.page);
  const flagged = outcomeOf(review) === 'flagged';
  if (!flagged) {
    const res = await call({});
    const accepted = res && Array.isArray(res.accepted_notes) ? res.accepted_notes.length : 0;
    toast(accepted
      ? tn('approve.done_notes', accepted, { name, version: versionName(target.render) })
      : t('approve.done', { name, version: versionName(target.render) }), { kind: 'ok' });
    ctx.refresh();
    return true;
  }
  const open = (review.findings || []).filter((f) => f.status === 'open');
  const result = await confirmDialog({
    title: t('overrule.title', { name }),
    body: h('div', { class: 'stack-s' },
      h('p', null, t('overrule.body')),
      open.length ? h('ul', { class: 'finding-list' }, open.map((f) => h('li', { class: 'finding', dataset: { status: 'open', severity: f.severity } },
        facts([[t('review.expected'), f.expected], [t('review.visible'), f.visible]])))) : null,
      h('p', { class: 'small muted' }, t('overrule.record'))),
    note: { label: t('overrule.note_label'), required: true, hint: t('overrule.note_hint') },
    check: { label: t('overrule.ack') },
    confirm: t('overrule.confirm'),
    danger: true,
    run: (value) => call({ overrule: true, note: value.note }),
  });
  if (!result) return false;
  toast(t('overrule.done', { name }), { kind: 'ok' });
  ctx.refresh();
  return true;
}
