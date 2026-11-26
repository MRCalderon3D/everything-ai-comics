// The general options of a project: a form over project.yaml.

import { h } from '/js/dom.js';
import { t, tv } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { textField, selectField, actionButton, notice } from '/js/components/ui.js';
import { findingsList } from '/js/components/editor.js';
import { toast } from '/js/components/toast.js';

const choice = (prefix, values) => values.map((v) => ({ value: v, label: tv(prefix, v, v) }));

/** optionsForm(ctx, { options, choices }) */
export function optionsForm(ctx, { options, choices }) {
  const result = h('div');
  const fields = {
    title: textField({ label: t('options.title'), value: options.title || '' }),
    logline: textField({ label: t('options.logline'), value: options.logline || '', multiline: true, rows: 2 }),
    genre: textField({ label: t('options.genre'), value: options.genre || '' }),
    language: textField({ label: t('options.language'), value: options.language || '', hint: t('options.language_hint') }),
    comic_format: selectField({ label: t('options.format'), value: options.comic_format, options: choice('format', choices.comic_format), hint: t('options.format_hint') }),
    publication: selectField({ label: t('options.publication'), value: options.publication, options: choice('publication', choices.publication) }),
    reading_direction: selectField({ label: t('options.reading_direction'), value: options.reading_direction, options: choice('reading', choices.reading_direction) }),
    page_size: selectField({
      label: t('options.page_size'), value: options.page_size || '',
      options: [
        ...(options.page_size ? [] : [{ value: '', label: t('options.page_size_custom', { ratio: options.page ? options.page.aspect_ratio : '' }) }]),
        ...choices.page_size.map((p) => ({ value: p.id, label: `${tv('page_size', p.id, p.label)} (${p.width_px} × ${p.height_px})` })),
      ],
      hint: t('options.page_size_hint'),
    }),
    color_mode: selectField({ label: t('options.color'), value: options.color_mode, options: choice('color', choices.color_mode), hint: t('options.color_hint') }),
    lettering_mode: selectField({ label: t('options.lettering'), value: options.lettering_mode, options: choice('lettering_mode', choices.lettering_mode), hint: t('options.lettering_hint') }),
    rating: selectField({ label: t('options.rating'), value: options.rating, options: choice('rating', choices.rating) }),
    repair_limit: textField({ label: t('options.repair_limit'), type: 'number', min: 0, max: 10, value: String(options.repair_limit ?? ''), hint: t('options.repair_limit_hint') }),
  };

  const save = async () => {
    result.replaceChildren();
    const body = {};
    for (const [key, field] of Object.entries(fields)) {
      let value = field.value;
      if (key === 'repair_limit') {
        if (value === '') continue;
        value = Number(value);
      }
      if (key === 'page_size' && value === '') continue;
      if (String(value) !== String(options[key] ?? '')) body[key] = value;
    }
    if (!Object.keys(body).length) {
      toast(t('editor.unchanged'));
      return;
    }
    try {
      const res = await api.saveOptions(ctx.projectId, body);
      const list = findingsList(res.findings);
      toast(t('options.saved'), { kind: 'ok' });
      ctx.refresh();
      if (list) result.append(list);
    } catch (err) {
      result.append(notice('bad', err.code === 'format_locked' ? t('error.format_locked') : errorText(err)));
    }
  };

  return h('form', { class: 'stack', onsubmit: (e) => e.preventDefault() },
    h('div', { class: 'stack-s' }, fields.title.el, fields.logline.el,
      h('div', { class: 'field-pair' }, fields.genre.el, fields.language.el)),
    h('div', { class: 'field-pair' }, fields.comic_format.el, fields.reading_direction.el),
    h('div', { class: 'field-pair' }, fields.page_size.el, fields.color_mode.el),
    h('div', { class: 'field-pair' }, fields.lettering_mode.el, fields.repair_limit.el),
    h('div', { class: 'field-pair' }, fields.publication.el, fields.rating.el),
    result,
    h('div', { class: 'row' }, actionButton(t('options.save'), save, { kind: 'primary' })));
}
