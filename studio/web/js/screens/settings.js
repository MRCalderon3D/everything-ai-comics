// Settings: the language and the theme of the interface, and inside a
// project who does each kind of work: for planning, checking and drawing,
// the tool and then a model from the list the installed tool offers, with
// what the work is for and how long it took with each model.

import { h, icon, nextId, mount } from '/js/dom.js';
import { t, tn, tv, getLang, LANGUAGES, formatDuration, formatDateTime } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state, loadHealth, getTheme, setTheme, refreshOverview, changeLanguage, loadTimings } from '/js/store.js';
import { screenHead } from '/js/components/bench.js';
import { panel, selectField, textField, notice, radioField, actionButton, checkField } from '/js/components/ui.js';
import { toolsPanel } from '/js/components/tools.js';
import { toast } from '/js/components/toast.js';
import { toolName } from '/js/labels.js';

const VERBS = ['plan', 'look', 'draw'];

export async function load(ctx) {
  const health = await loadHealth();
  const settings = ctx.projectId ? await api.settings(ctx.projectId) : null;
  return { health, settings };
}

function interfacePanel(ctx) {
  const lang = selectField({
    label: t('settings.interface_language'), value: getLang(),
    options: LANGUAGES.map((l) => ({ value: l, label: tv('language', l, l) })),
    hint: ctx.projectId ? t('settings.language_project_hint') : t('settings.language_local_hint'),
    onchange: async (value) => {
      try {
        await changeLanguage(value);
      } catch (err) {
        toast(errorText(err), { kind: 'bad' });
      }
    },
  });
  const theme = radioField({
    legend: t('settings.theme'), value: getTheme(),
    options: [
      { value: 'auto', label: t('theme.auto'), hint: t('theme.auto_hint') },
      { value: 'light', label: t('theme.light') },
      { value: 'dark', label: t('theme.dark') },
    ],
    onchange: (value) => setTheme(value),
  });
  return panel(t('settings.interface'), h('div', { class: 'field-pair' }, lang.el, theme.el));
}

/** The measured time of one model for one kind of work, in words, or null. */
function timingText(timings, tool, model, verb) {
  const e = (timings || []).find((x) => x.tool === tool && (x.model || null) === (model || null) && x.job === verb && x.runs > 0);
  if (!e) return null;
  if ((e.per_page_ms || e.average_ms) < 1000) return tn('settings.measured_quick', e.runs);
  if (e.per_page_ms) return tn('settings.measured_page', e.runs, { time: formatDuration(e.per_page_ms / 1000) });
  return tn('settings.measured_call', e.runs, { time: formatDuration(e.average_ms / 1000) });
}

