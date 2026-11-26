// Publish: choose formats, see what blocks a final edition, build a draft or
// a final one, download each file, open the web reader. With overlay
// lettering the browser flattens each page and sends the image back.

import { h, nextId } from '/js/dom.js';
import { t, tn, tv, formatBytes, formatDate } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, notice, emptyState } from '/js/components/ui.js';
import { queueOp } from '/js/components/ask.js';
import { jobsFor } from '/js/components/jobs.js';
import { openViewer } from '/js/components/viewer.js';
import { toast } from '/js/components/toast.js';
import { pageName, versionName } from '/js/labels.js';
import { has } from '/js/i18n.js';

export async function load(ctx) {
  const issue = state.issue || 'ISS_001';
  return api.publish(ctx.projectId, issue);
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
 * Read a built web edition inside the studio. The page list comes from the
 * reader's own index.html, so what is shown is what the edition ships. The
 * reader itself is not framed: the server sends it sandboxed, and its images
 * are then refused by the same server (see the report of the web agent).
 */
async function readEdition(exp, title) {
  const res = await fetch(exp.url);
  if (!res.ok) throw new Error(t('publish.file_missing'));
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const base = new URL(exp.url, location.href);
  const items = [...doc.querySelectorAll('img[src]')].map((img, index) => {
    const url = new URL(img.getAttribute('src'), base);
    return {
      id: String(index),
      label: img.getAttribute('alt') || String(index + 1),
      image: { url: url.pathname + url.search, width: Number(img.getAttribute('width')) || null, height: Number(img.getAttribute('height')) || null },
    };
  });
  if (!items.length) throw new Error(t('publish.reader_empty'));
  openViewer(items, '0', { title });
}

function editionCard(ed) {
  const draft = ed.status === 'draft';
  return h('li', { class: 'edition', dataset: { status: ed.status } },
    h('div', { class: 'row spread' },
      h('h3', null, ed.title || ed.id),
      h('span', { class: `edition-state ${ed.status}` }, tv('edition_status', ed.status, ed.status))),
    h('p', { class: 'small faint' }, `${ed.id} · ${formatDate(ed.created_at)} · ${tn('publish.edition_pages', ed.pages)}${ed.cover ? ` · ${t('publish.with_cover')}` : ''}`),
    draft ? h('p', { class: 'small' }, t('publish.draft_note')) : null,
    ed.changes && ed.changes.length ? h('ul', { class: 'bullets small' }, ed.changes.map((c) => h('li', null, typeof c === 'string' ? c : JSON.stringify(c)))) : null,
    ed.exports && ed.exports.length
      ? h('ul', { class: 'export-list' }, ed.exports.map((exp) => {
        const label = tv('pubformat', exp.format, exp.format);
        return h('li', null,
          h('span', { class: 'grow' }, h('strong', null, label),
            exp.draft ? h('span', { class: 'draft-mark' }, ` ${t('publish.draft_mark')}`) : null,
            h('span', { class: 'faint small' }, exp.exists ? ` ${formatBytes(exp.bytes)}` : ` ${t('publish.file_missing')}`)),
          exp.exists && exp.browsable
            ? actionButton(t('publish.open_reader'), () => readEdition(exp, ed.title || ed.id), { small: true })
            : null,
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
      emptyState(t('publish.empty_title'), t('publish.empty_body'), h('a', { class: 'btn primary', href: `${base}/pages` }, t('screen.pages'))));
  }

  const formatBoxes = h('fieldset', { class: 'format-list' }, h('legend', null, t('publish.formats')),
    data.formats.map((f) => {
      const id = nextId('fmt');
      const box = h('input', { type: 'checkbox', id, checked: chosen.has(f.id) });
      box.addEventListener('change', () => { if (box.checked) chosen.add(f.id); else chosen.delete(f.id); });
      return h('div', { class: 'check' }, box, h('div', null,
        h('label', { for: id }, tv('pubformat', f.id, f.label)),
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
  const text = h('div', { class: 'stack' },
    jobsFor((j) => j.op === 'publish.build' || j.op === 'lettering.apply'),
    h('section', { class: `panel stack-s readiness ${ready.final_possible ? 'ok' : 'wait'}` },
      h('h2', { class: 'panel-title' }, ready.final_possible ? t('publish.ready_final') : t('publish.ready_draft')),
      blockers.length
        ? h('div', { class: 'stack-s' },
          h('p', null, tn('publish.blockers', blockers.length)),
          h('ul', { class: 'blockers' }, blockers.map((b) => h('li', null,
            b.page ? h('a', { href: `${base}/${b.code === 'continuity' ? 'pages' : 'check'}/${b.page}` }, pageName(b.page)) : null,
            b.page ? ': ' : '',
            has(`publish.blocker.${b.code}`) ? t(`publish.blocker.${b.code}`) : b.message))))
        : h('p', { class: 'muted' }, t('publish.no_blockers')),
      h('p', { class: 'small muted' }, t('publish.final_meaning'))),
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
        ? h('ul', { class: 'edition-list' }, data.editions.map(editionCard))
        : h('p', { class: 'muted' }, t('publish.no_editions'))));

  return h('div', { class: 'screen' },
    screenHead({ title: t('screen.publish'), lede: t('publish.lede') }),
    bench(ctx, { text, images, chat: { key: data.chat_key } }));
}
