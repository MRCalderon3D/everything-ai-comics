// The editor of one text file of the project. A simple artifact gets a form
// generated from its schema; everything else is edited as plain text. "Show
// the file" always gives the raw YAML or Markdown. Saving shows what the
// schema says about the result.

import { h, mount } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { button, actionButton, notice } from '/js/components/ui.js';
import { buildForm, formable } from '/js/components/schema-form.js';
import { openDialog } from '/js/components/dialog.js';
import { toast } from '/js/components/toast.js';

const schemas = new Map();

export function loadSchema(name) {
  if (!schemas.has(name)) {
    schemas.set(name, api.schema(name).then((r) => r.schema).catch((err) => {
      schemas.delete(name);
      throw err;
    }));
  }
  return schemas.get(name);
}

export function findingsList(findings) {
  if (!findings || !findings.length) return null;
  return notice('warn',
    h('p', null, h('strong', null, tn('editor.findings', findings.length))),
    h('ul', { class: 'findings' }, findings.map((f) => h('li', null,
      f.path ? h('code', null, f.path) : null, f.path ? ' ' : null, f.message))),
    h('p', { class: 'small' }, t('editor.findings_hint')));
}

/** Findings of check-continuity.js: plan files that disagree with each other. */
export function continuityList(items) {
  if (!items || !items.length) return null;
  return h('ul', { class: 'findings' }, items.map((f) => h('li', { dataset: { severity: f.severity || 'error' } },
    h('strong', null, f.severity === 'warning' ? t('mech.warning') : t('mech.error')), ' ',
    [f.page, f.panel, f.entity].filter(Boolean).length ? h('code', null, [f.page, f.panel, f.entity].filter(Boolean).join(' · ')) : null, ' ',
    f.message,
    f.hint ? h('span', { class: 'muted' }, ` ${f.hint}`) : null)));
}

/**
 * docEditor(ctx, doc, { key, title, form, readonly, onSaved })
 *   doc      a text document of the API
 *   form     false to never offer the form (the screen has its own view)
 *   readonly a sentence that says why the file cannot be changed
 */
