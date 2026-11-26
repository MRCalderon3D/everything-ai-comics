// Buttons, fields, notices and tabs: the small parts every screen uses.

import { h, icon, nextId } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { errorText } from '/js/api.js';
import { toast } from '/js/components/toast.js';

/** button('Save', { kind: 'primary', icon: 'check', onclick }) */
export function button(label, { kind = '', icon: iconName, onclick, disabled, title, type = 'button', small, describedBy } = {}) {
  return h('button', {
    type,
    class: `btn ${kind}${small ? ' small' : ''}`.trim(),
    onclick,
    disabled: !!disabled,
    title,
    'aria-describedby': describedBy,
  }, iconName ? icon(iconName) : null, h('span', null, label));
}

/** A button with only an icon; the label is read by screen readers and shown as a tooltip. */
export function iconButton(iconName, label, { onclick, kind = '', pressed, expanded, disabled } = {}) {
  return h('button', {
    type: 'button',
    class: `btn icon-only ${kind}`.trim(),
    onclick,
    title: label,
    disabled: !!disabled,
    'aria-label': label,
    'aria-pressed': pressed === undefined ? null : String(pressed),
    'aria-expanded': expanded === undefined ? null : String(expanded),
  }, icon(iconName));
}

/**
 * A button whose action is asynchronous: it is disabled while the action
 * runs and a failure is shown, never swallowed.
 */
export function actionButton(label, action, options = {}) {
  const btn = button(label, options);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      await action();
    } catch (err) {
      if (options.onError) options.onError(err);
      else toast(errorText(err), { kind: 'bad' });
    } finally {
      // The button may already be gone after a refresh of the screen.
      btn.disabled = !!options.disabled;
      btn.classList.remove('busy');
    }
  });
  return btn;
}

function wrapField(id, label, control, { hint, optional } = {}) {
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field' },
    h('label', { for: id }, label, optional ? h('span', { class: 'optional' }, ` ${t('form.optional')}`) : null),
    control,
    hint ? h('p', { class: 'hint', id: hintId }, hint) : null);
}

/**
 * A text field. With `draft` (from ctx.draft) the text survives refreshes and
 * reloads. Returns { el, input, value }.
 */
export function textField({ label, value = '', draft, placeholder, required, multiline, rows = 4, maxlength, type = 'text', hint, optional, oninput, min, max, readonly, autofocus } = {}) {
  const id = nextId('in');
  const initial = draft ? draft.get() || value : value;
  const input = multiline
    ? h('textarea', { id, rows, placeholder, required: !!required, maxLength: maxlength || undefined, readOnly: !!readonly }, initial)
    : h('input', { id, type, placeholder, required: !!required, maxLength: maxlength || undefined, min, max, readOnly: !!readonly });
  if (!multiline) input.value = initial === null || initial === undefined ? '' : String(initial);
  if (draft) input.dataset.keep = draft.key;
  if (autofocus) input.autofocus = true;
  input.addEventListener('input', () => {
    if (draft) draft.set(input.value);
    if (oninput) oninput(input.value);
  });
  return {
    el: wrapField(id, label, input, { hint, optional }),
    input,
    get value() { return input.value; },
    set value(v) {
      input.value = v;
      if (draft) draft.set(v);
    },
    clear() {
      input.value = '';
      if (draft) draft.clear();
    },
  };
}

/** options: [{ value, label }] */
export function selectField({ label, value, options, hint, onchange, optional, disabled } = {}) {
  const id = nextId('sel');
  const select = h('select', { id, disabled: !!disabled },
    options.map((o) => h('option', { value: o.value === null ? '' : String(o.value), selected: String(o.value === null ? '' : o.value) === String(value === null || value === undefined ? '' : value) }, o.label)));
  if (onchange) select.addEventListener('change', () => onchange(select.value));
  return { el: wrapField(id, label, select, { hint, optional }), input: select, get value() { return select.value; } };
}

export function checkField({ label, checked, hint, onchange, disabled, draft } = {}) {
  const id = nextId('chk');
  const start = draft ? (draft.get() === '' ? !!checked : draft.get() === '1') : !!checked;
  const input = h('input', { id, type: 'checkbox', checked: start, disabled: !!disabled });
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);
  input.addEventListener('change', () => {
    if (draft) draft.set(input.checked ? '1' : '0');
    if (onchange) onchange(input.checked);
  });
  return {
    el: h('div', { class: 'check' }, input, h('div', null, h('label', { for: id }, label), hint ? h('p', { class: 'hint', id: hintId }, hint) : null)),
    input,
    get value() { return input.checked; },
  };
}

