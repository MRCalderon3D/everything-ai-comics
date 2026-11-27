// A new comic: a title, what it is about in the person's own words, and a
// few options. Creating it starts nothing: no AI runs, the text becomes the
// start of the story, and the Story screen opens with it.

import { h, nextId, icon } from '/js/dom.js';
import { t, tv, getLang } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { screenHead } from '/js/components/bench.js';
import { textField, selectField, actionButton, notice, disclosure, checkField } from '/js/components/ui.js';
import { openDockSoon } from '/js/components/conversation.js';

const COMIC_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ca', 'ja'];

export async function load() {
  try {
    const { choices } = await api.presets();
    return { choices };
  } catch (err) {
    // The extra options are optional; the form works without them.
    return { choices: null };
  }
}

/** Large radio tiles. options: [{ value, label, hint }] */
function choiceCards(legend, name, options, value, onchange) {
  let chosen = value;
  return {
    el: h('fieldset', { class: 'stack-s' }, h('legend', { class: 'field-legend' }, h('strong', null, legend)),
      h('div', { class: 'choice-cards' }, options.map((o) => {
        const id = nextId('cc');
        return h('div', { class: 'choice-card' },
          h('input', { type: 'radio', name, id, value: o.value, checked: o.value === value, onchange: () => { chosen = o.value; if (onchange) onchange(o.value); } }),
          h('label', { for: id }, h('strong', null, o.label), o.hint ? h('span', null, o.hint) : null));
      }))),
    get value() { return chosen; },
  };
}

export function view(ctx, { choices }) {
  ctx.title = t('new.title');
  const problem = h('div');
  const title = textField({ label: t('new.field_title'), draft: ctx.draft('title'), required: true, maxlength: 120, autofocus: true, placeholder: t('new.field_title_placeholder') });
  title.input.classList.add('title-input');
  const about = textField({
    label: t('new.field_about'), draft: ctx.draft('about'), multiline: true, rows: 7,
    hint: t('new.field_about_hint'), placeholder: t('new.field_about_placeholder'),
  });
  about.input.classList.add('writing');
  const format = choiceCards(t('new.field_format'), nextId('fmt'), [
    { value: 'paged', label: t('format.paged'), hint: t('new.format_paged_hint') },
    { value: 'webtoon', label: t('format.webtoon'), hint: t('new.format_webtoon_hint') },
  ], 'paged');
  const language = selectField({
    label: t('new.field_language'), value: getLang(), hint: t('new.field_language_hint'),
    options: COMIC_LANGUAGES.map((code) => ({ value: code, label: tv('language', code, code) })),
  });
  const pages = textField({ label: t('new.field_pages'), type: 'number', value: '4', min: 1, max: 200, hint: t('new.field_pages_hint'), draft: ctx.draft('pages') });

  const opt = (key, prefix, list, fallback) => selectField({
    label: t(`options.${key}`), value: fallback,
    options: (list || []).map((v) => ({ value: v, label: tv(prefix, v, v) })),
  });
  const more = choices ? {
    reading_direction: opt('reading_direction', 'reading', choices.reading_direction, 'ltr'),
    color_mode: opt('color', 'color', choices.color_mode, 'full_color'),
    lettering_mode: opt('lettering', 'lettering_mode', choices.lettering_mode, 'in_image'),
    publication: opt('publication', 'publication', choices.publication, 'one-shot'),
    rating: opt('rating', 'rating', choices.rating, 'teen'),
  } : null;

  const guided = checkField({ label: t('new.guide'), hint: t('new.guide_hint'), checked: true, draft: ctx.draft('guide') });

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
    const options = {};
    if (more && ctx.ui.moreTouched) for (const [key, field] of Object.entries(more)) options[key] = field.value;
    try {
      const res = await api.createProject({
        title: name,
        description: description || undefined,
        format: format.value,
        language: language.value,
        pages: count,
        interface_language: getLang(),
        options: Object.keys(options).length ? options : undefined,
        guide: guided.value ? true : undefined,
      });
      title.clear();
      about.clear();
      pages.clear();
      // In guide mode the conversation opens on the project's home with the guide's first question.
      if (res.guide) openDockSoon();
      ctx.navigate(`/p/${encodeURIComponent(res.project.id)}${res.guide ? '' : '/story'}`);
    } catch (err) {
      problem.append(notice('bad', errorText(err)));
    }
  };

  const moreBox = more ? disclosure(ctx, 'more', t('new.more_options'), () => {
    const box = h('div', { class: 'field-pair' }, Object.values(more).map((f) => f.el));
    box.addEventListener('change', () => { ctx.ui.moreTouched = true; });
    return h('div', { class: 'stack-s' }, h('p', { class: 'hint' }, t('new.more_hint')), box);
  }) : null;

  return h('div', { class: 'screen narrow' },
    screenHead({ title: t('new.title'), lede: t('new.lede'), back: { href: '/', label: t('nav.projects') } }),
    h('form', { class: 'new-form', onsubmit: (e) => e.preventDefault(), noValidate: true },
      title.el, about.el, format.el,
      h('div', { class: 'field-pair' }, language.el, pages.el),
      moreBox,
      guided.el,
      h('p', { class: 'new-promise' }, icon('pen'), h('span', null, t('new.what_happens'))),
      problem,
      h('div', { class: 'row' },
        actionButton(t('new.create'), create, { kind: 'primary', large: true }),
        h('a', { class: 'btn quiet', href: '/' }, t('action.cancel')))));
}
