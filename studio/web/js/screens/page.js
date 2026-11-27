// One page: its plan in plain words, to edit or approve; the findings of the
// mechanical checks; its drawing and earlier versions. The ledger, the
// references and the prompt sit behind "advanced".

import { h, icon, nextId, mount } from '/js/dom.js';
import { t, tn, tv } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { screenHead, bench } from '/js/components/bench.js';
import { panel, actionButton, button, iconButton, notice, tabs, facts, copyButton, caption } from '/js/components/ui.js';
import { queueOp } from '/js/components/ask.js';
import { docEditor, findingsList } from '/js/components/editor.js';
import { autoGrow } from '/js/components/schema-form.js';
import { jobsFor } from '/js/components/jobs.js';
import { frame, openViewer, versionStrip } from '/js/components/viewer.js';
import { verdictChip } from '/js/components/verdict.js';
import { handoff, noDrawTool } from '/js/components/handoff.js';
import { slotWords } from '/js/components/correction.js';
import { toast } from '/js/components/toast.js';
import { pageName, versionName } from '/js/labels.js';
import { mechanicalBox, drawPages, queueLine, planningBox } from '/js/screens/pages.js';
import { newsMark } from '/js/components/news.js';
import { deleteButton } from '/js/components/deleting.js';
import { pageSheet, drawingWait } from '/js/components/artwork.js';
import { askInConversation } from '/js/components/conversation.js';
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
  const lettering = data.lettering || {};
  const limits = lettering.limits || { words_per_balloon: 25, words_per_panel: 50, per_panel: 4 };
  const status = h('div', { class: 'stack-s' });
  // What the last save said (findings, a drawn page that needs drawing again) survives the refresh it causes.
  const lastSave = ctx.ui.planSaved && ctx.ui.planSaved.page === data.id ? ctx.ui.planSaved : null;
  if (lastSave) status.replaceChildren(saveReport(ctx, data, lastSave.res));
  let confirmed = false;
  const saveBtn = actionButton(t('page.save_plan'), async () => {
    const empty = edits.panels.flatMap((p) => p.lettering || []).find((l) => !String(l.text || '').trim());
    if (empty) {
      toast(t('letter.empty_text'), { kind: 'warn' });
      const field = root.querySelector('textarea.letter-text-empty');
      if (field) field.focus();
      return;
    }
    const over = overLimits(edits, plan, limits);
    if (over.length && !confirmed) {
      status.replaceChildren(notice('warn',
        h('p', null, h('strong', null, t('letter.over_title'))),
        h('ul', { class: 'bullets' }, over.map((w) => h('li', null, overText(w)))),
        h('p', { class: 'small' }, t('letter.over_hint')),
        h('div', { class: 'row' },
          button(t('letter.save_anyway'), { kind: 'primary', small: true, onclick: () => { confirmed = true; saveBtn.click(); } }),
          button(t('letter.keep_editing'), { kind: 'quiet', small: true, onclick: () => status.replaceChildren() }))));
      return;
    }
    confirmed = false;
    try {
      const res = await api.savePlan(ctx.projectId, data.id, { data: edits, base_etag: doc.etag });
      setDirty(false);
      toast(res.saved ? t('page.plan_saved') : t('editor.unchanged'), { kind: 'ok' });
      ctx.ui.planSaved = { page: data.id, res: { findings: res.findings, continuity: res.continuity, lettering: res.lettering, redraw: res.redraw } };
      status.replaceChildren(saveReport(ctx, data, ctx.ui.planSaved.res));
      ctx.refresh();
    } catch (err) {
      status.replaceChildren(notice('bad', errorText(err)));
    }
  }, { kind: 'primary', icon: 'check' });
  const setDirty = (value) => {
    ctx.setDirty('plan', value);
    saveBtn.disabled = !value;
    if (value) confirmed = false;
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
  // Every character of the page with a name, for a voice from off panel.
  const pageCast = new Map();
  for (const p of plan.panels) for (const c of p.cast) if (!pageCast.has(c.character)) pageCast.set(c.character, c);
  const byId = new Map(edits.panels.map((p) => [p.id, p]));
  const panels = plan.panels.map((p) => {
    const target = byId.get(p.id);
    if (!target) return null;
    return h('li', { class: 'plan-panel' },
      h('h3', null, t('page.panel_n', { n: p.number }),
        h('span', { class: 'faint small' }, ` ${t('page.panel_meta', { size: tv('value', p.size, p.size), shot: tv('shot', p.shot, String(p.shot || '').replace(/_/g, ' ')) })}`,
          p.slot ? ` · ${slotWords(p.slot)}` : '')),
      area(t('page.moment'), target.moment, (v) => { target.moment = v; }),
      (target.cast || []).map((c) => {
        const shown = p.cast.find((s) => s.character === c.character) || {};
        return area(t('page.does', { name: shown.name || c.character }), c.action, (v) => { c.action = v; }, 1);
      }),
      letteringBlock(target, p, { limits, pageCast, kinds: lettering.kinds, spoken: lettering.spoken, onChange: () => setDirty(true) }),
      p.cast.length ? h('p', { class: 'small faint' }, p.cast.map((c) => `${c.name}: ${c.where || ''}`).join(' · ')) : null);
  });
  setDirty(false);
  const root = h('div', { class: 'stack-s plan-editor' },
    area(t('page.purpose'), edits.purpose, (v) => { edits.purpose = v; }),
    h('p', { class: 'small muted' }, t('page.layout', { grid: plan.grid || '' })),
    h('ol', { class: 'plan-panels' }, panels),
    status,
    h('div', { class: 'row' }, saveBtn, h('span', { class: 'small muted' }, t('page.save_plan_hint'))));
  return root;
}

