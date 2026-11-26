// What a step changed: the files of one commit (or between two), each shown
// the way a person can read it. Images come before and after in the compare
// viewer; text comes as a line diff worked out here in the browser from the
// two versions the server sends.

import { h, icon, mount } from '/js/dom.js';
import { t, tn, tv, formatBytes } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { notice, button } from '/js/components/ui.js';
import { compare, openViewer } from '/js/components/viewer.js';
import { versionName } from '/js/labels.js';

const CONTEXT = 3;
const MAX_ROWS = 600;
const MAX_EDITS = 2000;

function lines(text) {
  if (!text) return [];
  const out = String(text).replace(/\r\n/g, '\n').split('\n');
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * Myers' difference of two arrays of lines. Returns the edit script as
 * [{ type: 'same' | 'add' | 'del', a, b }] with indexes into each side, or
 * null when the two differ in more than `maxEdits` lines.
 */
function myers(a, b, maxEdits) {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace = [];
  for (let d = 0; d <= limit; d += 1) {
    // The furthest x on each diagonal after d - 1 edits, for k in -d-1 .. d+1.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m);
    }
  }
  return null;
}

function backtrack(trace, last, n, m) {
  const out = [];
  let x = n;
  let y = m;
  for (let d = last; d > 0; d -= 1) {
    const vs = trace[d];
    const at = (k) => vs[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    const midX = down ? prevX : prevX + 1;
    while (x > midX) { out.push({ type: 'same', a: x - 1, b: y - 1 }); x -= 1; y -= 1; }
    out.push(down ? { type: 'add', b: prevY } : { type: 'del', a: prevX });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { out.push({ type: 'same', a: x - 1, b: y - 1 }); x -= 1; y -= 1; }
  return out.reverse();
}

/**
 * The line diff of two texts: [{ type, text, a, b }] with line numbers from
 * 1 on each side (null where the line is not on that side), or null when the
 * texts differ too much to show line by line.
 */
export function lineDiff(beforeText, afterText, { maxEdits = MAX_EDITS } = {}) {
  const a = lines(beforeText);
  const b = lines(afterText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const middle = myers(a.slice(start, endA), b.slice(start, endB), maxEdits);
  if (!middle) return null;
  const rows = [];
  for (let i = 0; i < start; i += 1) rows.push({ type: 'same', text: a[i], a: i + 1, b: i + 1 });
  for (const op of middle) {
    if (op.type === 'same') rows.push({ type: 'same', text: a[start + op.a], a: start + op.a + 1, b: start + op.b + 1 });
    else if (op.type === 'del') rows.push({ type: 'del', text: a[start + op.a], a: start + op.a + 1, b: null });
    else rows.push({ type: 'add', text: b[start + op.b], a: null, b: start + op.b + 1 });
  }
  for (let i = endA, j = endB; i < a.length; i += 1, j += 1) rows.push({ type: 'same', text: a[i], a: i + 1, b: j + 1 });
  return rows;
}

/** The rows worth showing: every change with a few lines around it, the rest folded. */
function hunks(rows) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === 'same') return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(rows.length - 1, i + CONTEXT); j += 1) keep[j] = true;
  });
  const out = [];
  let folded = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (folded) out.push({ type: 'fold', n: folded });
      folded = 0;
      out.push(r);
    } else {
      folded += 1;
    }
  });
  if (folded) out.push({ type: 'fold', n: folded });
  return out;
}

const SIGN = { add: '+', del: '−', same: ' ' };

function rowNode(r) {
  if (r.type === 'fold') return h('div', { class: 'dl fold' }, tn('diff.unchanged_lines', r.n));
  return h('div', { class: `dl ${r.type}` },
    h('span', { class: 'ln', 'aria-hidden': 'true' }, r.a === null ? '' : String(r.a)),
    h('span', { class: 'ln', 'aria-hidden': 'true' }, r.b === null ? '' : String(r.b)),
    h('span', { class: 'sign', 'aria-hidden': 'true' }, SIGN[r.type]),
    r.type === 'same' ? null : h('span', { class: 'sr-only' }, r.type === 'add' ? t('diff.line_added') : t('diff.line_removed')),
    h('code', null, r.text === '' ? ' ' : r.text));
}

