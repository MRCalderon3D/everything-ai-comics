// A new comic from a title and a few lines about it.

import { h } from '/js/dom.js';
import { t, tv, getLang } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { screenHead } from '/js/components/bench.js';
import { textField, selectField, radioField, actionButton, notice } from '/js/components/ui.js';

const COMIC_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ca', 'ja'];

export async function load() {
  return null;
}

export function view(ctx) {
  ctx.title = t('new.title');
  const problem = h('div');
  const title = textField({ label: t('new.field_title'), draft: ctx.draft('title'), required: true, maxlength: 120, autofocus: true });
  const about = textField({
    label: t('new.field_about'), draft: ctx.draft('about'), multiline: true, rows: 6,
    hint: t('new.field_about_hint'), placeholder: t('new.field_about_placeholder'),
  });
  const format = radioField({
    legend: t('new.field_format'), value: 'paged',
    options: [
      { value: 'paged', label: t('format.paged'), hint: t('new.format_paged_hint') },
      { value: 'webtoon', label: t('format.webtoon'), hint: t('new.format_webtoon_hint') },
    ],
  });
  const language = selectField({
    label: t('new.field_language'), value: getLang(), hint: t('new.field_language_hint'),
    options: COMIC_LANGUAGES.map((code) => ({ value: code, label: tv('language', code, code) })),
  });
  const pages = textField({ label: t('new.field_pages'), type: 'number', value: '4', min: 1, max: 200, hint: t('new.field_pages_hint'), draft: ctx.draft('pages') });

  const create = async () => {
    problem.replaceChildren();
    const name = title.value.trim();
    if (!name) {
      problem.append(notice('bad', t('new.need_title')));
      title.input.focus();
      return;
    }
    const count = Number(pages.value || 4);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      problem.append(notice('bad', t('new.bad_pages')));
      pages.input.focus();
      return;
    }
    const description = about.value.trim();
    try {
      const res = await api.createProject({
        title: name,
        description: description || undefined,
        format: format.value,
        language: language.value,
        pages: count,
        interface_language: getLang(),
      });
      title.clear();
      about.clear();
      pages.clear();
      ctx.navigate(`/p/${encodeURIComponent(res.project.id)}`);
    } catch (err) {
      problem.append(notice('bad', errorText(err)));
    }
  };

  return h('div', { class: 'screen narrow' },
    screenHead({ title: t('new.title'), lede: t('new.lede'), back: { href: '/', label: t('nav.projects') } }),
    h('form', { class: 'panel stack', onsubmit: (e) => e.preventDefault(), noValidate: true },
      title.el, about.el, format.el,
      h('div', { class: 'field-pair' }, language.el, pages.el),
      h('p', { class: 'small muted' }, t('new.what_happens')),
      problem,
      h('div', { class: 'row' },
        actionButton(t('new.create'), create, { kind: 'primary' }),
        h('a', { class: 'btn quiet', href: '/' }, t('action.cancel')))));
}
