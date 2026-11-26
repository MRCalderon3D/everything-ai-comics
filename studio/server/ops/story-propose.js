'use strict';
/**
 * The operations that ask the AI for story text: story.draft (a story bible
 * from the person's text), story.complete (what the story bible lacks) and
 * story.suggest (a free request, such as "suggest an ending"). Each runs one
 * read-only AI call and stores what comes back as a proposal
 * (studio/server/story.js). None of them writes canon.
 */

const fs = require('fs');
const S = require('../scaffold');
const story = require('../story');
const prompts = require('../prompts');
const { msg } = require('../i18n');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { HttpError } = require('../util');
const { str } = require('./shared');

/**
 * The person's text for the prompt: the description and the files under
 * story/source/, listed by path. `only` keeps one of them.
 */
function sourcesFor(project, only) {
  const files = story.sourceFiles(project).filter((rel) => !only || rel === only);
  return files;
}

/**
 * One AI call that returns a proposal, then the proposal stored. Used by the
 * three operations and by project.setup.
 * @returns {Promise<{proposal, parts, questions, summary, decisions, tool}>}
 */
async function propose(ctx, stepId, { mode, instruction, source }) {
  const { project } = ctx;
  const root = project.root;
  const sources = sourcesFor(project, source);
  const ai = await ctx.step(stepId, (h) => runAi(ctx, h, {
    verb: 'plan',
    kind: 'story.propose',
    vars: {
      draft: mode === 'draft',
      complete: mode === 'complete',
      suggest: mode === 'suggest',
      mode,
      instruction: instruction || '',
      sources: sources.length ? prompts.fileList(sources.map((rel) => S.ws.abs(root, rel))) : '(no source file: the person has not written any text yet)',
      source_list: sources,
      bible: S.ws.abs(root, story.BIBLE),
    },
    // Proposals are returned, never written: the run cannot touch the workspace.
    allowWrite: false,
    fakeText: [instruction || '', ...sources.map((rel) => {
      try {
        return fs.readFileSync(S.ws.abs(root, rel), 'utf8');
      } catch (err) {
        return '';
      }
    })].join('\n'),
  }), { verb: 'plan' });
  const data = ai.data && ai.data.proposal && typeof ai.data.proposal === 'object' ? ai.data.proposal : null;
  if (!data) throw new OpError('ai_bad_result', msg('error.ai_bad_result', { tool: ai.tool, detail: 'no proposal in the result' }));
  const proposal = story.create(project, {
    kind: mode, instruction, data, summary: ai.summary, decisions: ai.decisions, job: ctx.job.id, tool: ai.tool,
  });
  return {
    proposal: proposal.id,
    parts: proposal.parts.length,
    questions: proposal.parts.filter((p) => p.type === 'question').length,
    summary: ai.summary,
    decisions: ai.decisions,
    tool: ai.tool,
  };
}

/** An operation module for one mode. */
function makeOp(mode) {
  const name = `story.${mode}`;
  const params = {
    draft: [{ name: 'source', type: 'string', required: false, description: 'One file under story/source/ to draft from. Default: every file there, the description first.' }],
    complete: [],
    suggest: [{ name: 'instruction', type: 'string', required: true, description: 'What to propose, in the person\'s words, such as "suggest an ending".' }],
  }[mode];
  return {
    name,
    params,

    validate(input, { project }) {
      const out = {};
      if (mode === 'suggest') out.instruction = str(input, 'instruction', { required: true, max: 8000 });
      if (mode === 'draft') {
        const source = str(input, 'source', { max: 300 });
        if (source && !story.sourceFiles(project).includes(source)) {
          throw new HttpError(400, 'bad_params', `"source" must be a text file under story/source/; ${source} is not one.`);
        }
        out.source = source || null;
        if (!story.sourceFiles(project).length) {
          throw new HttpError(409, 'no_story_text', 'There is no text of yours to draft from: write a description or upload a source text first.');
        }
      }
      return out;
    },

    steps() {
      return [{ id: 'propose', label: msg(`step.story.${mode}.propose`) }];
    },

    async run(ctx) {
      return propose(ctx, 'propose', { mode, instruction: ctx.params.instruction, source: ctx.params.source });
    },
  };
}

module.exports = { makeOp, propose, sourcesFor };
