// One page: its plan in plain words, to edit or approve; the findings of the
// mechanical checks; its drawing and earlier versions. The ledger, the
// references and the prompt sit behind "advanced".

import { h, nextId } from '/js/dom.js';
import { t, tn, tv } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, button, notice, tabs, facts, copyButton, caption } from '/js/components/ui.js';
import { docEditor, findingsList } from '/js/components/editor.js';
import { autoGrow } from '/js/components/schema-form.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer, versionStrip } from '/js/components/viewer.js';
import { verdictChip } from '/js/components/verdict.js';
import { handoff, noDrawTool } from '/js/components/handoff.js';
import { slotWords } from '/js/components/correction.js';
import { toast } from '/js/components/toast.js';
import { pageName, versionName } from '/js/labels.js';
import { mechanicalBox, drawPages, queueLine } from '/js/screens/pages.js';
import { blockerText } from '/js/screens/home.js';

export async function load(ctx) {
  return api.page(ctx.projectId, ctx.params.page);
}

export function renderItems(renders) {
  return renders.map((r) => ({
    id: r.id,
    label: versionName(r.id),
    image: r.lettered || r.image,
    alt: `${pageName(r.id)}, ${versionName(r.id)}`,
    note: r.generation && r.generation.supplied_by_person ? t('asset.supplied') : '',
  }));
}

/** The plan as a form: what the page is for, what each panel shows, who says what. */
function planEditor(ctx, data) {
  const doc = data.page;
  const plan = data.plan;
  const source = doc.data;
  if (!source || !Array.isArray(source.panels)) {
    return notice('warn', t('page.plan_unreadable'));
  }
  const edits = JSON.parse(JSON.stringify(source));
  const status = h('div');
  let dirty = false;
  const saveBtn = actionButton(t('page.save_plan'), async () => {
    try {
      const res = await api.saveFile(ctx.projectId, { path: doc.path, data: edits, base_etag: doc.etag });
      setDirty(false);
      toast(res.saved ? t('page.plan_saved') : t('editor.unchanged'), { kind: 'ok' });
      const list = findingsList(res.findings);
      status.replaceChildren(...[list, res.continuity && res.continuity.length ? mechanicalBox({ continuity: res.continuity }) : null].filter(Boolean));
      ctx.refresh();
    } catch (err) {
      status.replaceChildren(notice('bad', errorText(err)));
    }
  }, { kind: 'primary', icon: 'check' });
  const setDirty = (value) => {
    dirty = value;
    ctx.setDirty('plan', value);
    saveBtn.disabled = !value;
  };
  const area = (labelText, value, onInput, rows = 2) => {
    const id = nextId('pl');
    const el = h('textarea', { id, rows });
    el.value = value || '';
    autoGrow(el);
    el.addEventListener('input', () => {
      onInput(el.value);
      setDirty(true);
    });
    return h('div', { class: 'field' }, h('label', { for: id }, labelText), el);
  };
  const byId = new Map(edits.panels.map((p) => [p.id, p]));
  const panels = plan.panels.map((p) => {
    const target = byId.get(p.id);
    if (!target) return null;
    return h('li', { class: 'plan-panel' },
      h('h4', null, t('page.panel_n', { n: p.number }),
        h('span', { class: 'faint small' }, ` ${t('page.panel_meta', { size: tv('value', p.size, p.size), shot: tv('shot', p.shot, String(p.shot || '').replace(/_/g, ' ')) })}`,
          p.slot ? ` · ${slotWords(p.slot)}` : '')),
      area(t('page.moment'), target.moment, (v) => { target.moment = v; }),
      (target.cast || []).map((c, i) => {
        const shown = p.cast[i] || {};
        return area(t('page.does', { name: shown.name || c.character }), c.action, (v) => { c.action = v; }, 1);
      }),
      (target.lettering || []).map((l, i) => {
        const shown = p.lettering[i] || {};
        const who = shown.speaker_name || tv('lettering_type', l.type, l.type);
        return area(l.type === 'balloon' ? t('page.says', { name: who }) : who, l.text, (v) => { l.text = v; }, 1);
      }),
      p.cast.length ? h('p', { class: 'small faint' }, p.cast.map((c) => `${c.name}: ${c.where || ''}`).join(' · ')) : null);
  });
  setDirty(false);
  return h('div', { class: 'stack-s plan-editor' },
    area(t('page.purpose'), edits.purpose, (v) => { edits.purpose = v; }),
    h('p', { class: 'small muted' }, t('page.layout', { grid: plan.grid || '' })),
    h('ol', { class: 'plan-panels' }, panels),
    status,
    h('div', { class: 'row' }, saveBtn, h('span', { class: 'small muted' }, t('page.save_plan_hint'))));
}

