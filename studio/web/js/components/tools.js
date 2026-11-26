// Which tools were found on this machine, and what a missing one means.

import { h } from '/js/dom.js';
import { t } from '/js/i18n.js';
import { loadHealth } from '/js/store.js';
import { actionButton, notice } from '/js/components/ui.js';

function row(name, found, version, text) {
  return h('li', { class: 'tool-row', dataset: { found: String(found) } },
    h('div', { class: 'tool-name' },
      h('strong', null, name),
      h('span', { class: `tool-state ${found ? 'yes' : 'no'}` }, found ? t('tools.found') : t('tools.missing')),
      found && version && version !== 'fake' ? h('span', { class: 'faint small' }, version) : null),
    h('p', null, text));
}

/** toolsPanel(health, { onChecked }) */
export function toolsPanel(health, { onChecked } = {}) {
  if (!health) return h('p', { class: 'muted' }, t('state.loading'));
  const claude = health.tools.claude.installed;
  const codex = health.tools.codex.installed;
  const git = health.git.installed;
  return h('div', { class: 'tools-panel stack-s' },
    health.fake ? notice('info', h('strong', null, t('fake.chip')), ' ', t('fake.explain')) : null,
    !claude && !codex ? notice('bad', t('tools.none')) : null,
    h('ul', { class: 'tool-list' },
      row('Claude Code', claude, health.tools.claude.version, claude ? t('tools.claude_yes') : t('tools.claude_no')),
      row('Codex', codex, health.tools.codex.version, codex ? t('tools.codex_yes') : t('tools.codex_no')),
      row('git', git, health.git.version, git ? t('tools.git_yes') : t('tools.git_no'))),
    h('p', { class: 'small muted' }, t('tools.subscription')),
    h('div', { class: 'row' },
      actionButton(t('tools.check_again'), async () => {
        const fresh = await loadHealth(true);
        if (onChecked) onChecked(fresh);
      }, { kind: 'quiet', small: true })));
}
