'use strict';
/**
 * How long AI calls take, per project: every call to a tool (planning,
 * looking, drawing) appends one line to <project>/.studio/timings.jsonl,
 * and the settings route shows the averages per tool, model and job, so the
 * interface can say "about 3 minutes per page with this model".
 *
 * A line: { at, tool, model, job, kind, op, ms, ok, pages }
 *   model  the model setting the call ran with; null is the tool's default
 *   job    plan, look or draw
 *   kind   what the call was: a prompt template (pages.plan, review, chat...)
 *          or, for a drawing, page, cover or sheet
 *   pages  how many pages the call worked on, when it worked on pages
 */

const path = require('path');
const { appendJsonl, readJsonl, nowIso } = require('./util');

const MAX_LINES = 5000;

function fileOf(project) {
  return path.join(project.studioDir, 'timings.jsonl');
}

/** Record one call. Never throws: a timing is not worth failing a job over. */
function record(project, entry) {
  try {
    const ms = Math.max(0, Math.round(Number(entry.ms) || 0));
    const pages = Number.isInteger(entry.pages) && entry.pages > 0 ? entry.pages : null;
    appendJsonl(fileOf(project), {
      at: nowIso(),
      tool: String(entry.tool || ''),
      model: entry.model ? String(entry.model) : null,
      job: String(entry.job || ''),
      kind: entry.kind ? String(entry.kind) : null,
      op: entry.op ? String(entry.op) : null,
      ms,
      ok: entry.ok !== false,
      pages,
    });
  } catch (err) {
    // the project went away, or the disk is full: keep going
  }
}

function round(n) {
  return Math.round(n);
}

/**
 * Averages per tool, model and job, newest data first in each group's
 * "last_at". Failed calls are counted, never averaged.
 * @returns {{tool, model, job, runs, failed, average_ms, per_page_ms, last_at,
 *            kinds: {[kind]: {runs, average_ms, per_page_ms}}}[]}
 */
function averages(project) {
  const lines = readJsonl(fileOf(project)).slice(-MAX_LINES);
  const groups = new Map();
  for (const line of lines) {
    if (!line || !line.tool || !line.job) continue;
    const key = `${line.tool}|${line.model || ''}|${line.job}`;
    if (!groups.has(key)) {
      groups.set(key, {
        tool: line.tool, model: line.model || null, job: line.job,
        runs: 0, failed: 0, total: 0, pageMs: 0, pages: 0, last_at: null, kinds: new Map(),
      });
    }
    const g = groups.get(key);
    if (!g.last_at || String(line.at) > g.last_at) g.last_at = line.at;
    if (line.ok === false) {
      g.failed += 1;
      continue;
    }
    g.runs += 1;
    g.total += line.ms;
    if (line.pages) {
      g.pageMs += line.ms;
      g.pages += line.pages;
    }
    const kind = line.kind || '-';
    if (!g.kinds.has(kind)) g.kinds.set(kind, { runs: 0, total: 0, pageMs: 0, pages: 0 });
    const k = g.kinds.get(kind);
    k.runs += 1;
    k.total += line.ms;
    if (line.pages) {
      k.pageMs += line.ms;
      k.pages += line.pages;
    }
  }
  return [...groups.values()]
    .map((g) => {
      const kinds = {};
      for (const [name, k] of g.kinds) {
        kinds[name] = { runs: k.runs, average_ms: round(k.total / k.runs), per_page_ms: k.pages ? round(k.pageMs / k.pages) : null };
      }
      return {
        tool: g.tool,
        model: g.model,
        job: g.job,
        runs: g.runs,
        failed: g.failed,
        average_ms: g.runs ? round(g.total / g.runs) : null,
        per_page_ms: g.pages ? round(g.pageMs / g.pages) : null,
        last_at: g.last_at,
        kinds,
      };
    })
    .sort((a, b) => (a.tool + a.job + (a.model || '')).localeCompare(b.tool + b.job + (b.model || '')));
}

module.exports = { record, averages, fileOf };
