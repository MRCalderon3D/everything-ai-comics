// Places and objects. They are written when pages are planned; this screen
// lists them for those who want to look or change something.

import { h } from '/js/dom.js';
import { t, tn } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, checkField, emptyState } from '/js/components/ui.js';
import { askForm, queueOp } from '/js/components/ask.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame } from '/js/components/viewer.js';

export async function load(ctx) {
  return api.entities(ctx.projectId);
}

function entityCard(ctx, kind, e) {
  const href = `/p/${encodeURIComponent(ctx.projectId)}/places/${kind}/${e.id}`;
  return h('li', { class: 'cast-card' },
    h('a', { href, class: 'cast-art', 'aria-label': t('places.open', { name: e.name || e.id }) },
      frame(e.image, { alt: e.name || e.id, ratio: '3 / 2', placeholder: kind === 'location' ? t('places.no_plate') : t('places.no_prop_sheet') })),
    h('h3', null, h('a', { href }, e.name || e.id)),
    e.summary ? h('p', { class: 'muted clamp' }, e.summary) : null,
    h('p', { class: 'small faint' }, e.has_master ? t('places.has_master') : (e.candidates ? tn('characters.candidates_waiting', e.candidates) : t('places.text_only'))));
}

export function view(ctx, data) {
  ctx.title = t('screen.places');
  const draw = state.overview.tools.draw;
  const lookOk = state.overview.look && state.overview.look.approved;
  const canDraw = draw.available && lookOk;
  const plates = checkField({
    label: t('places.plates'), checked: false, disabled: !canDraw,
    hint: canDraw ? t('places.plates_hint') : t('places.plates_blocked'),
  });
  const text = h('div', { class: 'stack' },
    jobsFor((j) => j.op === 'entities.derive'),
    panel(t('places.derive_title'),
      h('p', { class: 'muted' }, t('places.derive_body')),
      askForm(ctx, {
        key: 'derive',
        label: t('places.derive_label'),
        hint: t('places.derive_hint'),
        action: t('places.derive_action'),
        required: false,
        kind: '',
        extra: plates.el,
        run: (textValue) => queueOp('entities.derive', {
          issue: state.issue || undefined, text: textValue || undefined, plates: canDraw && plates.value,
        }),
      })));
  const any = data.locations.length || data.props.length;
  const images = any
    ? h('div', { class: 'stack' },
      h('section', { class: 'stack-s' }, h('h2', { class: 'panel-title' }, tn('places.locations', data.locations.length)),
        data.locations.length
          ? h('ul', { class: 'cast-grid wide' }, data.locations.map((e) => entityCard(ctx, 'location', e)))
          : h('p', { class: 'muted' }, t('places.no_locations'))),
      h('section', { class: 'stack-s' }, h('h2', { class: 'panel-title' }, tn('places.props', data.props.length)),
        data.props.length
          ? h('ul', { class: 'cast-grid wide' }, data.props.map((e) => entityCard(ctx, 'prop', e)))
          : h('p', { class: 'muted' }, t('places.no_props'))))
    : emptyState(t('places.empty_title'), t('places.empty_body'),
      h('a', { class: 'btn', href: `/p/${encodeURIComponent(ctx.projectId)}/pages` }, t('screen.pages')));
  return h('div', { class: 'screen' },
    screenHead({ title: t('screen.places'), lede: t('places.lede') }),
    bench(ctx, { text, images, chat: { key: data.chat_key } }));
}