/** One kind of work: what it is for, the tool, then the model. */
function jobSetting(ctx, data, verb, save) {
  const s = data.settings.settings;
  const installed = data.settings.installed;
  const now = data.settings.tools[verb];
  const choices = data.settings.choices[verb].filter((c) => c === 'manual' || (installed[c] && installed[c].installed && (installed[c].jobs || []).includes(verb)));
  const driver = s.drivers[verb];
  const tool = driver === 'manual' ? null : driver;
  const info = tool ? installed[tool] : null;
  const nodes = [h('h3', null, t(`settings.verb.${verb}`)), h('p', { class: 'job-why' }, t(`settings.why.${verb}`))];

  if (verb === 'draw' && !(installed.codex && installed.codex.installed)) {
    nodes.push(notice('info', t('settings.draw_by_hand')));
    return h('section', { class: 'job-setting' }, nodes);
  }
  if (!choices.length) {
    nodes.push(notice('warn', t(`settings.unavailable.${verb}`)));
    return h('section', { class: 'job-setting' }, nodes);
  }

  // The tool: a choice only when there is one to make.
  if (choices.length > 1) {
    nodes.push(h('div', { class: 'segmented', role: 'group', 'aria-label': t('settings.tool_for', { verb: t(`settings.verb.${verb}`) }) },
      choices.map((c) => h('button', {
        type: 'button', class: 'btn small', 'aria-pressed': String(c === driver),
        onclick: () => { if (c !== driver) save({ drivers: { [verb]: c } }, t('settings.tool_saved', { tool: c === 'manual' ? t('settings.driver_manual') : toolName(c) })); },
      }, c === 'manual' ? t('settings.driver_manual') : toolName(c)))));
  } else {
    nodes.push(h('p', { class: 'small' }, t('settings.only_tool', { tool: choices[0] === 'manual' ? t('settings.driver_manual') : toolName(choices[0]) })));
  }
  if (now.fallback) nodes.push(notice('warn', t('settings.fallback', { tool: toolName(now.tool), wanted: toolName(now.requested) })));
  if (!tool) {
    nodes.push(h('p', { class: 'muted small' }, t('settings.manual_hint')));
    return h('section', { class: 'job-setting' }, nodes);
  }

  // The model: the tool's default, a model of its list, or a name typed by hand.
  const current = (s.models[tool] && s.models[tool][verb]) || null;
  const status = (data.settings.model_status[tool] || {})[verb];
  const models = (info && info.models) || [];
  const def = models.find((m) => m.default);
  const name = nextId('model');
  const option = (value, title, note, extra, time) => {
    const id = nextId('m');
    const input = h('input', { type: 'radio', name, id, value: value || '', checked: (value || null) === (status === 'custom' ? '__custom' : current) });
    input.addEventListener('change', () => {
      if (value === '__custom') { custom.focus(); return; }
      save({ models: { [tool]: { [verb]: value || null } } }, t('settings.model_saved'));
    });
    return h('div', { class: 'model-option' }, input,
      h('label', { for: id },
        h('span', { class: 'm-name' }, title, extra),
        note ? h('span', { class: 'm-note' }, note) : null,
        h('span', { class: 'm-time' }, time || '')));
  };
  const customId = nextId('cm');
  const custom = h('input', { type: 'text', id: customId, value: status === 'custom' ? current || '' : '', placeholder: t('settings.custom_placeholder'), maxLength: 80 });
  custom.addEventListener('change', () => {
    const v = custom.value.trim();
    if (v) save({ models: { [tool]: { [verb]: v } } }, t('settings.model_saved'));
  });
  custom.addEventListener('focus', () => {
    const r = custom.closest('.job-setting').querySelector('input[value="__custom"]');
    if (r) r.checked = true;
  });
  const list = h('div', { class: 'model-list', role: 'radiogroup', 'aria-label': t('settings.model_for_job', { verb: t(`settings.verb.${verb}`) }) },
    option(null, t('settings.model_default'), def ? t('settings.default_is', { name: def.label || def.id }) : t('settings.default_unknown'), null, timingText(data.settings.timings, tool, null, verb)),
    models.map((m) => option(m.id, m.label || m.id, m.note,
      [m.default ? h('span', { class: 'chip next' }, t('settings.chip_default')) : null,
        m.alias_of ? h('span', { class: 'chip' }, t('settings.alias_of', { id: m.alias_of })) : null],
      timingText(data.settings.timings, tool, m.id, verb))),
    h('div', { class: 'model-option' },
      h('input', { type: 'radio', name, id: `${customId}-r`, value: '__custom', checked: status === 'custom' }),
      h('label', { for: `${customId}-r` }, h('span', { class: 'm-name' }, t('settings.custom')),
        h('span', { class: 'm-note' }, t('settings.custom_hint')))),
    h('div', { class: 'model-custom' }, h('label', { for: customId, class: 'sr-only' }, t('settings.custom')), custom));
  nodes.push(list);
  if (!models.length) nodes.push(notice('info', t('settings.no_models')));
  if (info && info.models_source) {
    nodes.push(h('details', { class: 'small' }, h('summary', { class: 'muted' }, t('settings.list_from')),
      h('p', { class: 'small muted' }, info.models_source.note || '',
        info.models_detected_at ? ` ${t('settings.detected_at', { when: formatDateTime(info.models_detected_at) })}` : '')));
  }
  return h('section', { class: 'job-setting' }, nodes);
}

