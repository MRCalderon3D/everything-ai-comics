// A form generated from a JSON Schema, for the artifacts that are simple
// enough to edit that way (the story bible, a character, a cover). It edits a
// copy of the parsed YAML and hands back the whole document, so fields the
// form does not know stay as they were.

import { h, icon, nextId } from '/js/dom.js';
import { t, tv, getLang } from '/js/i18n.js';

const SHORT = new Set(['id', 'name', 'title', 'age', 'role', 'genre', 'language', 'issue', 'number', 'order',
  'source_ref', 'replaces', 'time_of_day', 'location', 'character', 'wardrobe', 'speaker', 'label', 'type']);
// Fields the pipeline writes. They stay editable, out of the way.
const MANAGED = new Set(['id', 'references', 'wardrobe_file', 'map_file', 'status', 'approved_render', 'issue',
  'character', 'location', 'default_wardrobe', 'first_appearance', 'visually_adjacent_to', 'source_span']);

function humanize(key) {
  const text = String(key).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function labelOf(key) {
  return tv('field', key, humanize(key));
}

/** The name of one entry of a list: 'Fact' for the list 'Facts'. */
function itemLabelOf(key, fallback) {
  return tv('item', key, fallback);
}

function hintOf(schema) {
  // The schemas describe their fields in English only.
  return getLang() === 'en' && schema && schema.description ? schema.description : null;
}

function typeOf(schema) {
  if (!schema) return { type: null, nullable: false };
  if (schema.enum) return { type: 'enum', nullable: schema.enum.includes(null) };
  if (Array.isArray(schema.type)) {
    const real = schema.type.filter((x) => x !== 'null');
    return { type: real.length === 1 ? real[0] : null, nullable: schema.type.includes('null') };
  }
  return { type: schema.type || null, nullable: false };
}

function blank(schema) {
  const { type, nullable } = typeOf(schema);
  if (schema && schema.default !== undefined) return schema.default;
  if (nullable) return null;
  if (type === 'enum') return schema.enum[0];
  if (type === 'string') return '';
  if (type === 'integer' || type === 'number') return schema.minimum !== undefined ? schema.minimum : 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') {
    const out = {};
    for (const key of schema.required || []) out[key] = blank((schema.properties || {})[key]);
    return out;
  }
  return null;
}

/** Let a textarea be as tall as its text, up to a limit. */
export function autoGrow(area) {
  const fit = () => {
    area.style.setProperty('height', 'auto');
    area.style.setProperty('height', `${Math.min(area.scrollHeight + 2, 420)}px`);
  };
  area.addEventListener('input', fit);
  requestAnimationFrame(fit);
}

/**
 * buildForm(schema, data, onChange) -> { el, value() }
 * onChange is called after every edit.
 */
