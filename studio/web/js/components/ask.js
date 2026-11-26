// Starting an operation from a screen: a box to write what is wanted and a
// button. The job goes to the queue and the person carries on.

import { h } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { startOp } from '/js/store.js';
import { jobTitle } from '/js/labels.js';
import { textField, actionButton } from '/js/components/ui.js';
import { toast } from '/js/components/toast.js';

/** Start an operation and say where it is in the queue. */
export async function queueOp(op, params) {
  const job = await startOp(op, params);
  const title = jobTitle(job);
  // A job that starts at once shows itself on the screen; one that has to wait says so.
  if (job.status === 'queued' && job.position && job.position > 1) toast(t('op.queued_behind', { title, n: job.position - 1 }));
  return job;
}

/**
 * askForm(ctx, { key, label, hint, placeholder, action, run, extra, rows, required })
 *   run(text) starts the operation; `extra` are more controls shown under the text.
 */
export function askForm(ctx, { key, label, hint, placeholder, action, run, extra, rows = 3, required = true, kind = 'primary' } = {}) {
  const field = textField({ label, hint, placeholder, multiline: true, rows, draft: ctx.draft(key) });
  const go = async () => {
    const text = field.value.trim();
    if (required && !text) {
      field.input.focus();
      toast(t('form.write_first'), { kind: 'warn' });
      return;
    }
    await run(text);
    field.clear();
  };
  return h('form', { class: 'ask stack-s', onsubmit: (e) => e.preventDefault() },
    field.el, extra || null,
    h('div', { class: 'row' }, actionButton(action, go, { kind })));
}