function ledger(data) {
  const panels = (data.page.data && data.page.data.panels) || [];
  const names = new Map();
  for (const p of data.plan.panels) for (const c of p.cast) names.set(c.character, c.name);
  return h('div', { class: 'stack-s' },
    h('p', { class: 'muted' }, t('page.ledger_intro')),
    h('div', { class: 'table-wrap', tabIndex: 0, role: 'region', 'aria-label': t('page.ledger') },
      h('table', { class: 'ledger' },
        h('thead', null, h('tr', null,
          [t('page.col_panel'), t('page.col_who'), t('page.col_where'), t('page.col_facing'), t('page.col_wears'), t('page.col_holds'), t('page.col_state')].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, panels.flatMap((p, pi) => (p.cast && p.cast.length ? p.cast : [null]).map((c, ci) => h('tr', null,
          ci === 0 ? h('th', { scope: 'row', rowSpan: (p.cast && p.cast.length) || 1 }, String(p.order || pi + 1)) : null,
          c ? [
            h('td', null, names.get(c.character) || c.character, c.off_panel ? ` (${t('page.off_panel')})` : ''),
            h('td', null, c.position ? [c.position.level, c.position.side, c.position.landmark].filter(Boolean).join(', ') : ''),
            h('td', null, c.facing || ''),
            h('td', null, c.wardrobe || ''),
            h('td', null, [...(c.holding || []), c.carrying].filter(Boolean).join(', ')),
            h('td', null, (c.state || []).join(', ')),
          ] : h('td', { colSpan: 6, class: 'faint' }, t('page.nobody')))))))),
    data.page.data && data.page.data.continuity
      ? facts([
        [t('page.enters_from'), data.page.data.continuity.enters_from || t('form.none')],
        [t('page.exits_to'), data.page.data.continuity.exits_to || t('form.none')],
      ]) : null);
}

function referencesTab(data) {
  const entries = (data.reference_plan && data.reference_plan.entries) || [];
  if (!entries.length) return h('p', { class: 'muted' }, t('page.refs_none'));
  return h('ul', { class: 'ref-list' }, entries.map((e) => h('li', { class: 'ref-entry' },
    frame(e.image, { alt: e.asset_id, ratio: '1 / 1' }),
    h('div', null,
      h('strong', null, tv('ref_role', e.role, e.role)), ' ', h('span', { class: 'faint small' }, e.asset_id),
      h('p', { class: 'small' }, e.reason),
      h('p', { class: 'small faint' }, e.required ? t('page.ref_required') : t('page.ref_optional')))))) ;
}

function promptsTab(data) {
  if (!data.prompts || !data.prompts.length) return h('p', { class: 'muted' }, t('page.prompt_none'));
  return h('div', { class: 'stack' }, data.prompts.map((p) => h('div', { class: 'stack-s' },
    h('p', { class: 'small faint' }, p.path, ' · ', tv('prompt_mode', p.mode, p.mode)),
    p.stale && p.stale.length ? notice('warn', t('page.prompt_stale')) : null,
    h('pre', { class: 'prompt', tabIndex: 0 }, p.prompt),
    h('div', { class: 'row' }, copyButton(() => p.prompt)))));
}

export function view(ctx, data) {
  const name = pageName(data.id);
  ctx.title = name;
  const base = `/p/${encodeURIComponent(ctx.projectId)}`;
  const approval = data.plan_approval || {};
  const renders = data.renders || [];
  const current = renders.find((r) => r.current) || renders[renders.length - 1] || null;
  const shownId = renders.some((r) => r.id === ctx.ui.version) ? ctx.ui.version : (current && current.id);
  const shown = renders.find((r) => r.id === shownId) || null;
  const items = renderItems(renders);
  const passing = current && current.review && current.review.passes;
  const blockers = data.findings.blockers || [];
  const mine = (j) => {
    const p = j.params || {};
    if (j.op === 'pages.generate') return Array.isArray(p.pages) && p.pages.includes(data.id);
    return ['page.correct', 'page.review', 'page.manual'].includes(j.op) && (p.page === data.id || String(p.render || '').startsWith(data.id));
  };

  const approveBtn = approval.approved && !approval.stale
    ? actionButton(t('page.withdraw_approval'), async () => {
      await api.approvePlan(ctx.projectId, [data.id], false);
      ctx.refresh();
    }, { kind: 'quiet', small: true })
    : actionButton(t('page.approve_plan'), async () => {
      await api.approvePlan(ctx.projectId, [data.id]);
      toast(t('page.plan_approved_toast', { name }), { kind: 'ok' });
      ctx.refresh();
    }, { kind: 'primary' });

  const flip = (key, now) => {
    if (ctx.hasUnsaved()) {
      toast(t('editor.switch_needs_save'), { kind: 'warn' });
      return;
    }
    ctx.ui[key] = !now;
    ctx.refresh();
  };
  const showFile = !!ctx.ui.showFile;
  const advanced = !!ctx.ui.advanced;
  const fileToggle = h('button', { type: 'button', class: 'btn small quiet', 'aria-pressed': String(showFile), onclick: () => flip('showFile', showFile) }, t('editor.show_file'));
  const advToggle = h('button', { type: 'button', class: 'btn small quiet', 'aria-pressed': String(advanced), onclick: () => flip('advanced', advanced) }, t('page.advanced'));

  const text = h('div', { class: 'stack' },
    h('section', { class: `panel plan-state ${approval.approved && !approval.stale ? 'ok' : 'wait'}` },
      h('p', null, h('strong', null,
        approval.approved && !approval.stale ? t('pages.plan_approved')
          : (approval.stale ? t('page.plan_stale') : t('pages.plan_not_approved')))),
      h('p', { class: 'muted small' }, t('page.approval_meaning')),
      h('div', { class: 'row' }, approveBtn)),
    panel(t('mech.title'),
      mechanicalBox(data.findings),
      findingsList(data.findings.schema),
      blockers.length ? notice('warn', h('p', null, h('strong', null, t('page.blockers'))),
        h('ul', { class: 'bullets' }, blockers.map((b) => h('li', null, blockerText(b))))) : null),
    h('section', { class: 'panel stack-s' },
      h('div', { class: 'row spread' }, h('h2', { class: 'panel-title' }, t('page.plan_title')), h('div', { class: 'row' }, fileToggle, advToggle)),
      showFile
        ? docEditor(ctx, data.page, { key: 'page-file', form: false, rows: 24 })
        : planEditor(ctx, data)),
    advanced ? h('section', { class: 'panel' },
      tabs(ctx, 'adv', [
        { id: 'ledger', label: t('page.ledger'), render: () => ledger(data) },
        { id: 'refs', label: t('page.refs'), render: () => referencesTab(data) },
        { id: 'prompt', label: t('page.prompt'), render: () => promptsTab(data) },
        data.lettering && data.lettering.mode === 'overlay'
          ? { id: 'lettering', label: t('page.lettering_file'), render: () => docEditor(ctx, data.lettering.geometry, { key: 'lettering', form: false }) }
          : null,
      ], { label: t('page.advanced') })) : null);

  const drawBlock = [];
  if (!data.draw.available) {
    drawBlock.push(noDrawTool(data.draw.reason || t('pages.no_draw_tool')));
  } else if (!current) {
    drawBlock.push(h('div', { class: 'row' },
      actionButton(t('page.draw'), () => drawPages(ctx, [data.id], { unapproved: approval.approved && !approval.stale ? [] : [data.id] }), { kind: 'primary', disabled: blockers.length > 0 }),
      h('span', { class: 'small muted' }, t('pages.draw_time', { n: 1 }))));
  } else {
    drawBlock.push(h('div', { class: 'row' },
      actionButton(passing ? t('page.draw_new') : t('page.draw_again'), () => drawPages(ctx, [data.id], {
        unapproved: approval.approved && !approval.stale ? [] : [data.id],
        passing: passing ? [data.id] : [],
      }), { kind: passing ? 'quiet' : '' }),
      h('a', { class: 'btn quiet', href: `${base}/corrections/${data.id}` }, t('pages.link_correct'))));
  }

  const images = h('div', { class: 'stack' },
    jobsFor(mine),
    shown
      ? h('div', { class: 'stack-s' },
        frame(shown.lettered || shown.image, { alt: `${name}, ${versionName(shown.id)}`, onclick: () => openViewer(items, shown.id, { title: name }) }),
        h('div', { class: 'row spread' },
          h('span', null, h('strong', null, versionName(shown.id)), shown.current ? ` · ${t('page.current_version')}` : ''),
          queueLine(data.id)),
        shown.review ? h('p', null, verdictChip(Object.assign({}, shown.review)), ' ',
          h('a', { href: `${base}/check/${data.id}` }, t('page.see_evidence'))) : h('p', { class: 'muted' }, t('verdict.none')),
        renders.length > 1 ? versionStrip(items, shown.id, (id) => { ctx.ui.version = id; ctx.refresh(); }) : null)
      : h('div', { class: 'art-empty' }, h('h2', null, t('pages.not_drawn')),
        h('p', null, approval.approved && !approval.stale ? t('page.ready_to_draw') : t('page.approve_then_draw')),
        queueLine(data.id)),
    drawBlock,
    !data.draw.available || ctx.ui.manual
      ? panel(t('handoff.title'), handoff(ctx, `page:${data.id}`, { page: data.id }))
      : h('button', { type: 'button', class: 'link small', onclick: () => { ctx.ui.manual = true; ctx.refresh(); } }, t('handoff.offer')));

  const nav = [
    data.neighbors.previous ? h('a', { class: 'btn quiet small', href: `${base}/pages/${data.neighbors.previous}` }, `‹ ${pageName(data.neighbors.previous)}`) : null,
    data.neighbors.next ? h('a', { class: 'btn quiet small', href: `${base}/pages/${data.neighbors.next}` }, `${pageName(data.neighbors.next)} ›`) : null,
  ];

  return h('div', { class: 'screen' },
    screenHead({ title: name, lede: data.plan.purpose, back: { href: `${base}/pages`, label: t('screen.pages') }, actions: nav }),
    bench(ctx, { text, images, focus: current ? 'images' : 'text', chat: { key: data.chat_key, title: t('chat.title_about', { name }), examples: [t('page.example_1')] } }));
}
