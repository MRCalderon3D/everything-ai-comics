// The story: premise, tone, characters and facts the AI wrote from the
// description, all editable, the series plan, and source texts.

import { h } from '/js/dom.js';
import { t, tn, formatBytes } from '/js/i18n.js';
import { api } from '/js/api.js';
import { state } from '/js/store.js';
import { screenHead, bench } from '/js/components/bench.js';
import { tabs, notice, panel, actionButton, emptyState, textField } from '/js/components/ui.js';
import { docEditor, showFile } from '/js/components/editor.js';
import { askForm, queueOp } from '/js/components/ask.js';
import { uploader } from '/js/components/uploader.js';
import { jobsFor } from '/js/components/jobs.js';
import { toast } from '/js/components/toast.js';

const OPS = ['project.setup', 'story.update'];

export async function load(ctx) {
  return api.story(ctx.projectId);
}

function sourcesTab(ctx, data) {
  const up = uploader(ctx, { kind: 'text', multiple: false, key: 'source' });
  return h('div', { class: 'stack' },
    h('div', null,
      h('h3', null, t('story.sources_title')),
      data.sources.length
        ? h('ul', { class: 'file-list' }, data.sources.map((s) => h('li', null,
          h('button', { type: 'button', class: 'link', onclick: () => showFile(ctx.projectId, s.path) }, s.name),
          h('span', { class: 'faint small' }, ` ${formatBytes(s.bytes)}`))))
        : h('p', { class: 'muted' }, t('story.sources_none'))),
    h('div', { class: 'stack-s' },
      h('h3', null, t('story.upload_title')),
      h('p', { class: 'muted' }, t('story.upload_body')),
      up.el,
      h('div', { class: 'row' }, actionButton(t('story.upload_action'), async () => {
        const ids = up.ids();
        if (!ids.length) {
          toast(t('story.upload_need_file'), { kind: 'warn' });
          return;
        }
        await queueOp('story.update', { source_upload: ids[0] });
        up.clear();
      }))));
}

export function view(ctx, data) {
  ctx.title = t('screen.story');
  const project = state.overview.project;
  const working = jobsFor((j) => OPS.includes(j.op));

  if (!data.written) {
    const about = textField({
      label: t('new.field_about'), multiline: true, rows: 6, value: data.description || '', draft: ctx.draft('about'),
      hint: t('new.field_about_hint'),
    });
    return h('div', { class: 'screen narrow' },
      screenHead({ title: t('screen.story'), lede: t('story.lede_empty') }),
      working,
      emptyState(t('story.empty_title'), t('story.empty_body'),
        h('form', { class: 'stack-s grow', onsubmit: (e) => e.preventDefault() },
          about.el,
          h('div', { class: 'row' }, actionButton(t('story.write'), async () => {
            const text = about.value.trim();
            if (!text) {
              about.input.focus();
              toast(t('form.write_first'), { kind: 'warn' });
              return;
            }
            await queueOp('project.setup', { description: text });
            about.clear();
          }, { kind: 'primary' })))));
  }

  const text = h('div', { class: 'stack' },
    working,
    data.blocking_questions && data.blocking_questions.length
      ? notice('warn', h('p', null, h('strong', null, tn('story.blocking', data.blocking_questions.length))),
        h('ul', { class: 'bullets' }, data.blocking_questions.map((q) => h('li', null, q.question || String(q)))),
        h('p', { class: 'small' }, t('story.blocking_hint')))
      : null,
    panel(t('story.ask_title'),
      askForm(ctx, {
        key: 'ask',
        label: t('story.ask_label'),
        placeholder: t('story.ask_placeholder'),
        hint: t('story.ask_hint'),
        action: t('story.ask_action'),
        run: (instruction) => queueOp('story.update', { instruction }),
      })),
    h('section', { class: 'panel' },
      tabs(ctx, 'story', [
        { id: 'bible', label: t('story.tab_bible'), render: () => docEditor(ctx, data.bible, { key: 'bible', title: t('story.bible_title') }) },
        { id: 'plan', label: t('story.tab_plan'), render: () => docEditor(ctx, data.series_plan, { key: 'plan', title: t('story.plan_title') }) },
        { id: 'sources', label: t('story.tab_sources'), count: data.sources.length, render: () => sourcesTab(ctx, data) },
      ], { label: t('screen.story') })));

  return h('div', { class: 'screen' },
    screenHead({ title: t('screen.story'), lede: t('story.lede', { title: project.title }) }),
    bench(ctx, {
      text,
      images: null,
      chat: { key: data.chat_key, examples: [t('story.example_1'), t('story.example_2')] },
    }));
}
