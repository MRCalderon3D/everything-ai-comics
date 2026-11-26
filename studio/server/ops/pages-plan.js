'use strict';
/**
 * pages.plan: from a text of what happens to planned pages, for one page or
 * several, in an issue.
 *
 * Order, from docs/workflow.md (stage 3) and commands/smart-page.md: the
 * issue is broken into scenes and beats (issue-breakdown, with the location
 * and prop files a scene needs), each scene is taken to pages by smart-page
 * (layout, panel script, lettering text, ledger), and the two mechanical
 * gates run (check-continuity.js, validate-workspace.js). When they report
 * errors the plan gets one automatic fix pass and the gates run again.
 *
 * Reference plans and prompt packages are not written here: they depend on
 * approved masters, and pages.generate builds them right before it draws.
 * The result says, per page, what still blocks drawing.
 */

const S = require('../scaffold');
const { msg } = require('../i18n');
const pipeline = require('../pipeline');
const assumptions = require('../assumptions');
const { runAi } = require('../ai');
const { OpError } = require('../jobs');
const { HttpError } = require('../util');
const { str, int, matching, ISSUE_RE } = require('./shared');

function pageNumber(pageId) {
  return parseInt(String(pageId).slice(-3), 10);
}

module.exports = {
  name: 'pages.plan',
  params: [
    { name: 'text', type: 'string', required: true, description: 'What happens on these pages.' },
    { name: 'pages', type: 'integer', required: false, description: 'How many pages to spend, 1 to 24. Default 1.' },
    { name: 'issue', type: 'string', required: false, description: 'Issue ID. Default ISS_001.' },
  ],

  validate(params, { project }) {
    const issue = matching(params, 'issue', ISSUE_RE, { required: false, what: 'an issue ID such as ISS_001' }) || 'ISS_001';
    const plan = S.ws.loadYaml(S.ws.abs(project.root, 'story/series-plan.yaml'));
    const planned = plan && Array.isArray(plan.issues) && plan.issues.some((i) => i && i.id === issue);
    if (!planned && !S.ws.listIssues(project.root).includes(issue)) {
      throw new HttpError(404, 'issue_not_found', `${issue} is not in the series plan of this project.`);
    }
    return {
      issue,
      text: str(params, 'text', { required: true, max: 40000 }),
      pages: int(params, 'pages', { min: 1, max: 24, fallback: 1 }),
    };
  },

  steps() {
    return [
      { id: 'breakdown', label: msg('step.pages.plan.breakdown') },
      { id: 'pages', label: msg('step.pages.plan.pages') },
      { id: 'gates', label: msg('step.pages.plan.gates') },
      { id: 'fix', label: msg('step.pages.plan.fix') },
      { id: 'recheck', label: msg('step.pages.plan.recheck') },
      { id: 'ready', label: msg('step.pages.plan.ready') },
    ];
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const issue = params.issue;
    const provider = pipeline.compileProvider(project, ctx.services.drivers);

    const breakdown = await ctx.step('breakdown', async (h) => {
      const existing = S.ws.listPageIds(root, issue).sort();
      const last = existing[existing.length - 1] || null;
      const first = last ? pageNumber(last) + 1 : 1;
      if (first + params.pages - 1 > 999) throw new OpError('too_many_pages', 'An issue holds at most 999 pages.');
      const pageIds = [];
      for (let n = first; n < first + params.pages; n++) pageIds.push(`PG_${issue.slice(4)}_${String(n).padStart(3, '0')}`);
      const result = await runAi(ctx, h, {
        verb: 'plan',
        kind: 'pages.breakdown',
        vars: {
          issue,
          text: params.text,
          pages: params.pages,
          page_ids: pageIds.join(', '),
          page_list: pageIds,
          append: !!last,
          last_page: last || '',
          first_number: first,
        },
        fakeText: params.text,
        pages: params.pages,
      });
      return {
        page_ids: pageIds, summary: result.summary, decisions: result.decisions, tool: result.tool, data: result.data,
        assumptions: assumptions.clean(result.data.assumptions, pageIds),
      };
    }, { verb: 'plan' });
    const pageIds = breakdown.page_ids;

    const planned = await ctx.step('pages', async (h) => {
      const result = await runAi(ctx, h, {
        verb: 'plan',
        kind: 'pages.plan',
        vars: { issue, text: params.text, page_ids: pageIds.join(', '), page_list: pageIds, provider },
        fakeText: params.text,
        pages: params.pages,
      });
      const missing = pageIds.filter((id) => !S.ws.loadPage(root, id));
      if (missing.length) {
        throw new OpError('pages_missing', `The plan was not written for ${missing.join(', ')}.`, undefined, { pages: missing });
      }
      // What the planner had to fill in to make a page drawable, for the person to see and change.
      const filled = [...(breakdown.assumptions || []), ...assumptions.clean(result.data.assumptions, pageIds)];
      assumptions.save(project, pageIds, filled, ctx.job.id);
      return { summary: result.summary, decisions: result.decisions, tool: result.tool, assumptions: filled };
    }, { verb: 'plan' });

    const report = (h, result) => {
      for (const f of result.continuity.filter((x) => x.severity === 'error').slice(0, 30)) {
        h.log(`continuity ${f.code} ${f.panel || f.page || ''}: ${f.message}`);
      }
      for (const e of result.validation.errors.slice(0, 30)) h.log(`structure ${e.code} ${e.file}: ${e.message}`);
      h.note(result.errors ? msg('note.errors', { n: result.errors }) : msg('note.no_errors'));
    };
    let gates = await ctx.step('gates', (h) => {
      const result = pipeline.mechanical(root, issue);
      report(h, result);
      return result;
    });
    let fixed = false;
    if (gates.errors) {
      const errors = [
        ...gates.continuity.filter((f) => f.severity === 'error').map((f) => `- ${f.code} at ${f.panel || f.page || f.issue}: ${f.message}${f.hint ? ` Fix: ${f.hint}` : ''}`),
        ...gates.validation.errors.map((e) => `- ${e.code} in ${e.file}: ${e.message}`),
      ].slice(0, 60).join('\n');
      await ctx.step('fix', (h) => runAi(ctx, h, {
        verb: 'plan',
        kind: 'pages.fix',
        vars: { issue, errors },
        fakeText: params.text,
      }), { verb: 'plan' });
      fixed = true;
      gates = await ctx.step('recheck', (h) => {
        const result = pipeline.mechanical(root, issue);
        report(h, result);
        return result;
      });
    } else {
      ctx.skipStep('fix', msg('skip.no_errors'));
      ctx.skipStep('recheck', msg('skip.no_errors'));
    }

    const ready = await ctx.step('ready', () => pageIds.map((id) => {
      const page = S.ws.loadPage(root, id) || {};
      return {
        id,
        number: page.number || pageNumber(id),
        purpose: page.purpose || '',
        panels: Array.isArray(page.panels) ? page.panels.length : 0,
        blockers: pipeline.pageBlockers(root, id, provider),
      };
    }));

    return {
      issue,
      pages: ready,
      summary: planned.summary,
      decisions: [...(breakdown.decisions || []), ...(planned.decisions || [])],
      tool: planned.tool,
      assumptions: planned.assumptions || [],
      fix_pass: fixed,
      continuity: gates.continuity,
      validation: gates.validation,
      mechanical_errors: gates.errors,
    };
  },
};
