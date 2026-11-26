// One place or one object: its text, its reference images, its chat.

import { h } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { api, ApiError } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { tabs, panel, notice } from '/js/components/ui.js';
import { docEditor } from '/js/components/editor.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer } from '/js/components/viewer.js';
import { assetGrid, viewerItems } from '/js/components/assets.js';
import { handoff } from '/js/components/handoff.js';

export async function load(ctx) {
  const { kind, entity } = ctx.params;
  if (kind === 'location') return { kind, data: await api.location(ctx.projectId, entity) };
  if (kind === 'prop') return { kind, data: await api.prop(ctx.projectId, entity) };
  throw new ApiError(404, 'not_found', t('error.no_such_screen'));
}

export function view(ctx, { kind, data }) {
  const name = data.name || data.id;
  ctx.title = name;
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const lookOk = state.overview.look && state.overview.look.approved;
  const assets = data.assets || { masters: [], candidates: [], references: [] };
  const all = [...assets.masters, ...assets.candidates, ...assets.references];
  const sheet = kind === 'location' ? 'plate' : 'prop';
  const text = h('section', { class: 'panel' },
    tabs(ctx, 'place', [
      kind === 'location'
        ? { id: 'main', label: t('place.tab_location'), render: () => docEditor(ctx, data.location, { key: 'location', title: t('place.location_title') }) }
        : { id: 'main', label: t('place.tab_prop'), render: () => docEditor(ctx, data.prop, { key: 'prop', title: t('place.prop_title') }) },
      kind === 'location' && data.map
        ? { id: 'map', label: t('place.tab_map'), render: () => h('div', { class: 'stack-s' }, h('p', { class: 'muted' }, t('place.map_intro')), docEditor(ctx, data.map, { key: 'map', title: t('place.map_title'), startInFile: true })) }
        : null,
    ], { label: name }));
  const images = h('div', { class: 'stack' },
    jobsFor((j) => (j.op === 'entities.derive') || (j.op === 'page.manual' && j.params && j.params.entity === data.id)),
    data.image
      ? frame(data.image, { alt: name, onclick: () => openViewer(viewerItems(all), all[0] && all[0].id) })
      : h('div', { class: 'art-empty' }, h('h2', null, t('place.no_image_title')), h('p', null, t('place.no_image_body'))),
    all.length ? assetGrid(ctx, all.filter((a) => !a.promoted_to), { all, masterOf: (s) => assets.masters.some((m) => m.sheet === s && m.status === 'approved') }) : null,
    lookOk
      ? panel(t('handoff.title'), handoff(ctx, `ent:${data.id}`, { entity: data.id, sheet }, { intro: t('place.handoff_intro') }))
      : notice('info', t('characters.look_first')));
  return h('div', { class: 'screen' },
    screenHead({ title: name, lede: data.summary || '', back: { href: `${base}/places`, label: t('screen.places') } }),
    bench(ctx, { text, images, chat: { key: data.chat_key, title: t('chat.title_about', { name }) } }));
}