export function docEditor(ctx, doc, { key, title, form = true, readonly, onSaved, rows = 16, startInFile = false } = {}) {
  const id = `doc:${key || doc.path}`;
  const s = ctx.ui[id] || (ctx.ui[id] = { mode: null, edits: null, result: null });
  // What the last save said holds only for the version it saved.
  if (s.result && s.result.etag !== doc.etag) s.result = null;
  let current = doc;
  let formApi = null;
  let dirty = false;
  const canForm = form && doc.kind === 'yaml' && doc.schema && doc.data && !doc.parse_error && !readonly;
  if (!s.mode) s.mode = canForm && !startInFile ? 'form' : 'file';
  if (!canForm) s.mode = 'file';

  const body = h('div', { class: 'doc-body' });
  const status = h('div', { class: 'doc-status' });
  const area = h('textarea', {
    class: 'file-text doc-text', rows, spellcheck: doc.kind !== 'yaml', readOnly: !!readonly,
    'aria-label': t('editor.file_label', { path: doc.path }),
  });
  area.dataset.keep = `${ctx.path}#${id}`;

  const setDirty = (value) => {
    dirty = value;
    ctx.setDirty(id, value);
    saveBtn.disabled = !value;
    discardBtn.hidden = !value;
  };

  const showResult = () => {
    const r = s.result;
    const nodes = [];
    if (current.parse_error) {
      nodes.push(notice('bad', t('editor.parse_error', { line: current.parse_error.line || '?', message: current.parse_error.message })));
    }
    const findings = r ? r.findings : current.findings;
    const list = findingsList(findings);
    if (list) nodes.push(list);
    if (r && r.continuity && r.continuity.length) {
      nodes.push(notice('warn', h('p', null, h('strong', null, t('editor.continuity_title'))), continuityList(r.continuity)));
    }
    if (r && r.saved && !list && !(r.continuity && r.continuity.length)) {
      nodes.push(notice('ok', doc.schema ? t('editor.saved_clean') : t('editor.saved_plain')));
    }
    if (r && r.error) nodes.push(r.error);
    mount(status, nodes);
  };

  const paint = () => {
    if (s.mode === 'form') {
      mount(body, h('p', { class: 'muted small' }, t('state.loading')));
      loadSchema(doc.schema).then((schema) => {
        if (s.mode !== 'form') return;
        if (!formable(schema)) {
          s.mode = 'file';
          paint();
          return;
        }
        formApi = buildForm(schema, current.data, () => setDirty(true));
        mount(body, formApi.el);
      }).catch((err) => {
        s.mode = 'file';
        paint();
        toast(errorText(err), { kind: 'bad' });
      });
    } else {
      formApi = null;
      area.value = current.text;
      mount(body, area, doc.kind === 'yaml' && canForm ? h('p', { class: 'hint' }, t('editor.file_hint')) : null);
    }
    if (toggle) {
      toggle.setAttribute('aria-pressed', String(s.mode === 'file'));
    }
  };

  area.addEventListener('input', () => setDirty(true));

  async function save(overrideEtag) {
    const payload = { path: doc.path, base_etag: overrideEtag !== undefined ? overrideEtag : current.etag };
    if (s.mode === 'form' && formApi) payload.data = formApi.value();
    else payload.text = area.value;
    try {
      const res = await api.saveFile(ctx.projectId, payload);
      current = res.file;
      s.result = { saved: res.saved, findings: res.findings, continuity: res.continuity, etag: res.file.etag };
      setDirty(false);
      paint();
      showResult();
      toast(res.saved ? t('editor.saved') : t('editor.unchanged'), { kind: res.saved ? 'ok' : 'info' });
      if (onSaved) onSaved(res);
    } catch (err) {
      if (err.code === 'file_changed') {
        const etag = err.details && err.details.etag;
        s.result = {
          error: notice('bad', h('p', null, t('editor.file_changed')),
            h('div', { class: 'row' },
              actionButton(t('editor.load_theirs'), async () => {
                const { file } = await api.file(ctx.projectId, doc.path);
                current = file;
                s.result = null;
                setDirty(false);
                paint();
                showResult();
              }, { small: true }),
              actionButton(t('editor.keep_mine'), () => save(etag), { small: true, kind: 'quiet' }))),
        };
      } else if (err.code === 'yaml_parse' || err.code === 'yaml_empty') {
        const line = err.details && err.details.line;
        s.result = { error: notice('bad', t('editor.yaml_refused', { message: err.message })) };
        if (line && s.mode === 'file') {
          const lines = area.value.split('\n');
          const start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
          area.focus();
          area.setSelectionRange(start, start + (lines[line - 1] || '').length);
        }
      } else {
        s.result = { error: notice('bad', errorText(err)) };
      }
      showResult();
    }
  }

  const saveBtn = actionButton(t('action.save'), () => save(), { kind: 'primary', icon: 'check' });
  const discardBtn = button(t('editor.discard'), {
    kind: 'quiet',
    onclick: () => {
      s.result = null;
      setDirty(false);
      paint();
      showResult();
    },
  });
  const toggle = canForm ? h('button', {
    type: 'button', class: 'btn small quiet', 'aria-pressed': 'false',
    onclick: () => {
      if (dirty) {
        // Carry the edits across: the form's data cannot become text here, so save or discard first.
        toast(t('editor.switch_needs_save'), { kind: 'warn' });
        return;
      }
      s.mode = s.mode === 'form' ? 'file' : 'form';
      paint();
    },
  }, t('editor.show_file')) : null;

  setDirty(false);
  paint();
  showResult();

  return h('div', { class: 'doc' },
    h('div', { class: 'doc-head' },
      h('div', { class: 'grow' },
        title ? h('h3', null, title) : null,
        h('div', { class: 'doc-path faint small' }, doc.path, doc.exists ? '' : ` · ${t('editor.not_written')}`)),
      toggle),
    readonly ? notice('info', readonly) : null,
    body,
    status,
    readonly ? null : h('div', { class: 'row doc-actions' }, saveBtn, discardBtn));
}

/** Open any text file of the project in a dialog, read only. */
export async function showFile(projectId, path) {
  const dialog = openDialog({ title: path, wide: true, body: h('p', { class: 'muted' }, t('state.loading')) });
  try {
    const { file } = await api.file(projectId, path);
    dialog.setBody(file.exists
      ? h('pre', { class: 'file-view', tabIndex: 0 }, file.text)
      : h('p', { class: 'muted' }, t('editor.file_gone')));
  } catch (err) {
    dialog.setBody(h('p', { class: 'muted' }, err.code === 'not_text' ? t('editor.not_text') : errorText(err)),
      h('p', null, h('a', { href: `/api/projects/${encodeURIComponent(projectId)}/raw/${path.split('/').map(encodeURIComponent).join('/')}`, target: '_blank', rel: 'noopener' }, t('editor.open_raw'))));
  }
}
