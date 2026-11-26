// Settings: the language and the theme of the interface, and inside a
// project which AI tool does what.

import { h } from '/js/dom.js';
import { t, tv, getLang, LANGUAGES } from '/js/i18n.js';
import { api, errorText } from '/js/api.js';
import { state, loadHealth, getTheme, setTheme, refreshOverview, changeLanguage } from '/js/store.js';
import { screenHead } from '/js/components/bench.js';
import { panel, selectField, textField, actionButton, notice, radioField } from '/js/components/ui.js';
import { toolsPanel } from '/js/components/tools.js';
import { toast } from '/js/components/toast.js';
import { toolName } from '/js/labels.js';

export async function load(ctx) {
  const health = await loadHealth();
  const settings = ctx.projectId ? await api.settings(ctx.projectId) : null;
  return { health, settings };
}

function interfacePanel(ctx, data) {
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
  return panel(t('settings.interface'), h('div', { class: 'stack' }, lang.el, theme.el));
}

function toolsForm(ctx, data) {
  const s = data.settings.settings;
  const choices = data.settings.choices;
  const tools = data.settings.tools;
  const installed = data.settings.installed;
  const result = h('div');
  const verbs = ['plan', 'look', 'draw'];
  const drivers = {};
  for (const verb of verbs) {
    const now = tools[verb];
    drivers[verb] = selectField({
      label: t(`settings.verb.${verb}`),
      value: s.drivers[verb],
      options: choices[verb].map((c) => ({
        value: c,
        label: c === 'manual' ? t('settings.driver_manual') : `${toolName(c)}${installed[c] && !installed[c].installed ? ` (${t('tools.missing')})` : ''}`,
      })),
      hint: now.fallback
        ? t('settings.fallback', { tool: toolName(now.tool), wanted: toolName(now.requested) })
        : (!now.available ? t(`settings.unavailable.${verb}`) : t(`settings.verb_hint.${verb}`)),
    });
  }
  const model = (tool, verb) => textField({
    label: t('settings.model_for', { tool: toolName(tool), verb: tv('verb', verb) }),
    value: (s.models[tool] && s.models[tool][verb]) || '', optional: true, placeholder: t('settings.model_default'),
  });
  const models = {
    claude: { plan: model('claude', 'plan'), look: model('claude', 'look') },
    codex: { plan: model('codex', 'plan'), look: model('codex', 'look'), draw: model('codex', 'draw') },
  };
  const limit = textField({
    label: t('settings.repair_limit'), type: 'number', min: 0, max: 10, optional: true,
    value: s.repair_limit === null || s.repair_limit === undefined ? '' : String(s.repair_limit),
    hint: t('settings.repair_limit_hint', { limit: state.overview ? state.overview.repair_limit : '' }),
  });
  const save = async () => {
    result.replaceChildren();
    const body = {
      drivers: Object.fromEntries(verbs.map((v) => [v, drivers[v].value])),
      models: {
        claude: { plan: models.claude.plan.value.trim() || null, look: models.claude.look.value.trim() || null },
        codex: { plan: models.codex.plan.value.trim() || null, look: models.codex.look.value.trim() || null, draw: models.codex.draw.value.trim() || null },
      },
      repair_limit: limit.value === '' ? null : Number(limit.value),
    };
    try {
      await api.saveSettings(ctx.projectId, body);
      toast(t('settings.saved'), { kind: 'ok' });
      await refreshOverview();
      ctx.refresh();
    } catch (err) {
      result.append(notice('bad', errorText(err)));
    }
  };
  return panel(t('settings.tools_title'),
    h('form', { class: 'stack', onsubmit: (e) => e.preventDefault() },
      h('p', { class: 'muted' }, t('settings.tools_intro')),
      verbs.map((v) => drivers[v].el),
      h('details', { class: 'disclosure' }, h('summary', null, t('settings.models_title')),
        h('div', { class: 'disclosure-body stack-s' },
          h('p', { class: 'hint' }, t('settings.models_hint')),
          models.claude.plan.el, models.claude.look.el, models.codex.plan.el, models.codex.look.el, models.codex.draw.el)),
      limit.el,
      result,
      h('div', { class: 'row' }, actionButton(t('settings.save'), save, { kind: 'primary' }))));
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
      interfacePanel(ctx, data),
      data.settings ? toolsForm(ctx, data) : null,
      base ? h('p', { class: 'muted' }, t('settings.options_link_before'), ' ', h('a', { href: `${base}/style` }, t('screen.style')), '.') : null,
      panel(t('tools.title'), toolsPanel(data.health, { onChecked: () => ctx.refresh() })),
      h('p', { class: 'small faint' }, t('settings.version', { version: data.health.version }), ' · ', t('projects.home', { home: data.health.home }))));
}