export function buildForm(schema, data, onChange) {
  const root = { value: JSON.parse(JSON.stringify(data === null || data === undefined ? {} : data)) };
  const changed = () => onChange && onChange(root.value);

  function scalar(schema, key, get, set, required, labelText, compact) {
    const { type, nullable } = typeOf(schema);
    const id = nextId('sf');
    const hint = compact ? null : hintOf(schema);
    const hintId = hint ? `${id}-h` : null;
    let control;
    const current = get();
    if (type === 'enum') {
      const options = schema.enum.filter((v) => v !== null);
      control = h('select', { id },
        (!required || nullable || !options.includes(current)) ? h('option', { value: '' }, t('form.none')) : null,
        options.map((v) => h('option', { value: String(v), selected: v === current }, tv('value', v, humanize(v)))));
      if (current === null || current === undefined) control.value = '';
      control.addEventListener('change', () => {
        const picked = options.find((v) => String(v) === control.value);
        set(picked === undefined ? (nullable ? null : undefined) : picked);
        changed();
      });
    } else if (type === 'boolean') {
      control = h('input', { id, type: 'checkbox', checked: !!current });
      control.addEventListener('change', () => { set(control.checked); changed(); });
      return h('div', { class: 'check' }, control, h('div', null, h('label', { for: id }, labelText), hint ? h('p', { class: 'hint' }, hint) : null));
    } else if (type === 'integer' || type === 'number') {
      control = h('input', { id, type: 'number', min: schema.minimum, max: schema.maximum, step: type === 'integer' ? 1 : 'any' });
      control.value = current === null || current === undefined ? '' : String(current);
      control.addEventListener('input', () => {
        const n = control.value === '' ? null : Number(control.value);
        set(n === null || Number.isNaN(n) ? (nullable ? null : undefined) : n);
        changed();
      });
    } else {
      const long = !schema.pattern && !SHORT.has(key);
      control = long ? h('textarea', { id, rows: 2 }) : h('input', { id, type: 'text' });
      control.value = current === null || current === undefined ? '' : String(current);
      if (long) autoGrow(control);
      control.addEventListener('input', () => {
        const text = control.value;
        if (text === '' && nullable) set(null);
        else if (text === '' && !required) set(undefined);
        else set(text);
        changed();
      });
    }
    if (hintId) control.setAttribute('aria-describedby', hintId);
    if (compact) {
      control.setAttribute('aria-label', labelText);
      return control;
    }
    return h('div', { class: 'field' }, h('label', { for: id }, labelText), control, hint ? h('p', { class: 'hint', id: hintId }, hint) : null);
  }

  function list(schema, key, get, set, labelText) {
    const items = schema.items || {};
    const itemType = typeOf(items).type;
    const one = itemLabelOf(key, labelText);
    const body = h('div', { class: 'sf-list' });
    const paint = () => {
      const arr = Array.isArray(get()) ? get() : [];
      body.replaceChildren(...arr.map((item, index) => {
        const remove = h('button', {
          type: 'button', class: 'btn icon-only quiet', 'aria-label': t('form.remove_item', { name: one, n: index + 1 }), title: t('form.remove'),
          onclick: () => { arr.splice(index, 1); set(arr); changed(); paint(); },
        }, icon('close'));
        if (itemType === 'object') {
          return h('div', { class: 'sf-item' },
            h('div', { class: 'sf-item-head' }, h('span', { class: 'sf-item-n' }, `${one} ${index + 1}`), remove),
            object(items, () => arr[index], (v) => { arr[index] = v; }, false));
        }
        return h('div', { class: 'sf-row' },
          scalar(items, key, () => arr[index], (v) => { arr[index] = v === undefined ? '' : v; }, true, `${one} ${index + 1}`, true),
          remove);
      }));
    };
    const add = h('button', {
      type: 'button', class: 'btn small quiet',
      onclick: () => {
        const arr = Array.isArray(get()) ? get() : [];
        arr.push(blank(items));
        set(arr);
        changed();
        paint();
        const first = body.lastElementChild && body.lastElementChild.querySelector('input, textarea, select');
        if (first) first.focus();
      },
    }, icon('plus'), h('span', null, t('form.add_item', { name: one })));
    paint();
    const hint = hintOf(schema);
    return h('fieldset', { class: 'sf-group' }, h('legend', null, labelText), hint ? h('p', { class: 'hint' }, hint) : null, body, add);
  }

  function fallback(key, get, set, labelText) {
    const id = nextId('sf');
    const area = h('textarea', { id, rows: 4, class: 'file-text' });
    area.value = JSON.stringify(get() === undefined ? null : get(), null, 2);
    const problem = h('p', { class: 'hint bad', hidden: true }, t('form.json_invalid'));
    area.addEventListener('input', () => {
      try {
        set(JSON.parse(area.value));
        problem.hidden = true;
        changed();
      } catch (err) {
        problem.hidden = false;
      }
    });
    return h('div', { class: 'field' }, h('label', { for: id }, labelText), area, h('p', { class: 'hint' }, t('form.json_hint')), problem);
  }

  function node(schema, key, get, set, required) {
    const { type } = typeOf(schema);
    const labelText = labelOf(key);
    if (type === 'array') {
      const itemType = typeOf(schema.items || {}).type;
      if (['string', 'integer', 'number', 'enum', 'object'].includes(itemType)) return list(schema, key, get, set, labelText);
      return fallback(key, get, set, labelText);
    }
    if (type === 'object') {
      if (!schema.properties) return fallback(key, get, set, labelText);
      const hint = hintOf(schema);
      return h('fieldset', { class: 'sf-group' }, h('legend', null, labelText), hint ? h('p', { class: 'hint' }, hint) : null,
        object(schema, get, set, false));
    }
    if (type === null) return fallback(key, get, set, labelText);
    return scalar(schema, key, get, set, required, labelText, false);
  }

  function object(schema, get, set, top) {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const ensure = () => {
      let obj = get();
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        obj = {};
        set(obj);
      }
      return obj;
    };
    const main = [];
    const managed = [];
    for (const [key, sub] of Object.entries(props)) {
      if (sub.const !== undefined) continue;
      const el = node(sub, key,
        () => { const obj = get(); return obj && typeof obj === 'object' ? obj[key] : undefined; },
        (v) => { const obj = ensure(); if (v === undefined) delete obj[key]; else obj[key] = v; },
        required.has(key));
      (top && MANAGED.has(key) ? managed : main).push(el);
    }
    return h('div', { class: 'sf-object' }, main,
      managed.length ? h('details', { class: 'disclosure sf-managed' }, h('summary', null, t('form.managed_fields')),
        h('div', { class: 'disclosure-body' }, h('p', { class: 'hint' }, t('form.managed_hint')), managed)) : null);
  }

  const el = h('div', { class: 'schema-form' }, object(schema, () => root.value, (v) => { root.value = v; }, true));
  return { el, value: () => root.value };
}

/** Whether a schema is one this form can show in full. */
export function formable(schema) {
  return !!(schema && typeOf(schema).type === 'object' && schema.properties);
}