/** A set of radio buttons. options: [{ value, label, hint }] */
export function radioField({ legend, name = nextId('rad'), value, options, onchange } = {}) {
  let chosen = value;
  const el = h('fieldset', { class: 'radios' }, h('legend', null, legend),
    options.map((o) => {
      const id = nextId('r');
      return h('div', { class: 'check' },
        h('input', { id, type: 'radio', name, value: String(o.value), checked: String(o.value) === String(value), onchange: () => { chosen = o.value; if (onchange) onchange(o.value); } }),
        h('div', null, h('label', { for: id }, o.label), o.hint ? h('p', { class: 'hint' }, o.hint) : null));
    }));
  return { el, get value() { return chosen; } };
}

/** kind: info | warn | bad | ok | next. A notice says something in words; colour only supports it. */
export function notice(kind, ...children) {
  return h('div', { class: `notice ${kind}`, role: kind === 'bad' ? 'alert' : null }, children);
}

/** The yellow caption box: the one thing to do next. */
export function caption(...children) {
  return h('div', { class: 'caption-box' }, children);
}

export function emptyState(title, text, ...actions) {
  return h('div', { class: 'empty' },
    h('h3', null, title),
    text ? h('p', null, text) : null,
    actions.length ? h('div', { class: 'row' }, actions) : null);
}

/**
 * Tabs that remember which one is open across refreshes of the screen.
 * items: [{ id, label, render: () => Node, count }]
 */
export function tabs(ctx, key, items, { label } = {}) {
  const live = items.filter(Boolean);
  if (!live.length) return h('div');
  const stateKey = `tab:${key}`;
  if (!live.some((i) => i.id === ctx.ui[stateKey])) ctx.ui[stateKey] = live[0].id;
  const panel = h('div', { class: 'tab-panel', role: 'tabpanel', tabIndex: 0 });
  const buttons = [];
  function select(id, focus) {
    ctx.ui[stateKey] = id;
    for (const b of buttons) {
      const on = b.dataset.tab === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
      if (on) panel.setAttribute('aria-labelledby', b.id);
    }
    const item = live.find((i) => i.id === id);
    panel.replaceChildren(item.render());
  }
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': label || null },
    live.map((item) => {
      const b = h('button', { type: 'button', role: 'tab', id: nextId('tab'), dataset: { tab: item.id }, onclick: () => select(item.id) },
        item.label, item.count ? h('span', { class: 'count' }, String(item.count)) : null);
      buttons.push(b);
      return b;
    }));
  list.addEventListener('keydown', (event) => {
    const at = live.findIndex((i) => i.id === ctx.ui[stateKey]);
    let to = null;
    if (event.key === 'ArrowRight') to = (at + 1) % live.length;
    else if (event.key === 'ArrowLeft') to = (at - 1 + live.length) % live.length;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = live.length - 1;
    if (to === null) return;
    event.preventDefault();
    select(live[to].id, true);
  });
  select(ctx.ui[stateKey]);
  return h('div', { class: 'tabset' }, list, panel);
}

/** A panel with a heading: the basic container of a screen. */
export function panel(title, ...children) {
  return h('section', { class: 'panel' }, title ? h('h2', { class: 'panel-title' }, title) : null, children);
}

/** details/summary that remembers whether it is open. */
export function disclosure(ctx, key, summary, build, { open = false } = {}) {
  const stateKey = `open:${key}`;
  if (ctx.ui[stateKey] === undefined) ctx.ui[stateKey] = open;
  const body = h('div', { class: 'disclosure-body' });
  let built = false;
  const el = h('details', { class: 'disclosure', open: ctx.ui[stateKey] }, h('summary', null, summary), body);
  const fill = () => {
    if (built) return;
    built = true;
    body.append(build());
  };
  if (ctx.ui[stateKey]) fill();
  el.addEventListener('toggle', () => {
    ctx.ui[stateKey] = el.open;
    if (el.open) fill();
  });
  return el;
}

/** "Copy" for a prompt: says when it worked. */
export function copyButton(getText) {
  return actionButton(t('action.copy'), async () => {
    await navigator.clipboard.writeText(getText());
    toast(t('toast.copied'));
  }, { icon: 'copy', small: true, kind: 'quiet' });
}

/** A definition list from pairs; empty values are left out. */
export function facts(pairs) {
  const rows = pairs.filter((p) => p && p[1] !== null && p[1] !== undefined && p[1] !== '');
  return h('dl', { class: 'facts' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}
