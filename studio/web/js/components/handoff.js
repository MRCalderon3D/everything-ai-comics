// Making an image by hand. With no drawing tool installed (or when the person
// prefers their own), the studio prepares the prompt and the reference images,
// the person makes the image elsewhere and uploads it.

import { h } from '/js/dom.js';
import { t, tv } from '/js/i18n.js';
import { startOp, findJob, whenJobSettles, bus } from '/js/store.js';
import { actionButton, copyButton, facts, notice } from '/js/components/ui.js';
import { uploader } from '/js/components/uploader.js';
import { frame } from '/js/components/viewer.js';
import { toast } from '/js/components/toast.js';
import { jobOutcome } from '/js/labels.js';

function sameTarget(params, target) {
  return ['page', 'cover', 'entity', 'sheet'].every((k) => (params[k] || null) === (target[k] || null));
}

/**
 * handoff(ctx, key, target, { repair, intro })
 *   target: { page } | { cover: issue } | { entity, sheet, outfit }
 */
export function handoff(ctx, key, target, { repair = false, intro } = {}) {
  const el = h('div', { class: 'handoff stack-s' });
  const up = uploader(ctx, { kind: 'image', multiple: false, key: `handoff:${key}`, label: t('handoff.pick_result'), onchange: () => paint() });

  const prepare = async () => {
    const job = await startOp('page.manual', Object.assign({}, target, { repair }));
    const done = await whenJobSettles(job.id);
    if (done.status === 'failed') throw Object.assign(new Error(jobOutcome(done)), { code: done.error && done.error.code });
    paint();
  };

  const store = async () => {
    const ids = up.ids();
    if (!ids.length) {
      toast(t('handoff.need_file'), { kind: 'warn' });
      return;
    }
    const job = await startOp('page.manual', Object.assign({}, target, { repair, upload: ids[0] }));
    const done = await whenJobSettles(job.id);
    if (done.status === 'failed') throw Object.assign(new Error(jobOutcome(done)), { code: done.error && done.error.code });
    up.clear();
    toast(done.result && done.result.reviewed === false ? t('outcome.manual.stored_unreviewed') : t('handoff.stored'), { kind: 'ok' });
    ctx.refresh();
  };

  function paint() {
    // The newest finished handoff job of this target: a prepared prompt, or an
    // upload that already used it (then the next image starts from a fresh one).
    const last = findJob((j) => j.op === 'page.manual' && j.status === 'done' && j.result && sameTarget(j.params || {}, target));
    const ho = last && last.result.handoff ? last.result.handoff : null;
    const nodes = [h('p', null, intro || t('handoff.intro'))];
    if (!ho) {
      nodes.push(actionButton(t('handoff.prepare'), prepare, { kind: 'primary' }));
    } else {
      nodes.push(
        h('ol', { class: 'handoff-steps' },
          h('li', null,
            h('h4', null, t('handoff.step_refs')),
            ho.images && ho.images.length
              ? h('div', { class: 'ref-row' }, ho.images.map((img) => h('div', { class: 'ref' },
                frame(img.image, { alt: `${img.position}. ${img.asset_id}`, ratio: '1 / 1' }),
                h('div', { class: 'small' }, h('strong', null, `${img.position}. `), tv('ref_role', img.role, img.role)),
                img.image ? h('a', { class: 'small', href: `${img.image.url}${img.image.url.includes('?') ? '&' : '?'}download=1`, download: '' }, t('action.download')) : null)))
              : h('p', { class: 'muted' }, t('handoff.no_refs'))),
          h('li', null,
            h('h4', null, t('handoff.step_prompt')),
            h('pre', { class: 'prompt', tabIndex: 0 }, ho.prompt),
            h('div', { class: 'row' }, copyButton(() => ho.prompt)),
            facts([
              [t('handoff.aspect'), ho.aspect_ratio],
              [t('handoff.resolution'), ho.resolution],
              [t('handoff.avoid'), ho.negative_prompt],
            ])),
          h('li', null,
            h('h4', null, t('handoff.step_upload')),
            up.el,
            h('div', { class: 'row' },
              actionButton(t('handoff.use_image'), store, { kind: 'primary', disabled: !up.count() }),
              actionButton(t('handoff.prepare_again'), prepare, { kind: 'quiet', small: true })))));
    }
    el.replaceChildren(...nodes);
  }

  paint();
  return el;
}

/** The explanation shown when nothing here can draw. */
export function noDrawTool(reason) {
  return notice('warn', h('strong', null, t('draw.unavailable')), ' ', reason || t('draw.unavailable_body'));
}

export { bus };
