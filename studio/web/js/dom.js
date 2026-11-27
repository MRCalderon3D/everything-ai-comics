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
  home: 'M2.5 7.5L8 2.5l5.5 5M4 6.5v7h8v-7M6.5 13.5v-4h3v4',
  spark: 'M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4M3.5 3.5l2 2M10.5 10.5l2 2M3.5 12.5l2-2M10.5 5.5l2-2',
  compare: 'M2 3h5v10H2zM9 3h5v10H9z',
  refresh: 'M13 3v3.5H9.5M3 13V9.5h3.5M12.6 6.5A5 5 0 004 5M3.4 9.5A5 5 0 0012 11',
  pen: 'M10.5 2.5l3 3-8 8H2.5v-3z',
  focus: 'M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5',
  up: 'M2.5 10.5L8 5l5.5 5.5',
  // The kinds of lettering (letteringElement.type), one small shape each.
  balloon: 'M8 2.5c3.3 0 6 2 6 4.5s-2.7 4.5-6 4.5c-.6 0-1.2-.1-1.8-.2L3 13.5l.9-2.9C2.7 9.7 2 8.4 2 7c0-2.5 2.7-4.5 6-4.5z',
  thought: 'M8 2.5c3.3 0 6 1.8 6 4s-2.7 4-6 4-6-1.8-6-4 2.7-4 6-4zM4.2 12.2a.9.9 0 100 .1M2.6 14.2a.5.5 0 100 .1',
  shout: 'M8 1.5l1.4 2.6 2.9-1-.3 3 2.8 1.2-2.4 1.8 1.2 2.8-3-.4-1.2 2.9-1.4-2.6-2.9 1 .3-3-2.8-1.2 2.4-1.8L2.8 4l3 .4z',
  whisper: 'M3 5.5a5.5 3.5 0 012-2M7 2.6h2M11 3.5a5.5 3.5 0 012 2M13.6 8a5.5 3.5 0 01-2 2.3M9 11h-2M4.5 10.4L3 13.5',
  radio: 'M8 2.5c3.3 0 6 2 6 4.5s-2.7 4.5-6 4.5M8 2.5c-3.3 0-6 2-6 4.5 0 1.3.7 2.5 1.9 3.3M5.5 9.5L3.5 12l2-.5-1.5 3',
  caption: 'M2 4h12v8H2zM4.5 7h7M4.5 9.5h4.5',
  narration: 'M2.5 3h11v10h-11zM5 3v10M7 6h4.5M7 8.5h4.5M7 11h3',
  sfx: 'M2 11l2.5-6 2 4 2-6 2 6 1.5-3 2 5',
  sign: 'M8 14.5V7M3 3h10v4H3zM5.5 5h5',
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