function fileLinks(file) {
  return h('span', { class: 'row diff-links' },
    file.before_url ? h('a', { class: 'small', href: file.before_url, target: '_blank', rel: 'noopener' }, t('diff.open_before')) : null,
    file.after_url ? h('a', { class: 'small', href: file.after_url, target: '_blank', rel: 'noopener' }, t('diff.open_after')) : null);
}

function textBody(file) {
  const before = file.before;
  const after = file.after;
  if ((before && before.truncated) || (after && after.truncated)) {
    return h('div', { class: 'stack-s' },
      notice('info', t('diff.too_long', { size: formatBytes(Math.max(before ? before.bytes : 0, after ? after.bytes : 0)) })),
      fileLinks(file));
  }
  const rows = lineDiff(before ? before.text : '', after ? after.text : '');
  if (!rows) return h('div', { class: 'stack-s' }, notice('info', t('diff.too_different')), fileLinks(file));
  const added = rows.filter((r) => r.type === 'add').length;
  const removed = rows.filter((r) => r.type === 'del').length;
  if (!added && !removed) return h('p', { class: 'small muted' }, t('diff.same_text'));
  const shown = file.status === 'modified' ? hunks(rows) : rows;
  const cut = shown.length > MAX_ROWS;
  return h('div', { class: 'stack-s' },
    h('p', { class: 'small muted' }, t('diff.counts', { added, removed })),
    h('div', { class: 'diff-lines', tabIndex: 0, role: 'region', 'aria-label': t('diff.lines_label', { path: file.path }) },
      shown.slice(0, MAX_ROWS).map(rowNode)),
    cut ? h('p', { class: 'small muted' }, tn('diff.more_lines', shown.length - MAX_ROWS), ' ', fileLinks(file)) : null);
}

/** The size of an image, read before the compare is built so the slider keeps its shape. */
async function sized(url, label, alt) {
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch (err) { return null; }
  return { id: url, label, alt, image: { url, width: img.naturalWidth || null, height: img.naturalHeight || null } };
}

/**
 * A new version of a page, a cover or a sheet is a new file (PG_001_002_V02.png
 * beside V01), so the diff lists it as added. The version before it, as it
 * was at the start of the step, is what the person wants to compare it with.
 */
function previousVersion(ctxDiff, file) {
  const m = /^(.*_V)(\d{2})(\.(?:png|jpe?g|webp))$/i.exec(file.path);
  if (!m || file.status !== 'added' || file.before_url || !ctxDiff.from) return null;
  const n = Number(m[2]);
  if (n < 2) return null;
  const path = `${m[1]}${String(n - 1).padStart(2, '0')}${m[3]}`;
  return { path, url: api.atRawUrl(ctxDiff.projectId, ctxDiff.from, path) };
}

