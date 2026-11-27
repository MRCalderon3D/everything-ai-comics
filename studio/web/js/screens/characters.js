// The cast: add a character from a name and a description, photos, or both.

import { h } from '/js/dom.js';
import { t, tn, tv } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, textField, checkField, notice, emptyState } from '/js/components/ui.js';
import { queueOp } from '/js/components/ask.js';
import { uploader } from '/js/components/uploader.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame } from '/js/components/viewer.js';
import { toast } from '/js/components/toast.js';
import { newsBar, newsMark } from '/js/components/news.js';
import { cleanupButton } from '/js/components/deleting.js';

export async function load(ctx) {
  const [cast, story] = await Promise.all([api.characters(ctx.projectId), api.story(ctx.projectId).catch(() => null)]);
  return { cast, story };
}

function addForm(ctx, data, draw) {
  const name = textField({ label: t('characters.name'), draft: ctx.draft('name'), required: true });
  const about = textField({
    label: t('characters.about'), multiline: true, rows: 4, draft: ctx.draft('about'),
    hint: t('characters.about_hint'), placeholder: t('characters.about_placeholder'),
  });
  const rights = notice('warn', t('characters.photo_rights'));
  rights.hidden = true;
  const photos = uploader(ctx, {
    kind: 'image', key: 'photos', label: t('characters.photos'), hint: t('characters.photos_hint'),
    onchange: () => { rights.hidden = !photos.count(); },
  });
  rights.hidden = !photos.count();
  const canDraw = data.cast.look_approved && draw.available;
  const wantSheet = checkField({
    label: t('characters.draw_sheet'), checked: canDraw, disabled: !canDraw,
    hint: canDraw ? t('characters.draw_sheet_hint')
      : (!data.cast.look_approved ? t('characters.draw_needs_look') : t('characters.draw_needs_tool')),
  });
  const add = async () => {
    const who = name.value.trim();
    const text = about.value.trim();
    const ids = photos.ids();
    if (!who) {
      name.input.focus();
      toast(t('characters.need_name'), { kind: 'warn' });
      return;
    }
    if (!text && !ids.length) {
      about.input.focus();
      toast(t('characters.need_description'), { kind: 'warn' });
      return;
    }
    const params = { name: who, draw: canDraw && wantSheet.value };
    if (text) params.description = text;
    if (ids.length) params.uploads = ids;
    try {
      await queueOp('character.create', params);
    } catch (err) {
      if (err.code === 'character_exists' && err.details && err.details.character) {
        toast(t('characters.exists', { name: who }), {
          kind: 'warn', link: { href: `/p/${encodeURIComponent(ctx.projectId)}/characters/${err.details.character}`, label: t('characters.open_existing') },
        });
        return;
      }
      throw err;
    }
    name.clear();
    about.clear();
    photos.clear();
    rights.hidden = true;
  };
  return h('form', { class: 'stack-s', onsubmit: (e) => e.preventDefault() },
    name.el, about.el, photos.el, rights, wantSheet.el,
    h('div', { class: 'row' }, actionButton(t('characters.add'), add, { kind: 'primary' })));
}

export function view(ctx, data) {
  ctx.title = t('screen.characters');
  const cast = data.cast.characters;
  const draw = state.overview.tools.draw;
  const base = `/p/${encodeURIComponent(ctx.projectId)}/characters`;
  const have = new Set(cast.map((c) => c.id));
  const named = data.story ? (data.story.characters_named || []).filter((c) => !have.has(c.id)) : [];

  // Characters with no drawn sheet at all: once the look is approved, offer to draw them.
  const unsheeted = cast.filter((c) => !c.has_master && !c.candidates);
  const offer = data.cast.look_approved && draw.available && unsheeted.length
    ? notice('next', h('p', null, tn('characters.missing_sheets', unsheeted.length, { names: unsheeted.map((c) => c.name).join(', ') })),
      h('div', { class: 'row' }, actionButton(t('characters.draw_missing'), async () => {
        for (const c of unsheeted) await queueOp('character.sheet', { character: c.id, sheet: 'turnaround' });
      }, { kind: 'primary' }), h('span', { class: 'small muted' }, t('characters.draw_missing_time'))))
    : null;

  const text = h('div', { class: 'stack' },
    newsBar('characters'),
    jobsFor((j) => j.op === 'character.create' || (j.op === 'character.sheet' && j.params && unsheeted.some((c) => c.id === j.params.character))),
    !data.cast.look_approved ? notice('info', t('characters.look_first'), ' ',
      h('a', { href: `/p/${encodeURIComponent(ctx.projectId)}/style` }, t('screen.style'))) : null,
    offer,
    named.length ? notice('next', h('p', null, tn('characters.named_in_story', named.length)),
      h('ul', { class: 'bullets' }, named.map((c) => h('li', null,
        h('button', {
          type: 'button', class: 'link',
          onclick: () => {
            const pretty = c.id.replace(/^CHAR_/, '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
            ctx.draft('name').set(pretty);
            ctx.refresh();
          },
        }, c.id.replace(/^CHAR_/, '').toLowerCase().replace(/_/g, ' ')))))) : null,
    panel(t('characters.add_title'), addForm(ctx, data, draw)));

  const images = cast.length
    ? h('ul', { class: 'cast-grid' }, cast.map((c) => h('li', { class: 'cast-card' },
      h('a', { href: `${base}/${c.id}`, class: 'cast-art', 'aria-label': t('characters.open', { name: c.name }) },
        frame(c.image, { alt: t('characters.image_alt', { name: c.name }), ratio: '1 / 1', placeholder: t('characters.no_image') })),
      h('h3', null, h('a', { href: `${base}/${c.id}` }, c.name)),
      newsMark(`character:${c.id}`),
      c.role ? h('p', { class: 'small faint' }, tv('value', c.role, c.role)) : null,
      c.summary ? h('p', { class: 'muted clamp' }, c.summary) : null,
      h('p', { class: `small ${c.has_master ? 'state-ok' : 'state-wait'}` },
        c.has_master ? t('characters.has_master')
          : (c.candidates ? tn('characters.candidates_waiting', c.candidates)
            : (!data.cast.look_approved ? t('characters.no_sheet_look')
              : (c.identity && c.identity.photos && c.identity.photos.length ? t('characters.photo_only') : t('characters.no_sheet'))))))))
    : emptyState(t('characters.empty_title'), t('characters.empty_body'));

  return h('div', { class: 'screen' },
    screenHead({
      title: t('screen.characters'),
      lede: cast.length ? tn('characters.lede', cast.length) : t('characters.lede_empty'),
      actions: cast.length ? [cleanupButton(ctx, 'characters')] : null,
    }),
    bench(ctx, { text, images, chat: { key: data.cast.chat_key, examples: [t('characters.example_1')] } }));
}
