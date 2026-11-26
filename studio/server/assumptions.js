'use strict';
/**
 * What the planner filled in to make a page drawable when the person's text
 * did not say it: where someone stands, what they hold, the background.
 * pages.plan stores them per page in <project>/.studio/assumptions.json, the
 * job result lists them, and the page detail shows them, so the person sees
 * each one and can change it in the plan.
 *
 * Shape on disk: { "<PAGE_ID>": [{ panel, text, job, at }] }. Planning a page
 * again replaces its list.
 */

const path = require('path');
const { readJson, writeJsonAtomic, nowIso } = require('./util');

const PAGE_RE = /^PG_\d{3}_\d{3}$/;
const PANEL_RE = /^PN_\d{3}_\d{3}_\d{2}$/;

function fileOf(project) {
  return path.join(project.studioDir, 'assumptions.json');
}

function readAll(project) {
  const doc = readJson(fileOf(project), {});
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
}

/**
 * The assumptions a tool returned, checked: [{ page, panel, text }]. An entry
 * about a page outside `pageIds`, or with no text, is dropped; a panel id
 * that does not belong to its page becomes null.
 */
function clean(list, pageIds) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const page = String(item.page || '');
    const text = String(item.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!PAGE_RE.test(page) || !text || (pageIds && !pageIds.includes(page))) continue;
    const panel = PANEL_RE.test(String(item.panel || '')) && String(item.panel).slice(3, 10) === page.slice(3) ? String(item.panel) : null;
    out.push({ page, panel, text });
  }
  return out;
}

/** Replace the assumptions of these pages. */
function save(project, pageIds, list, jobId) {
  const all = readAll(project);
  const at = nowIso();
  for (const page of pageIds) {
    all[page] = list.filter((a) => a.page === page).map((a) => ({ panel: a.panel, text: a.text, job: jobId || null, at }));
  }
  writeJsonAtomic(fileOf(project), all);
}

/** The assumptions of one page: [{ panel, text, job, at }]. */
function ofPage(project, pageId) {
  const list = readAll(project)[pageId];
  return Array.isArray(list) ? list : [];
}

module.exports = { clean, save, ofPage, fileOf };