function imageBody(ctxDiff, file, name) {
  const holder = h('div', { class: 'diff-image' }, h('p', { class: 'small muted' }, t('state.loading')));
  (async () => {
    let before = file.before_url ? await sized(file.before_url, t('diff.before'), t('diff.image_before', { name })) : null;
    const after = file.after_url ? await sized(file.after_url, t('diff.after'), t('diff.image_after', { name })) : null;
    const prev = !before ? previousVersion(ctxDiff, file) : null;
    if (prev && after) {
      const prevName = prev.path.split('/').pop();
      before = await sized(prev.url, `${versionName(prevName.replace(/\.[a-z]+$/i, ''))} (${t('diff.before')})`, t('diff.image_before', { name: prevName }));
      if (before) after.label = `${versionName(name.replace(/\.[a-z]+$/i, ''))} (${t('diff.after')})`;
    }
    const items = [before, after].filter(Boolean);
    if (!items.length) {
      mount(holder, h('p', { class: 'small muted' }, t('diff.image_unreadable')), fileLinks(file));
      return;
    }
    if (before && after) {
      let mode = 'side';
      const stage = h('div');
      const paint = () => mount(stage, compare(before, after, mode));
      const press = (m, label) => {
        const b = h('button', { type: 'button', class: 'btn small quiet', 'aria-pressed': String(mode === m) }, label);
        b.addEventListener('click', () => {
          mode = m;
          for (const other of bar.querySelectorAll('[aria-pressed]')) other.setAttribute('aria-pressed', String(other === b));
          paint();
        });
        return b;
      };
      const bar = h('div', { class: 'row cmp-bar' },
        h('span', { class: 'row', role: 'group', 'aria-label': t('viewer.compare_mode') },
          press('side', t('viewer.side_by_side')), press('slider', t('viewer.slider'))),
        button(t('diff.open_large'), { kind: 'quiet', small: true, icon: 'zoom', onclick: () => openViewer(items, after.id, { title: name }) }));
      paint();
      mount(holder, bar, stage);
    } else {
      const only = items[0];
      mount(holder,
        h('figure', { class: 'diff-single' },
          h('button', { type: 'button', class: 'frame-art', 'aria-label': t('image.open_large', { name }), onclick: () => openViewer(items, only.id, { title: name }) },
            h('img', { src: only.image.url, alt: only.alt })),
          h('figcaption', { class: 'small muted' }, file.status === 'deleted' ? t('diff.image_deleted') : t('diff.image_added'))));
    }
  })();
  return holder;
}

function fileNode(ctxDiff, file, open) {
  const name = file.path.split('/').pop();
  const body = () => {
    if (file.kind === 'image') return imageBody(ctxDiff, file, name);
    if (file.kind === 'text') return textBody(file);
    return h('div', { class: 'stack-s' }, h('p', { class: 'small muted' }, t('diff.other_kind')), fileLinks(file));
  };
  const el = h('details', { class: 'diff-file', open, dataset: { kind: file.kind, status: file.status } },
    h('summary', null,
      h('span', { class: `change ${file.status}` }, tv('change', file.status, file.status)), ' ',
      h('span', { class: 'diff-path' }, file.path)));
  // A body is built the first time the file is opened.
  let built = false;
  const build = () => {
    if (built || !el.open) return;
    built = true;
    el.append(h('div', { class: 'diff-body' }, body()));
  };
  el.addEventListener('toggle', build);
  if (open) build();
  return el;
}

/** Images first, then texts, then the rest; the most telling files open. */
function order(files) {
  const rank = (f) => ({ image: 0, text: 1 }[f.kind] ?? 2);
  return [...files].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

/**
 * changesView(projectId, { commit } | { from, to }) -> a node that loads what
 * that point of the history changed and shows it.
 */
export function changesView(projectId, query) {
  const el = h('div', { class: 'diff', 'aria-live': 'polite' }, h('p', { class: 'small muted' }, t('state.loading')));
  api.diff(projectId, Object.assign({ limit: 100 }, query)).then((res) => {
    const files = order(res.files || []);
    if (!files.length) {
      mount(el, h('p', { class: 'small muted' }, t('diff.nothing')));
      return;
    }
    let opened = 0;
    let images = 0;
    mount(el,
      h('p', { class: 'small muted' }, tn('diff.files', res.total), res.more ? ` ${t('diff.more_files', { shown: files.length })}` : ''),
      files.map((f) => {
        // Images and the first texts open by themselves; the records a step writes stay folded.
        const open = (f.kind === 'image' && images < 4) || (f.kind === 'text' && f.status === 'modified' && opened < 3);
        if (open && f.kind === 'image') images += 1;
        else if (open) opened += 1;
        return fileNode({ projectId, from: res.from }, f, open);
      }));
  }).catch((err) => {
    mount(el, err.code === 'history_unavailable'
      ? notice('info', icon('alert'), ' ', errorText(err))
      : notice('bad', errorText(err)));
  });
  return el;
}
