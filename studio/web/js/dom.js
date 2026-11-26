// Small DOM helpers. Everything on screen is built with h(): no HTML strings,
// so no text from a file or from the AI is ever parsed as markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

function append(el, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) append(el, c);
    return;
  }
  el.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

/**
 * h('button', { class: 'btn', onclick: fn, disabled: true }, 'Save')
 * Attributes: class, dataset (object), on<event> (function), any property
 * that exists on the element (value, checked, disabled), else an attribute.
 * null, undefined and false attributes are skipped.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'for') el.htmlFor = value;
      else if (key.startsWith('aria-') || key === 'role' || key === 'list' || key === 'type') el.setAttribute(key, value === true ? 'true' : String(value));
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

const ICONS = {
  plus: 'M8 2v12M2 8h12',
  close: 'M3 3l10 10M13 3L3 13',
  check: 'M2.5 8.5l3.5 3.5 7.5-8',
  alert: 'M8 2l6.5 11.5h-13zM8 6.5v3.2M8 11.6v.4',
  left: 'M10 2.5L4.5 8l5.5 5.5',
  right: 'M6 2.5L11.5 8 6 13.5',
  down: 'M2.5 5.5L8 11l5.5-5.5',
  chat: 'M2 3h12v8H7l-3.5 3v-3H2z',
  queue: 'M2 4h12M2 8h12M2 12h8',
  gear: 'M2 4.5h6M11 4.5h3M9.5 3v3M2 11.5h3M8 11.5h6M6.5 10v3',
  sun: 'M8 5a3 3 0 100 6 3 3 0 000-6zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3',
  moon: 'M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5',
  download: 'M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11',
  open: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4',
  upload: 'M8 11V3M4.5 6L8 2.5 11.5 6M2.5 13.5h11',
  zoom: 'M7 2.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM10.3 10.3l3.2 3.2',
  clock: 'M8 2a6 6 0 100 12A6 6 0 008 2zM8 4.5V8l2.5 1.5',
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
  copy: 'M5.5 5.5h8v8h-8zM2.5 10.5v-8h8',
};

/** A 16 px line icon. Decorative unless a label is given. */
export function icon(name, label) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] || ICONS.alert);
  svg.append(path);
  return svg;
}

let uid = 0;
/** A unique id for wiring labels to controls. */
export function nextId(prefix = 'f') {
  uid += 1;
  return `${prefix}${uid}`;
}

/** Elements that can take focus inside a container, in order. */
export function focusables(root) {
  return [...root.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/** Keep Tab inside a dialog while it is open. Returns a function that stops it. */
export function trapFocus(root) {
  function onKey(event) {
    if (event.key !== 'Tab') return;
    const list = focusables(root);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}