const KINDS = ['balloon', 'thought', 'shout', 'whisper', 'radio', 'caption', 'narration', 'sfx', 'sign'];
const SPOKEN = ['balloon', 'thought', 'whisper', 'shout', 'radio'];

/** Words as the lettering rules count them: punctuation alone is no word. */
function words(text) {
  return String(text || '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Where a panel goes over the budgets of the lettering rules. */
function overLimits(edits, plan, limits) {
  const out = [];
  const numberOf = new Map(plan.panels.map((p) => [p.id, p.number]));
  for (const panel of edits.panels) {
    const list = panel.lettering || [];
    const n = numberOf.get(panel.id) || panel.order;
    let total = 0;
    list.forEach((l, i) => {
      const w = words(l.text);
      total += w;
      if (l.type !== 'sfx' && w > limits.words_per_balloon) out.push({ code: 'balloon_words', number: n, index: i + 1, words: w, limit: limits.words_per_balloon });
    });
    if (total > limits.words_per_panel) out.push({ code: 'panel_words', number: n, words: total, limit: limits.words_per_panel });
    const counted = list.filter((l) => l.type !== 'sfx').length;
    if (counted > limits.per_panel) out.push({ code: 'panel_count', number: n, count: counted, limit: limits.per_panel });
  }
  return out;
}

function overText(w) {
  if (w.code === 'balloon_words') return t('letter.over_balloon', { panel: w.number, n: w.index, words: w.words, limit: w.limit });
  if (w.code === 'panel_words') return t('letter.over_panel_words', { panel: w.number, words: w.words, limit: w.limit });
  return t('letter.over_panel_count', { panel: w.number, count: w.count, limit: w.limit });
}

/** Where the tail of an element points, said in words (the rule derives it; nothing is stored). */
function tailText(el, shownCast, pageCast) {
  if (!SPOKEN.includes(el.type)) return t('letter.tail_none');
  if (!el.speaker) return t('letter.tail_pick');
  const inPanel = shownCast.find((c) => c.character === el.speaker);
  const who = (inPanel || pageCast.get(el.speaker) || {}).name || el.speaker;
  if (inPanel && !inPanel.off_panel) return el.type === 'thought' ? t('letter.tail_thought', { name: who }) : t('letter.tail_mouth', { name: who });
  const side = (inPanel || pageCast.get(el.speaker) || {}).side;
  return side && side !== 'center' ? t(`letter.tail_edge_${side}`, { name: who }) : t('letter.tail_edge', { name: who });
}

/**
 * The lettering of one panel: each element with its kind, its speaker, its
 * words and where its tail points; add, remove and reorder; the budgets of
 * the lettering rules counted while typing.
 */
function letteringBlock(target, shown, { limits, pageCast, onChange }) {
  if (!Array.isArray(target.lettering)) target.lettering = [];
  const box = h('div', { class: 'letter-block' });
  const meter = h('p', { class: 'small letter-meter', 'aria-live': 'polite' });
  const drawn = shown.cast.filter((c) => !c.off_panel);
  const updateMeter = () => {
    const list = target.lettering;
    const counted = list.filter((l) => l.type !== 'sfx').length;
    const total = list.reduce((n, l) => n + words(l.text), 0);
    const over = counted > limits.per_panel || total > limits.words_per_panel;
    meter.classList.toggle('over', over);
    meter.textContent = t('letter.meter', { count: counted, max: limits.per_panel, words: total, limit: limits.words_per_panel });
  };
  const paint = (focusIndex) => {
    const items = target.lettering.map((el, i) => elementRow(el, i));
    box.replaceChildren(
      h('div', { class: 'row spread' }, h('h4', { class: 'letter-title' }, t('letter.title')), meter),
      items.length ? h('ol', { class: 'letter-list' }, items) : h('p', { class: 'small faint' }, t('letter.none')),
      h('div', { class: 'row' },
        button(t('letter.add'), { kind: 'quiet', small: true, icon: 'plus', onclick: () => {
          const first = drawn[0] || shown.cast[0];
          target.lettering.push({ type: first ? 'balloon' : 'caption', speaker: first ? first.character : null, text: '' });
          onChange();
          paint(target.lettering.length - 1);
        } })));
    updateMeter();
    if (focusIndex !== undefined) {
      const field = box.querySelectorAll('textarea')[focusIndex];
      if (field) field.focus();
    }
  };
  const move = (i, by) => {
    const j = i + by;
    if (j < 0 || j >= target.lettering.length) return;
    const [el] = target.lettering.splice(i, 1);
    target.lettering.splice(j, 0, el);
    onChange();
    paint();
    // Keep the focus on the moved element: the same arrow when it can go on, else the other one.
    const btns = [...box.querySelectorAll(`.letter-item:nth-child(${j + 1}) .letter-tools button`)];
    const next = [btns[by < 0 ? 0 : 1], btns[by < 0 ? 1 : 0], btns[2]].find((b) => b && !b.disabled);
    if (next) next.focus();
  };
  function elementRow(el, i) {
    const kindId = nextId('lk');
    const whoId = nextId('lw');
    const textId = nextId('lt');
    const glyph = h('span', { class: 'letter-glyph', 'aria-hidden': 'true' }, icon(KINDS.includes(el.type) ? el.type : 'balloon'));
    const kind = h('select', { id: kindId },
      KINDS.map((k) => h('option', { value: k, selected: k === el.type }, t(`letter_kind.${k}`))));
    // The speaker: the characters drawn in the panel, then a voice from off panel.
    const options = [];
    for (const c of shown.cast) options.push({ value: c.character, label: c.off_panel ? t('letter.off_panel_name', { name: c.name }) : c.name });
    for (const [id, c] of pageCast) if (!shown.cast.some((x) => x.character === id)) options.push({ value: id, label: t('letter.off_panel_name', { name: c.name }) });
    if (el.speaker && !options.some((o) => o.value === el.speaker)) options.push({ value: el.speaker, label: el.speaker });
    const who = h('select', { id: whoId },
      h('option', { value: '', selected: !el.speaker }, t('letter.pick_speaker')),
      options.map((o) => h('option', { value: o.value, selected: o.value === el.speaker }, o.label)));
    const whoField = h('div', { class: 'field letter-who' }, h('label', { for: whoId }, t('letter.speaker')), who);
    const text = h('textarea', { id: textId, rows: 1, class: el.text ? '' : 'letter-text-empty' });
    text.value = el.text || '';
    autoGrow(text);
    const count = h('span', { class: 'small letter-count' });
    const tail = h('p', { class: 'small faint letter-tail' });
    const refresh = () => {
      const spoken = SPOKEN.includes(el.type);
      whoField.hidden = !spoken;
      glyph.replaceChildren(icon(el.type));
      const w = words(el.text);
      count.textContent = el.type === 'sfx' ? tn('letter.words_sfx', w) : t('letter.words', { words: w, limit: limits.words_per_balloon });
      count.classList.toggle('over', el.type !== 'sfx' && w > limits.words_per_balloon);
      text.classList.toggle('letter-text-empty', !String(el.text || '').trim());
      tail.textContent = tailText(el, shown.cast, pageCast);
      updateMeter();
    };
    kind.addEventListener('change', () => {
      el.type = kind.value;
      if (!SPOKEN.includes(el.type)) el.speaker = null;
      else if (!el.speaker && options.length) {
        el.speaker = (drawn[0] || {}).character || options[0].value;
        who.value = el.speaker;
      }
      onChange();
      refresh();
    });
    who.addEventListener('change', () => {
      el.speaker = who.value || null;
      onChange();
      refresh();
    });
    text.addEventListener('input', () => {
      el.text = text.value;
      onChange();
      refresh();
    });
    const item = h('li', { class: 'letter-item' },
      h('div', { class: 'letter-head' },
        glyph,
        h('div', { class: 'field letter-kind' }, h('label', { for: kindId }, t('letter.kind')), kind),
        whoField,
        h('div', { class: 'letter-tools' },
          iconButton('up', t('letter.move_up'), { onclick: () => move(i, -1), disabled: i === 0 }),
          iconButton('down', t('letter.move_down'), { onclick: () => move(i, 1), disabled: i === target.lettering.length - 1 }),
          iconButton('trash', t('letter.remove'), { onclick: () => { target.lettering.splice(i, 1); onChange(); paint(); } }))),
      h('div', { class: 'field' }, h('label', { for: textId }, t('letter.words_label')), text),
      h('div', { class: 'row spread' }, tail, count));
    refresh();
    return item;
  }
  paint();
  return box;
}

/** What the last save of the plan said: its checks, voices added off panel, and what a drawn page needs now. */
function saveReport(ctx, data, res) {
  const out = [];
  const list = findingsList(res.findings);
  if (list) out.push(list);
  if (res.continuity && res.continuity.length) out.push(mechanicalBox({ continuity: res.continuity }));
  const numberOf = new Map((data.plan.panels || []).map((p) => [p.id, p.number]));
  const names = new Map();
  for (const p of data.plan.panels || []) for (const c of p.cast) names.set(c.character, c.name);
  const lettering = res.lettering || {};
  for (const a of lettering.added_cast || []) {
    out.push(notice('info', t('letter.added_off_panel', { name: names.get(a.character) || a.character, panel: numberOf.get(a.panel) || '' })));
  }
  if (lettering.warnings && lettering.warnings.length) {
    out.push(notice('warn', h('p', null, t('letter.saved_over')),
      h('ul', { class: 'bullets' }, lettering.warnings.map((w) => h('li', null, overText({
        code: w.code, number: w.number, words: w.words, count: w.count, limit: w.limit,
        index: (data.plan.panels.find((p) => p.id === w.panel) || { lettering: [] }).lettering.findIndex((l) => l.id === w.element) + 1,
      }))))));
  }
  if (res.redraw) {
    const reletter = res.redraw.mode === 'reletter';
    out.push(notice('warn',
      h('p', null, reletter ? t('letter.needs_reletter', { version: versionName(res.redraw.render) }) : t('letter.needs_redraw', { version: versionName(res.redraw.render) })),
      h('div', { class: 'row' },
        reletter
          ? actionButton(t('letter.reletter_now'), async () => {
            await queueOp('lettering.apply', { issue: data.issue, pages: [data.id] });
            ctx.ui.planSaved = null;
          }, { kind: 'primary', small: true })
          : actionButton(t('letter.redraw_now'), async () => {
            const current = (data.renders || []).find((r) => r.current);
            const passes = !!(current && current.review && current.review.passes);
            const job = await drawPages(ctx, [data.id], { unapproved: [data.id], passing: passes ? [data.id] : [] });
            if (job) ctx.ui.planSaved = null;
          }, { kind: 'primary', small: true }),
        button(t('letter.later'), { kind: 'quiet', small: true, onclick: () => { ctx.ui.planSaved = null; ctx.refresh(); } }))));
  }
  return out.length ? h('div', { class: 'stack-s' }, out) : h('div');
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

/**
 * What the planner filled in that the person's text did not say. Each one can
 * be changed: the change goes to the conversation from this page, which
 * edits the plan.
 */
function assumptionsPanel(ctx, data, name) {
  const list = data.assumptions || [];
  if (!list.length) return null;
  const numberOf = new Map((data.plan.panels || []).map((p) => [p.id, p.number]));
  const where = (a) => (a.panel ? t('page.panel_n', { n: numberOf.get(a.panel) || String(a.panel).slice(-2) }) : t('assume.whole_page'));
  return h('section', { class: 'panel' },
    h('h2', { class: 'panel-title' }, tn('assume.title', list.length)),
    h('p', { class: 'muted small' }, t('assume.intro')),
    h('ul', { class: 'assumptions' }, list.map((a, i) => {
      const item = h('li', { class: 'assumption' });
      const rest = () => mount(item,
        h('span', { class: 'assumption-where' }, where(a)),
        h('p', null, a.text),
        h('div', { class: 'row' }, button(t('assume.change'), { small: true, icon: 'pen', onclick: edit })));
      function edit() {
        const id = nextId('as');
        const area = h('textarea', { id, rows: 2, placeholder: t('assume.placeholder') });
        mount(item,
          h('span', { class: 'assumption-where' }, where(a)),
          h('p', null, a.text),
          h('label', { for: id, class: 'small' }, t('assume.instead')), area,
          h('div', { class: 'row' },
            actionButton(t('assume.send'), async () => {
              const instead = area.value.trim();
              if (!instead) { area.focus(); return; }
              await askInConversation(t('assume.message', { where: where(a).toLowerCase(), page: name, text: a.text, instead }), { send: true });
              toast(t('assume.sent'), { kind: 'ok' });
              rest();
            }, { kind: 'accent', small: true }),
            button(t('action.cancel'), { kind: 'quiet', small: true, onclick: rest })));
        area.focus();
      }
      rest();
      return item;
    })));
}

/**
 * The page's cast needs more reference images than the drawing tool takes:
 * the plain sentence, and the two things the person can do. Drawing panel by
 * panel changes how the page is drawn, not who is in it; a staging change is
 * asked for in the conversation as a proposal, never made on its own.
 */
function budgetPanel(ctx, data, name) {
  const list = (data.findings && data.findings.budget) || [];
  if (!list.length) return null;
  const perPanel = list.some((b) => b.actions.includes('per_panel'));
  const panels = [...new Set(list.flatMap((b) => b.panels_over || []))];
  return notice('warn',
    h('p', null, h('strong', null, t('budget.title'))),
    list.map((b) => h('p', null, b.message)),
    h('p', { class: 'small muted' }, t('budget.staging_rule')),
    h('div', { class: 'row' },
      perPanel ? actionButton(t('budget.per_panel'), async () => {
        const res = await api.pageMode(ctx.projectId, data.id, 'per_panel');
        toast(res.reference_plan && res.reference_plan.error ? res.reference_plan.error.message || t('budget.per_panel_done') : t('budget.per_panel_done'), { kind: res.reference_plan && res.reference_plan.error ? 'warn' : 'ok' });
        ctx.refresh();
      }, { kind: 'primary', small: true }) : null,
      actionButton(t('budget.staging'), async () => {
        await askInConversation(t('budget.staging_message', { page: name, panels: panels.join(', ') || '-' }), { send: true });
        toast(t('budget.staging_sent'), { kind: 'ok' });
      }, { small: true })),
    perPanel ? h('p', { class: 'small muted' }, t('budget.per_panel_hint')) : null);
}

/** A page drawn panel by panel: the panel images to put together, then the upload of the page. */
function panelsToAssemble(ctx, data) {
  if (data.generation_mode !== 'per_panel') return null;
  const items = (data.panel_images || []).map((p, i) => ({ id: p.panel, label: t('budget.panel_n', { n: i + 1 }), image: p.image }));
  return h('section', { class: 'panel stack-s panels-assemble' },
    h('h2', { class: 'panel-title' }, t('budget.assemble_title')),
    h('p', { class: 'small' }, items.length ? t('budget.assemble_body') : t('budget.per_panel_mode')),
    items.length ? h('div', { class: 'result-images' }, items.map((it) => h('a', {
      class: 'attach-thumb large', href: it.image.url, download: '', title: it.label, 'aria-label': t('budget.download_panel', { name: it.label }),
    }, h('img', { src: it.image.url, alt: '' })))) : null,
    h('div', { class: 'row' },
      actionButton(t('budget.whole_page'), async () => {
        await api.pageMode(ctx.projectId, data.id, 'full_page');
        ctx.refresh();
      }, { kind: 'quiet', small: true })));
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
    budgetPanel(ctx, data, name),
    assumptionsPanel(ctx, data, name),
    panel(t('mech.title'),
      data.planning ? planningBox(ctx, data.planning) : mechanicalBox(data.findings),
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

  const tiers = data.page.data && data.page.data.layout && Array.isArray(data.page.data.layout.tiers) ? data.page.data.layout.tiers : null;
  const openLarge = () => openViewer(items, shown.id, { title: name });
  const images = h('div', { class: 'stack' },
    newsMark(`page:${data.id}`),
    drawingWait(ctx, data.id, { tiers, name }),
    jobsFor(mine),
    panelsToAssemble(ctx, data),
    shown
      ? h('div', { class: 'stack-s' },
        pageSheet(ctx, data.id, shown.lettered || shown.image, { alt: `${name}, ${versionName(shown.id)}`, onOpen: openLarge }),
        h('div', { class: 'row spread' },
          h('span', null, h('strong', null, versionName(shown.id)), shown.current ? ` · ${t('page.current_version')}` : ''),
          h('span', { class: 'row' }, queueLine(data.id), button(t('page.view_large'), { kind: 'quiet', small: true, icon: 'zoom', onclick: openLarge }),
            // This version: the server refuses when an edition ships it or the next page was drawn from it.
            deleteButton(ctx, { kind: 'render', id: shown.id }, { label: t('page.delete_version') }))),
        shown.review ? h('p', null, verdictChip(Object.assign({}, shown.review)), ' ',
          h('a', { href: `${base}/check/${data.id}` }, t('page.see_evidence'))) : h('p', { class: 'muted' }, t('verdict.none')),
        renders.length > 1 ? versionStrip(items, shown.id, (id) => { ctx.ui.version = id; ctx.refresh(); }) : null)
      : h('div', { class: 'art-empty' }, h('h2', null, t('pages.not_drawn')),
        h('p', null, approval.approved && !approval.stale ? t('page.ready_to_draw') : t('page.approve_then_draw')),
        queueLine(data.id)),
    drawBlock,
    !data.draw.available || ctx.ui.manual || (data.panel_images || []).length
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
