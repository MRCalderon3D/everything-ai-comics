'use strict';
/**
 * The story bible changes only through a proposal the person accepts
 * (TODO item 5, studio/server/story.js). Every AI call that may write files
 * runs inside this guard (studio/server/ai.js), except story.update, whose
 * job is to apply a change the person asked for in their own words.
 *
 * When a run changed story/story-bible.yaml anyway (a character run that
 * added an invented relative as a fact, say), the file is put back exactly
 * as it was, modification time included, so the step's commit never carries
 * the change. What the run wanted to add becomes a proposal (kind "guard"):
 * the new or changed premise and tone, and the world rules, facts, arcs,
 * timeline events and open questions that were not there before. The person
 * accepts, edits or rejects each part on the Story screen.
 */

const fs = require('fs');
const S = require('./scaffold');
const story = require('./story');

function read(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), stat: fs.statSync(file) };
  } catch (err) {
    return { text: null, stat: null };
  }
}

function parse(text) {
  if (!text) return {};
  try {
    const doc = S.yaml.parse(text);
    return doc && typeof doc === 'object' ? doc : {};
  } catch (err) {
    return {};
  }
}

const list = (value) => (Array.isArray(value) ? value : []);
const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** What `after` adds to or changes in `before`, as the proposal object story.create reads. */
function additions(before, after) {
  const out = {};
  if (typeof after.premise === 'string' && norm(after.premise) && norm(after.premise) !== norm(before.premise)) out.premise = after.premise;
  if (typeof after.tone === 'string' && norm(after.tone) && norm(after.tone) !== norm(before.tone)) out.tone = after.tone;
  const oldRules = new Set(list(before.world_rules).map((r) => norm(typeof r === 'string' ? r : r && r.text)));
  const rules = list(after.world_rules).map((r) => (typeof r === 'string' ? r : r && r.text)).filter((r) => r && !oldRules.has(norm(r)));
  if (rules.length) out.world_rules = rules;
  const oldFacts = new Set(list(before.facts).map((f) => norm(f && f.statement)));
  const facts = list(after.facts).filter((f) => f && f.statement && !oldFacts.has(norm(f.statement)))
    .map((f) => ({ statement: f.statement, provenance: f.provenance || 'addition', source_ref: f.source_ref, affects: f.affects }));
  if (facts.length) out.facts = facts;
  const oldArcs = new Set(list(before.characters).map((c) => `${c && c.id}|${norm(c && c.arc)}`));
  const arcs = list(after.characters).filter((c) => c && c.id && c.arc && !oldArcs.has(`${c.id}|${norm(c.arc)}`))
    .map((c) => ({ character: c.id, role: c.role, arc: c.arc }));
  if (arcs.length) out.arcs = arcs;
  const oldEvents = new Set(list(before.timeline).map((e) => norm(e && e.event)));
  const timeline = list(after.timeline).filter((e) => e && e.event && !oldEvents.has(norm(e.event)));
  if (timeline.length) out.timeline = timeline;
  const oldQuestions = new Set(list(before.open_questions).map((q) => norm(q && q.question)));
  const questions = list(after.open_questions).filter((q) => q && q.question && !oldQuestions.has(norm(q.question)));
  if (questions.length) out.questions = questions;
  return out;
}

/**
 * Run `fn` and undo whatever it did to the story bible.
 * @param {object} project
 * @param {() => Promise<any>} fn
 * @param {{log?: (line: string) => void, job?: object, tool?: string, instruction?: string}} [options]
 * @returns {Promise<{result: any, reverted: boolean, proposal: {id, parts}|null}>}
 *   When fn throws, the bible is still put back, and the error goes on.
 */
async function guard(project, fn, options = {}) {
  const file = S.ws.abs(project.root, story.BIBLE);
  const before = read(file);
  let result;
  let failure = null;
  try {
    result = await fn();
  } catch (err) {
    failure = err;
  }
  const now = read(file);
  let reverted = false;
  let proposal = null;
  if (now.text !== before.text) {
    reverted = true;
    if (before.text === null) fs.rmSync(file, { force: true });
    else {
      fs.writeFileSync(file, before.text);
      // Back to its old time too, so the step's diff sees no change.
      if (before.stat) fs.utimesSync(file, before.stat.atime, before.stat.mtime);
    }
    const data = additions(parse(before.text), parse(now.text));
    if (Object.keys(data).length) {
      const made = story.create(project, {
        kind: 'guard',
        instruction: options.instruction || null,
        data,
        summary: '',
        job: options.job ? options.job.id : null,
        tool: options.tool || null,
      });
      if (made.parts.length) {
        proposal = { id: made.id, parts: made.parts.length };
        if (options.job) {
          if (!Array.isArray(options.job.story_proposals)) options.job.story_proposals = [];
          options.job.story_proposals.push(proposal);
        }
      }
    }
    if (options.log) {
      options.log(proposal
        ? `the AI changed the story bible directly: the change was undone and its ${proposal.parts} part(s) wait as proposal ${proposal.id} for the person to decide`
        : 'the AI changed the story bible directly: the change was undone; story text goes through a proposal');
    }
  }
  if (failure) throw failure;
  return { result, reverted, proposal };
}

module.exports = { guard, additions };