function toolsForm(ctx, data) {
  const s = data.settings.settings;
  const result = h('div');
  const save = async (body, message) => {
    result.replaceChildren();
    try {
      await api.saveSettings(ctx.projectId, body);
      toast(message || t('settings.saved'), { kind: 'ok' });
      await refreshOverview();
      loadTimings();
      ctx.refresh();
    } catch (err) {
      result.append(notice('bad', errorText(err)));
    }
  };
  const limit = textField({
    label: t('settings.repair_limit'), type: 'number', min: 0, max: 10, optional: true,
    value: s.repair_limit === null || s.repair_limit === undefined ? '' : String(s.repair_limit),
    hint: t('settings.repair_limit_hint', { limit: state.overview ? state.overview.repair_limit : '' }),
  });
  limit.input.addEventListener('change', () => save({ repair_limit: limit.value === '' ? null : Number(limit.value) }));
  const autoRun = checkField({
    label: t('settings.chat_auto_run'), checked: !!s.chat_auto_run, hint: t('settings.chat_auto_run_hint'),
    onchange: (on) => save({ chat_auto_run: on }),
  });
  return h('section', { class: 'panel' },
    h('div', { class: 'row spread' },
      h('h2', { class: 'panel-title' }, t('settings.tools_title')),
      actionButton(t('settings.refresh_models'), async () => {
        await api.refreshTools();
        await loadHealth(true);
        toast(t('settings.refreshed'), { kind: 'ok' });
        ctx.refresh();
      }, { kind: 'quiet', small: true, icon: 'refresh' })),
    h('p', { class: 'muted' }, t('settings.tools_intro')),
    result,
    VERBS.map((v) => jobSetting(ctx, data, v, save)),
    h('div', { class: 'job-setting' }, limit.el),
    h('div', { class: 'job-setting' }, autoRun.el));
}

/**
 * How many touch-ups an image takes before a correction warns and offers a
 * redraw (project.repair_policy.touch_up_warning). It lives in project.yaml,
 * so the scaffold reads the same number.
 */
function touchUpPanel(ctx) {
  const result = h('div');
  const current = state.overview && Number.isInteger(state.overview.touch_up_warning) ? state.overview.touch_up_warning : 2;
  const field = textField({
    label: t('settings.touch_up_warning'), type: 'number', min: 0, max: 10, value: String(current),
    hint: t('settings.touch_up_warning_hint'),
  });
  field.input.addEventListener('change', async () => {
    result.replaceChildren();
    const value = Number(field.value);
    if (field.value === '' || !Number.isInteger(value) || value < 0 || value > 10) {
      result.append(notice('bad', t('settings.touch_up_warning_bad')));
      return;
    }
    try {
      await api.saveOptions(ctx.projectId, { touch_up_warning: value });
      toast(t('settings.saved'), { kind: 'ok' });
      await refreshOverview();
      ctx.refresh();
    } catch (err) {
      result.append(notice('bad', errorText(err)));
    }
  });
  return panel(t('settings.touch_up_title'), field.el, result);
}

export function view(ctx, data) {
  ctx.title = t('nav.settings');
  const base = ctx.projectId ? `/p/${encodeURIComponent(ctx.projectId)}` : null;
  return h('div', { class: 'screen narrow' },
    screenHead({
      title: t('nav.settings'),
      lede: ctx.projectId ? t('settings.lede_project', { title: state.overview.project.title }) : t('settings.lede'),
      back: ctx.projectId ? null : { href: '/', label: t('nav.projects') },
    }),
    h('div', { class: 'stack' },
      data.settings ? toolsForm(ctx, data) : null,
      data.settings ? touchUpPanel(ctx) : null,
      interfacePanel(ctx),
      base ? h('p', { class: 'muted' }, icon('right'), ' ', t('settings.options_link_before'), ' ', h('a', { href: `${base}/style` }, t('screen.style')), '.') : null,
      panel(t('tools.title'), toolsPanel(data.health, { onChecked: () => ctx.refresh() })),
      h('details', { class: 'details-box' }, h('summary', null, t('form.details')),
        h('p', { class: 'small' }, t('settings.version', { version: data.health.version })),
        h('p', { class: 'small' }, t('projects.home', { home: data.health.home })))));
}
