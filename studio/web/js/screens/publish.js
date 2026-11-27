// Publish: choose formats, see what blocks a final edition, build a draft or
// a final one, download each file, open the web reader. With overlay
// lettering the browser flattens each page and sends the image back.

import { h, icon, nextId } from '/js/dom.js';
import { t, tn, tv, formatBytes, formatDate } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, button, notice, emptyState } from '/js/components/ui.js';
import { queueOp } from '/js/components/ask.js';
import { jobsFor } from '/js/components/jobs.js';
import { openViewer } from '/js/components/viewer.js';
import { openDialog } from '/js/components/dialog.js';
import { toast } from '/js/components/toast.js';
import { pageName, versionName } from '/js/labels.js';
import { currentIssue, issueBar } from '/js/components/issues.js';
import { newsBar } from '/js/components/news.js';
import { deleteButton, cleanupButton } from '/js/components/deleting.js';

export async function load(ctx) {
  return api.publish(ctx.projectId, currentIssue(ctx));
}

/** Draw the SVG overlay over the render on a canvas and send the PNG to the server. */
async function flattenPage(projectId, pageId, render) {
  const res = await api.lettering(projectId, pageId, render);
  if (!res.ok || !res.svg) {
    const why = (res.errors || []).map((e) => e.message).join(' ') || t('publish.letter_not_ready');
    throw new Error(why);
  }
  const url = URL.createObjectURL(new Blob([res.svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = res.width;
    canvas.height = res.height;
    canvas.getContext('2d').drawImage(img, 0, 0, res.width, res.height);
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!png) throw new Error(t('publish.letter_canvas_failed'));
    await api.sendLettered(projectId, pageId, res.render, png);
    return { warnings: res.warnings || [] };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function letteringPanel(ctx, data) {
  const pages = data.lettering.pages || [];
  const log = h('ul', { class: 'bullets small', 'aria-live': 'polite' });
  const todo = pages.filter((p) => p.render);
  const flatten = async () => {
    log.replaceChildren();
    let done = 0;
    for (const p of todo) {
      const line = h('li', null, `${pageName(p.page)}: ${t('publish.letter_working')}`);
      log.append(line);
      try {
        const { warnings } = await flattenPage(ctx.projectId, p.page, p.render);
        line.textContent = `${pageName(p.page)}: ${t('publish.letter_done')}${warnings.length ? ` ${tn('publish.letter_warnings', warnings.length)}` : ''}`;
        done += 1;
      } catch (err) {
        line.textContent = `${pageName(p.page)}: ${errorText(err)}`;
        line.className = 'bad';
      }
    }
    toast(tn('publish.letter_flattened', done), { kind: done === todo.length ? 'ok' : 'warn' });
    ctx.refresh();
  };
  const needPlacement = pages.filter((p) => p.needs_placement).length;
  const lettered = pages.filter((p) => p.lettered_file).length;
  return panel(t('publish.lettering_title'),
    h('p', { class: 'muted' }, t('publish.lettering_body')),
    h('ul', { class: 'letter-list' }, pages.map((p) => h('li', null,
      h('strong', null, pageName(p.page)), ' ',
      !p.render ? t('pages.not_drawn')
        : (p.needs_placement ? t('publish.letter_needs_placement')
          : (p.lettered_file ? t('publish.letter_has_file') : t('publish.letter_ready'))))),
    pages.length ? null : h('li', { class: 'muted' }, t('pages.not_drawn'))),
    h('div', { class: 'row' },
      actionButton(t('publish.letter_place'), () => queueOp('lettering.apply', { issue: data.issue }), { kind: needPlacement ? 'primary' : '' }),
      actionButton(lettered ? t('publish.letter_flatten_again') : t('publish.letter_flatten'), flatten,
        { kind: !needPlacement && lettered < todo.length ? 'primary' : '', disabled: !todo.length })),
    log);
}

/**
 * Read a built web edition: the reader itself, in a sandboxed frame (the
 * server serves it sandboxed too, and its page images load inside that
 * sandbox), with a link that opens it in a tab of its own.
 */
function readEdition(exp, title) {
  // The sandbox is set before the address, so the reader never loads without it.
  const frameEl = h('iframe', {
    sandbox: 'allow-scripts', referrerpolicy: 'no-referrer',
    class: 'reader-frame', title: t('publish.reader_frame', { title }), src: exp.url,
  });
  openDialog({
    title,
    wide: true,
    body: h('div', { class: 'reader stack-s' },
      h('div', { class: 'row spread' },
        h('p', { class: 'small muted' }, t('publish.reader_hint')),
        readerTabLink(exp)),
      frameEl),
  });
}

function readerTabLink(exp, { small = true } = {}) {
  return h('a', { class: `btn quiet${small ? ' small' : ''}`, href: exp.url, target: '_blank', rel: 'noopener' },
    icon('open'), h('span', null, t('publish.reader_tab')));
}

function editionCard(ctx, ed, formatLabel) {
  const draft = ed.status === 'draft';
  return h('li', { class: 'edition', dataset: { status: ed.status } },
    h('div', { class: 'row spread' },
      h('h3', null, ed.title || ed.id),
      h('span', { class: `edition-state ${ed.status}` }, tv('edition_status', ed.status, ed.status))),
    h('p', { class: 'small faint', title: ed.id }, `${formatDate(ed.created_at)}. ${tn('publish.edition_pages', ed.pages)}${ed.cover ? `. ${t('publish.with_cover')}` : ''}`),
    draft ? h('p', { class: 'small' }, t('publish.draft_note')) : null,
    draft ? h('div', { class: 'row' }, deleteButton(ctx, { kind: 'edition', id: ed.id }, { label: t('publish.delete_draft') })) : null,
    ed.changes && ed.changes.length ? h('ul', { class: 'bullets small' }, ed.changes.map((c) => h('li', null, typeof c === 'string' ? c : JSON.stringify(c)))) : null,
    ed.exports && ed.exports.length
      ? h('ul', { class: 'export-list' }, ed.exports.map((exp) => {
        const label = formatLabel(exp.format);
        return h('li', null,
          h('span', { class: 'grow' }, h('strong', null, label),
            exp.draft ? h('span', { class: 'draft-mark' }, ` ${t('publish.draft_mark')}`) : null,
            h('span', { class: 'faint small' }, exp.exists ? ` ${formatBytes(exp.bytes)}` : ` ${t('publish.file_missing')}`)),
          exp.exists && exp.browsable
            ? button(t('publish.open_reader'), { small: true, onclick: () => readEdition(exp, ed.title || ed.id) })
            : null,
          exp.exists && exp.browsable ? readerTabLink(exp) : null,
          exp.exists && exp.download_url
            ? h('a', { class: 'btn small', href: exp.download_url, download: '' }, t('action.download'))
            : null);
      }))
      : h('p', { class: 'muted small' }, t('publish.no_files')));
}

export function view(ctx, data) {
  ctx.title = t('screen.publish');
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const ready = data.readiness;
  const next = data.next_edition;
  const chosen = ctx.ui.formats || (ctx.ui.formats = new Set(['pdf', 'cbz']));

  if (!ready.draft_possible && !data.editions.length) {
    return h('div', { class: 'screen' },
      screenHead({ title: t('screen.publish'), lede: t('publish.lede') }),
      issueBar(ctx, data.issue),
      emptyState(t('publish.empty_title'), t('publish.empty_body'), h('a', { class: 'btn primary', href: `${base}/pages?issue=${encodeURIComponent(data.issue)}` }, t('screen.pages'))));
  }

  const formatBoxes = h('fieldset', { class: 'format-list' }, h('legend', null, t('publish.formats')),
    data.formats.map((f) => {
      const id = nextId('fmt');
      const box = h('input', { type: 'checkbox', id, checked: chosen.has(f.id) });
      box.addEventListener('change', () => { if (box.checked) chosen.add(f.id); else chosen.delete(f.id); });
      return h('div', { class: 'check' }, box, h('div', null,
        h('label', { for: id }, f.label || f.id),
        h('p', { class: 'hint' }, tv('pubformat_hint', f.id, ''))));
    }));

  const build = (mode) => async () => {
    if (!chosen.size) {
      toast(t('publish.need_format'), { kind: 'warn' });
      return;
    }
    await queueOp('publish.build', { issue: data.issue, formats: [...chosen], mode });
  };

  const blockers = ready.blockers || [];
  const formatLabel = (id) => (data.formats.find((f) => f.id === id) || {}).label || id;
  const text = h('div', { class: 'stack' },
    newsBar('publish'),
    jobsFor((j) => j.op === 'publish.build' || j.op === 'lettering.apply'),
    h('section', { class: `panel stack-s readiness ${ready.final_possible ? 'ok' : 'wait'}` },
      h('h2', { class: 'panel-title' }, ready.final_possible ? t('publish.ready_final') : t('publish.ready_draft')),
      blockers.length
        ? h('div', { class: 'stack-s' },
          h('p', null, tn('publish.blockers', blockers.length)),
          h('ul', { class: 'blockers' }, blockers.map((b) => h('li', null,
            b.page ? h('a', { href: `${base}/${b.code === 'continuity' ? 'pages' : 'check'}/${b.page}` }, pageName(b.page)) : null,
            b.page ? ': ' : '',
            b.message || b.code))))
        : h('p', { class: 'muted' }, t('publish.no_blockers')),
      h('p', { class: 'small muted' }, ready.note || t('publish.final_meaning'))),
    data.lettering.mode === 'overlay' ? letteringPanel(ctx, data) : null,
    panel(t('publish.build_title'),
      formatBoxes,
      next && next.reuses ? notice('info', t('publish.reuses', { edition: next.reuses })) : null,
      h('div', { class: 'row' },
        ready.final_possible
          ? [actionButton(t('publish.build_final'), build('final'), { kind: 'primary' }),
            actionButton(t('publish.build_draft'), build('draft'), { kind: 'quiet' })]
          : actionButton(t('publish.build_draft'), build('draft'), { kind: 'primary', disabled: !ready.draft_possible })),
      h('p', { class: 'small muted' }, t('publish.build_hint'))));

  const shipItems = next ? [
    next.cover && next.cover.image ? { id: 'cover', label: t('cover.name'), image: next.cover.image } : null,
    ...next.pages.filter((p) => p.image).map((p) => ({ id: p.page, label: `${pageName(p.page)}, ${versionName(p.render)}`, image: p.image })),
  ].filter(Boolean) : [];

  const images = h('div', { class: 'stack' },
    shipItems.length ? h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, t('publish.ships_title')),
      h('ul', { class: 'ship-row' }, shipItems.map((it) => h('li', null,
        h('button', { type: 'button', class: 'thumb', onclick: () => openViewer(shipItems, it.id, { title: t('publish.ships_title') }), 'aria-label': it.label },
          h('img', { src: it.image.url, alt: '' }), h('span', null, it.label))))),
      !next.cover ? h('p', { class: 'small muted' }, t('publish.no_cover'), ' ', h('a', { href: `${base}/cover` }, t('screen.cover'))) : null) : null,
    h('section', { class: 'stack-s' },
      h('h2', { class: 'panel-title' }, t('publish.editions_title')),
      data.editions.length
        ? h('ul', { class: 'edition-list' }, data.editions.map((ed) => editionCard(ctx, ed, formatLabel)))
        : h('p', { class: 'muted' }, t('publish.no_editions'))));

  return h('div', { class: 'screen' },
    screenHead({ title: t('screen.publish'), lede: t('publish.lede'), actions: data.editions.length > 1 ? [cleanupButton(ctx, `publish:${data.issue}`)] : null }),
    issueBar(ctx, data.issue),
    bench(ctx, { text, images, chat: { key: data.chat_key } }));
}
