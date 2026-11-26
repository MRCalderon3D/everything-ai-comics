// Dialogs. Built on <dialog>, which keeps focus inside, closes on Escape and
// gives focus back to what opened it.

import { h, icon, nextId } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { errorText } from '/js/api.js';

/**
 * openDialog({ title, body, wide }) -> { el, close, setBody }.
 * The caller puts its own buttons in the body or passes `actions`.
 */
export function openDialog({ title, body, actions, wide, onClose } = {}) {
  const opener = document.activeElement;
  const titleId = nextId('dlg');
  const content = h('div', { class: 'dialog-body' }, body);
  const foot = h('div', { class: 'dialog-actions' }, actions || []);
  const el = h('dialog', { class: `dialog${wide ? ' wide' : ''}`, 'aria-labelledby': titleId },
    h('div', { class: 'dialog-head' },
      h('h2', { id: titleId }, title),
      h('button', { type: 'button', class: 'btn icon-only quiet', 'aria-label': t('action.close'), onclick: () => close() }, icon('close'))),
    content, foot);
  function close(value) {
    if (el.open) el.close();
    el.remove();
    if (opener && document.contains(opener)) opener.focus();
    if (onClose) onClose(value);
  }
  el.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  el.addEventListener('click', (event) => {
    if (event.target === el) close();
  });
  document.getElementById('overlay-root').append(el);
  el.showModal();
  return {
    el,
    close,
    setBody(...nodes) { content.replaceChildren(...nodes); },
    setActions(...nodes) { foot.replaceChildren(...nodes); },
  };
}

/**
 * Ask before doing something. Resolves to null when the person backs out,
 * else to { note, checked }.
 *
 * confirmDialog({ title, body, confirm: 'Move to trash', danger: true,
 *                 note: { label, required }, check: { label }, run })
 *
 * With `run`, the action runs while the dialog is still open, so a refusal
 * from the server is shown where the person is looking.
 */
export function confirmDialog({ title, body, confirm, danger, note, check, cancel, run } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const noteId = nextId('note');
    const noteInput = note ? h('textarea', { id: noteId, rows: 3, required: !!note.required }) : null;
    if (noteInput && note.value) noteInput.value = note.value;
    const checkId = nextId('ack');
    const checkInput = check ? h('input', { id: checkId, type: 'checkbox' }) : null;
    const problem = h('p', { class: 'notice bad', role: 'alert', hidden: true });
    const ok = h('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'}` }, confirm || t('action.confirm'));
    const back = h('button', { type: 'button', class: 'btn quiet', onclick: () => dialog.close() }, cancel || t('action.cancel'));
    const sync = () => {
      ok.disabled = (checkInput && !checkInput.checked) || (note && note.required && !noteInput.value.trim());
    };
    if (noteInput) noteInput.addEventListener('input', sync);
    if (checkInput) checkInput.addEventListener('change', sync);
    ok.addEventListener('click', async () => {
      const value = { note: noteInput ? noteInput.value.trim() : '', checked: checkInput ? checkInput.checked : false };
      if (!run) {
        done(value);
        dialog.close();
        return;
      }
      ok.disabled = true;
      back.disabled = true;
      problem.hidden = true;
      try {
        value.result = await run(value);
        done(value);
        dialog.close();
      } catch (err) {
        problem.textContent = errorText(err);
        problem.hidden = false;
        back.disabled = false;
        sync();
      }
    });
    const dialog = openDialog({
      title,
      body: [
        typeof body === 'string' ? h('p', null, body) : body,
        note ? h('div', { class: 'field' }, h('label', { for: noteId }, note.label), noteInput, note.hint ? h('p', { class: 'hint' }, note.hint) : null) : null,
        check ? h('div', { class: 'check' }, checkInput, h('label', { for: checkId }, check.label)) : null,
        problem,
      ],
      actions: [back, ok],
      onClose: () => done(null),
    });
    sync();
    (noteInput || checkInput || back).focus();
  });
}
