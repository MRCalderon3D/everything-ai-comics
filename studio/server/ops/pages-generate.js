'use strict';
/**
 * pages.generate: draw a list of pages in order. Per page: build the
 * reference plan, compile the prompt package for the draw provider, draw it
 * live through generate-assets.js, have the look driver review the render,
 * and repair it while the review says a repair can fix it and the project's
 * repair limit allows (a repair is a new render version and a new review).
 *
 * Pages are drawn one at a time. A page whose review passed is attached to
 * the next page as a continuity reference, by the scaffold's own rule in
 * build-reference-plan.js. A page that still fails is left flagged with its
 * evidence and the queue goes on; only a missing drawing tool stops it, or
 * a tool out of its usage quota, which pauses the job where it stopped
 * (jobs.js) with the pages not drawn yet left for later.
 *
 * A page set to be drawn panel by panel (generation.mode per_panel, chosen
 * when its cast needs more reference images than the drawing tool takes)
 * draws each panel as its own working image, one step per panel, each
 * carrying only that panel's references. The scaffold has no compositor, so
 * the page then waits for the person to put the panels together in the
 * layout and upload the page (page.manual), which is reviewed as any page.
 */

const S = require('../scaffold');
const { msg } = require('../i18n');
const pipeline = require('../pipeline');
const { OpError } = require('../jobs');
const { HttpError, errorText, nowIso } = require('../util');
const {
  bool, bad, matching, requireIssue, lookState, renderReviewRepair, rethrowIfFatal, ISSUE_RE, PAGE_RE,
} = require('./shared');

function numberOf(pageId) {
  return parseInt(String(pageId).slice(-3), 10);
}

/**
 * Draw a per_panel page: the reference plan built for panels, one package
 * and one drawing step per panel. A step already done (the job resumed after
 * the tool's quota came back) is not drawn again.
 */
async function drawPanels(ctx, target, pageId, n) {
  const root = ctx.project.root;
  const prepared = await ctx.step(`${pageId}:prepare`, (h) => {
    const plan = pipeline.buildPlan(root, pageId, target.provider);
    if (plan.doc.notes) h.log(String(plan.doc.notes));
    const page = S.ws.loadPage(root, pageId);
    const panels = (page.panels || []).filter((p) => p && p.id).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const out = panels.map((p, i) => {
      const compiled = pipeline.compilePage(root, pageId, target.provider, { model: target.model || undefined, panel: p.id });
      for (const warning of compiled.warnings) h.log(`warning: ${p.id}: ${warning}`);
      return { panel: p.id, number: i + 1, file: compiled.file, references: compiled.pkg.references.length };
    });
    if (['planned', 'scripted'].includes(page.status)) pipeline.setPageState(root, pageId, { status: 'prompted' });
    h.note(msg('note.per_panel', { n: out.length }));
    return { panels: out };
  });
  let after = `${pageId}:prepare`;
  const drawn = [];
  for (const item of prepared.panels) {
    const id = `${pageId}:panel-${item.panel}`;
    ctx.addStep({ id, label: msg('step.page.panel', { n, panel: item.number }) }, { after });
    after = id;
    const result = await ctx.step(id, async (h) => {
      h.setTool('codex');
      const out = await pipeline.draw(ctx, h, item.file);
      h.note(msg('note.panel_drawn', { panel: item.number }));
      return { panel: item.panel, file: out.file, record: out.record };
    }, { verb: 'draw' });
    drawn.push(result);
  }
  ctx.skipStep(`${pageId}:draw`, msg('skip.per_panel'));
  ctx.skipStep(`${pageId}:review`, msg('skip.assemble'));
  return { page: pageId, per_panel: true, panels: drawn, assemble: true };
}

module.exports = {
  name: 'pages.generate',
  params: [
    { name: 'pages', type: 'string[]', required: false, description: 'Page IDs to draw. Default: every page of the issue that has no passing render.' },
    { name: 'issue', type: 'string', required: false, description: 'Issue ID, used when "pages" is absent. Default ISS_001.' },
    { name: 'approve_plans', type: 'boolean', required: false, description: 'Record the person\'s approval of the page plans as part of this call (default false: plans must be approved first).' },
    { name: 'regenerate', type: 'boolean', required: false, description: 'Draw a fresh version of pages that already have a passing render (default false: they are skipped).' },
  ],

  validate(params, { project, services }) {
    const root = project.root;
    const regenerate = bool(params, 'regenerate', false);
    const approve = bool(params, 'approve_plans', false);
    let pages;
    if (params.pages !== undefined && params.pages !== null) {
      if (!Array.isArray(params.pages) || !params.pages.length || params.pages.length > 200) throw bad('"pages" must be a list of 1 to 200 page IDs.');
      pages = [...new Set(params.pages.map(String))];
      for (const id of pages) {
        if (!PAGE_RE.test(id)) throw bad(`"${id}" is not a page ID.`);
        if (!S.ws.loadPage(root, id)) throw new HttpError(404, 'page_not_found', `${id} does not exist in this project.`);
      }
    } else {
      const issue = matching(params, 'issue', ISSUE_RE, { required: false, what: 'an issue ID such as ISS_001' }) || 'ISS_001';
      requireIssue(project, issue);
      pages = S.ws.listPages(root, issue)
        .filter((p) => p.doc && (regenerate || !['reviewed', 'approved'].includes(p.doc.status)))
        .map((p) => p.id);
      if (!pages.length) throw new HttpError(409, 'nothing_to_draw', 'Every page of this issue already has a render that passed its check.');
    }
    pages.sort((a, b) => (a.slice(3, 6) === b.slice(3, 6) ? numberOf(a) - numberOf(b) : (a < b ? -1 : 1)));

    const pick = services.drivers.pick('draw', project.settings());
    if (!pick.available || !S.providerIds().includes('codex-cli')) {
      throw new HttpError(409, 'no_draw_tool',
        msg('error.no_draw_tool', { reason: pick.reason || msg('reason.no_codex_provider') }));
    }
    if (!lookState(project).master) {
      throw new HttpError(409, 'look_not_approved', 'Approve a look page first: every page is drawn from the approved look.');
    }
    if (!approve) {
      const approvals = project.state().plan_approvals || {};
      const pending = pages.filter((id) => {
        const page = S.ws.loadPage(root, id);
        const entry = approvals[id];
        return !entry || entry.hash !== S.pipeline.hashPage(page);
      });
      if (pending.length) {
        throw new HttpError(409, 'plan_not_approved',
          `The plan of ${pending.join(', ')} is not approved, or changed after it was. Approve it (POST /approve/plan) or send "approve_plans": true.`,
          { pages: pending }, { pages: pending });
      }
    }
    return { pages, approve_plans: approve, regenerate };
  },

  steps(params) {
    const out = [];
    for (const id of params.pages) {
      const n = numberOf(id);
      out.push({ id: `${id}:prepare`, label: msg('step.page.prepare', { n }) });
      out.push({ id: `${id}:draw`, label: msg('step.page.draw', { n }) });
      out.push({ id: `${id}:review`, label: msg('step.page.review', { n }) });
    }
    return out;
  },

  async run(ctx) {
    const { project, params } = ctx;
    const root = project.root;
    const target = pipeline.drawTarget(ctx);
    if (!target.available) throw new OpError('no_draw_tool', msg('error.no_draw_tool', { reason: target.reason }));

    if (params.approve_plans) {
      const approvals = Object.assign({}, project.state().plan_approvals);
      for (const id of params.pages) {
        approvals[id] = { hash: S.pipeline.hashPage(S.ws.loadPage(root, id)), at: nowIso() };
      }
      project.saveState({ plan_approvals: approvals });
    }

    const results = [];
    for (const pageId of params.pages) {
      const n = numberOf(pageId);
      const stepIds = [`${pageId}:prepare`, `${pageId}:draw`, `${pageId}:review`];
      const before = S.ws.loadPage(root, pageId);
      if (!before) {
        for (const id of stepIds) ctx.skipStep(id, msg('skip.page_gone'));
        results.push({ page: pageId, error: { code: 'page_missing', message: errorText({ code: 'page_missing', message: `${pageId} has no page.yaml.` }) } });
        continue;
      }
      if (!params.regenerate && ['reviewed', 'approved'].includes(before.status)) {
        for (const id of stepIds) ctx.skipStep(id, msg('skip.already_passed'));
        results.push({ page: pageId, render: before.current_render, skipped: true });
        continue;
      }
      try {
        if (before.generation && before.generation.mode === 'per_panel') {
          results.push(await drawPanels(ctx, target, pageId, n));
          continue;
        }
        const prepared = await ctx.step(`${pageId}:prepare`, (h) => {
          const plan = pipeline.buildPlan(root, pageId, target.provider);
          if (plan.doc.notes) h.log(String(plan.doc.notes));
          const compiled = pipeline.compilePage(root, pageId, target.provider, { model: target.model || undefined });
          for (const warning of compiled.warnings) h.log(`warning: ${warning}`);
          const page = S.ws.loadPage(root, pageId);
          if (page && ['planned', 'scripted'].includes(page.status)) pipeline.setPageState(root, pageId, { status: 'prompted' });
          h.note(msg('note.references', { n: compiled.pkg.references.length }));
          return { file: compiled.file, package: compiled.rel, references: compiled.pkg.references.map((r) => r.asset_id) };
        });
        const outcome = await renderReviewRepair(ctx, {
          owner: { kind: 'page', id: pageId, issue: S.ws.issueOfPage(pageId) },
          prefix: `${pageId}:`,
          kind: 'page',
          number: n,
          compileGenerate: () => ({ file: prepared.file }),
          compileRepair: (review) => pipeline.compilePage(root, pageId, target.provider, { repairReview: review, model: target.model || undefined }),
        });
        results.push(Object.assign({ page: pageId }, outcome));
      } catch (err) {
        rethrowIfFatal(err);
        for (const id of stepIds) ctx.skipStep(id, msg('skip.not_reached'));
        ctx.log(`${pageId} was not finished: ${err.message}`);
        results.push({ page: pageId, error: { code: typeof err.code === 'string' ? err.code : 'failed', message: errorText(err) } });
      }
    }

    const failed = results.filter((r) => r.error);
    const drawn = results.filter((r) => r.render && !r.skipped);
    const panelPages = results.filter((r) => r.per_panel);
    if (failed.length && !drawn.length && !panelPages.length && !results.some((r) => r.skipped)) {
      // The job fails with the reason of the first page that could not be drawn.
      throw new OpError(failed[0].error.code, failed[0].error.message, { pages: failed });
    }
    return {
      pages: results,
      passed: drawn.filter((r) => r.passes).length,
      with_notes: drawn.filter((r) => r.outcome === 'notes').length,
      flagged: drawn.filter((r) => r.flagged).length,
      failed: failed.length,
      to_assemble: panelPages.map((r) => r.page),
      tools: { draw: 'codex', look: ctx.job.tools.look || null },
    };
  },
};
