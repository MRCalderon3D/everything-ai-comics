#!/usr/bin/env node
'use strict';
/**
 * build-board.js: compose a one-page HTML board of an issue.
 *
 * Reads the issue's real files (project.yaml, issue.yaml, every page.yaml,
 * the review files, the renders on disk) and writes one self-contained HTML
 * file: per page its number, side, purpose, grid, a schematic of the tiers,
 * the panels with size, framing, moment, cast and lettering count, the page
 * status, a thumbnail of the current render, the review verdict with open
 * findings, and the result of the panel-ledger check when
 * scripts/check-continuity.js is available.
 *
 * Nothing is generated or judged here. The board shows what the files say;
 * missing pieces appear as labelled placeholders and never stop the build.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs, helpIfRequested } = require('./lib/cli');
const { writeFileEnsuring } = require('./lib/fsx');
const ws = require('./lib/workspace');
const { escapeXml: esc, fmt } = require('./lib/svg');

const HELP = `
build-board.js: one-page HTML board of an issue.

Usage:
  node scripts/build-board.js --issue <issues/ISS_001 dir> [--out <file.html>]

Options:
  --issue <dir>   Issue directory (contains issue.yaml and pages/). Required.
  --out <file>    Output HTML (default: <issue dir>/board.html).
  --help          Show this help.

The board lists every page of the issue with its plan (grid, tiers, panels),
its status, a thumbnail of the current render, the recorded review verdict
with open findings, and the panel-ledger check when check-continuity.js is
installed. Images are linked with relative paths, so keep the board inside
the workspace. The file is rewritten on every run.

The board reports what the workspace files say. It does not look at artwork:
a verdict shown here is the one recorded in the review file.
`;

const SIZE_WIDTH = { splash: 3, wide: 1.6, large: 1.4, medium: 1, small: 0.75, inset: 0.5 };
const SIZE_HEIGHT = { splash: 3, wide: 1, large: 1.3, medium: 1, small: 0.8, inset: 0.7 };

function safe(fn, fallback, warnings) {
  try {
    return fn();
  } catch (err) {
    if (warnings) warnings.push(err.message);
    return fallback;
  }
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** Panels of a page grouped into tiers, top to bottom, each tier in reading order. */
function panelsByTier(page) {
  const layout = (page && page.layout) || {};
  const panels = list(page && page.panels).filter((p) => p && typeof p === 'object')
    .slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const counts = list(layout.tiers).filter((n) => Number.isInteger(n) && n > 0);
  const tiers = [];
  if (panels.length && panels.every((p) => Number.isInteger(p.tier) && p.tier >= 1)) {
    for (const panel of panels) {
      (tiers[panel.tier - 1] = tiers[panel.tier - 1] || []).push(panel);
    }
    return tiers.filter(Boolean);
  }
  let at = 0;
  for (const count of counts) {
    tiers.push(panels.slice(at, at + count));
    at += count;
  }
  if (at < panels.length) tiers.push(panels.slice(at));
  return tiers.filter((t) => t.length);
}

/** Small SVG diagram of the page's tiers and panels. A schematic, not a layout. */
function tierSchematic(page, project) {
  const tiers = panelsByTier(page);
  if (!tiers.length) return '<p class="note">No panels planned.</p>';
  const ratio = /^\d+:\d+$/.test(String((project.page || {}).aspect_ratio || ''))
    ? String(project.page.aspect_ratio).split(':').map(Number) : [2, 3];
  const W = 132;
  const H = Math.round(Math.max(90, Math.min(260, ratio[0] > 0 ? (W * ratio[1]) / ratio[0] : 198)));
  const margin = 5;
  const gutter = 3;
  const rtl = project.reading_direction === 'rtl';
  const heights = tiers.map((tier) => Math.max(...tier.map((p) => SIZE_HEIGHT[p.size] || 1)));
  const totalHeight = heights.reduce((a, b) => a + b, 0);
  const usableHeight = H - 2 * margin - gutter * (tiers.length - 1);
  const out = [`<svg class="schematic" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="tier schematic of ${esc(page.id || 'page')}">`];
  out.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="#f4f1ea" stroke="#3a4048"/>`);
  let y = margin;
  tiers.forEach((tier, t) => {
    const tierHeight = (usableHeight * heights[t]) / totalHeight;
    const row = rtl ? tier.slice().reverse() : tier;
    const widths = row.map((p) => SIZE_WIDTH[p.size] || 1);
    const totalWidth = widths.reduce((a, b) => a + b, 0);
    const usableWidth = W - 2 * margin - gutter * (row.length - 1);
    let x = margin;
    row.forEach((panel, i) => {
      const width = (usableWidth * widths[i]) / totalWidth;
      out.push(`<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(width)}" height="${fmt(tierHeight)}" fill="#fff" stroke="#1c1c1c" stroke-width="1.2"><title>${esc(panel.id || '')} ${esc(panel.size || '')}</title></rect>`);
      out.push(`<text x="${fmt(x + width / 2)}" y="${fmt(y + tierHeight / 2 + 4)}" text-anchor="middle" font-size="11" fill="#1c1c1c">${esc(panel.order != null ? panel.order : '')}</text>`);
      x += width + gutter;
    });
    y += tierHeight + gutter;
  });
  out.push('</svg>');
  return out.join('');
}

function framingLine(panel) {
  const f = panel.framing || {};
  return [f.shot_size, f.angle, f.view].filter(Boolean).map((s) => String(s).replace(/_/g, ' ')).join(', ');
}

function castLine(panel) {
  return list(panel.cast).filter((c) => c && c.character)
    .map((c) => String(c.character).replace(/^CHAR_/, '') + (c.off_panel ? ' (off panel)' : ''))
    .join(', ');
}

function badge(text, kind) {
  return `<span class="badge ${esc(kind || '')}">${esc(text)}</span>`;
}

function verdictKind(verdict) {
  if (verdict === 'pass' || verdict === 'fixed') return 'good';
  if (verdict === 'flagged') return 'bad';
  return 'none';
}

/** Load the ledger checker when another script provides it. */
function loadLedgerCheck() {
  try {
    const mod = require('./check-continuity');
    return mod && typeof mod.checkContinuity === 'function' ? mod.checkContinuity : null;
  } catch (err) {
    return null;
  }
}

function pageSection(root, outDir, project, entry, ledger, warnings) {
  const page = entry.doc;
  if (!page || typeof page !== 'object') {
    return `<section class="page" id="${esc(entry.id)}"><h2>${esc(entry.id)} ${badge('no page.yaml', 'bad')}</h2></section>`;
  }
  const layout = page.layout || {};
  const panels = list(page.panels).filter((p) => p && typeof p === 'object')
    .slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const letteringTotal = panels.reduce((n, p) => n + list(p.lettering).length, 0);

  // --- render and review ------------------------------------------------------
  const current = page.current_render || null;
  const renderPath = current ? ws.renderFile(root, current) : null;
  const thumb = renderPath
    ? `<a href="${esc(path.relative(outDir, renderPath).split(path.sep).join('/'))}"><img src="${esc(path.relative(outDir, renderPath).split(path.sep).join('/'))}" alt="${esc(current)}" loading="lazy"></a><figcaption>${esc(current)}</figcaption>`
    : `<div class="ph">${current ? `${esc(current)}<br><span>file not found</span>` : 'no render yet'}</div>`;

  const reviews = safe(() => ws.listReviews(root, entry.id), [], warnings);
  const renderIds = [...new Set([...safe(() => ws.listRenders(root, entry.id), [], warnings), ...reviews.map((r) => r.render)])].sort();
  const reviewOf = (id) => {
    const found = reviews.find((r) => r.render === id);
    return found && found.doc ? found.doc : null;
  };
  const review = current ? reviewOf(current) : null;
  const reviewBits = [];
  if (!current) reviewBits.push('<p class="note">Nothing to review yet.</p>');
  else if (!review) reviewBits.push(`<p>${badge('no review', 'none')} ${esc(current)} has no review file.</p>`);
  else {
    const gates = review.gates || {};
    reviewBits.push(`<p>${badge(review.verdict || 'no verdict', verdictKind(review.verdict))} ${esc(current)}` +
      (review.repair_cycle != null ? `, repair cycle ${esc(review.repair_cycle)}` : '') +
      (gates.style_fidelity ? `, style ${esc(gates.style_fidelity)}` : '') +
      (gates.narrative_continuity ? `, continuity ${esc(gates.narrative_continuity)}` : '') +
      (review.human_approval && review.human_approval.status ? `, human approval ${esc(review.human_approval.status)}` : '') + '</p>');
    const open = list(review.findings).filter((f) => f && f.status === 'open');
    if (open.length) {
      reviewBits.push('<ul class="findings">' + open.map((f) =>
        `<li>${badge(f.severity || 'open', f.severity === 'blocking' ? 'bad' : 'warn')} <b>${esc(f.id || '')}</b> ${esc(f.check || '')}${f.panel ? ` in ${esc(f.panel)}` : ''}: ${esc(f.visible || '')}` +
        (f.expected ? ` <span class="dim">Expected: ${esc(f.expected)}</span>` : '') + '</li>').join('') + '</ul>');
    } else {
      reviewBits.push('<p class="note">No open findings.</p>');
    }
  }
  const others = renderIds.filter((id) => id !== current);
  if (others.length) {
    reviewBits.push('<p class="dim">Other renders: ' + others.map((id) => {
      const doc = reviewOf(id);
      return `${esc(id)} ${badge(doc ? (doc.verdict || 'no verdict') : 'no review', verdictKind(doc && doc.verdict))}`;
    }).join(' ') + '</p>');
  }

  // --- ledger -------------------------------------------------------------------
  let ledgerHtml = '';
  if (ledger) {
    const mine = ledger.filter((f) => f && f.page === entry.id);
    ledgerHtml = '<h3>Panel ledger</h3>' + (mine.length
      ? '<ul class="findings">' + mine.map((f) =>
        `<li>${badge(f.severity || 'finding', f.severity === 'error' ? 'bad' : 'warn')} ${f.panel ? `<b>${esc(f.panel)}</b> ` : ''}${esc(f.message || f.code || '')}</li>`).join('') + '</ul>'
      : '<p class="note">No ledger findings on this page.</p>');
  }

  const rows = panels.map((p) =>
    `<tr><td>${esc(p.order != null ? p.order : '')}</td><td>${esc(p.id || '')}</td><td>${esc(p.size || '')}</td>` +
    `<td>${esc(framingLine(p))}</td><td>${esc(p.moment || '')}</td><td>${esc(castLine(p))}</td><td class="n">${list(p.lettering).length}</td></tr>`).join('');

  const facts = [
    page.number != null ? `page ${page.number}` : null,
    page.side ? `${page.side} side` : null,
    page.scene || null,
    page.page_turn ? `page turn: ${page.page_turn}` : null,
    `${panels.length} panel${panels.length === 1 ? '' : 's'}`,
    `${letteringTotal} lettering element${letteringTotal === 1 ? '' : 's'}`,
  ].filter(Boolean).join(' · ');

  return `<section class="page" id="${esc(entry.id)}">
<h2>${esc(entry.id)} ${badge(page.status || 'no status', 'status')}</h2>
<p class="meta">${esc(facts)}</p>
${page.purpose ? `<p class="purpose">${esc(page.purpose)}</p>` : ''}
<div class="cols">
  <div class="plan">
    ${tierSchematic(page, project)}
    <p class="dim">${esc(layout.grid || 'no grid')}</p>
  </div>
  <figure class="render">${thumb}</figure>
  <div class="detail">
    <table>
      <thead><tr><th>#</th><th>Panel</th><th>Size</th><th>Framing</th><th>Moment</th><th>Cast</th><th>Lettering</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="note">No panels.</td></tr>'}</tbody>
    </table>
    <h3>Review</h3>
    ${reviewBits.join('\n    ')}
    ${ledgerHtml}
  </div>
</div>
</section>`;
}

/**
 * Build the board of one issue.
 *
 * @param {string} issueDirArg  Path to issues/<ISS_ID>.
 * @param {object} [options]
 * @param {string} [options.out]  Output file (default <issue dir>/board.html).
 * @param {boolean} [options.write=true]
 * @param {Function|null} [options.checkContinuity]  Ledger checker to use
 *   instead of scripts/check-continuity.js; null leaves the ledger section out.
 * @returns {{html:string, file:string, issue:string, root:string, pages:string[],
 *   ledger:boolean, warnings:string[]}}
 */
function buildBoard(issueDirArg, options = {}) {
  const issuePath = path.resolve(String(issueDirArg || ''));
  if (!issueDirArg || !fs.existsSync(issuePath) || !fs.statSync(issuePath).isDirectory()) {
    throw new Error(`issue directory not found: ${issuePath}`);
  }
  const issueId = path.basename(issuePath);
  if (!ws.ID.issue.test(issueId)) throw new Error(`"${issueId}" is not an issue directory (expected issues/ISS_###)`);
  const root = ws.findWorkspaceRoot(issuePath);
  if (!root) throw new Error(`no project.yaml found above ${issuePath}; a workspace root is the directory that holds project.yaml`);
  if (path.relative(ws.issueDir(root, issueId), issuePath) !== '') {
    throw new Error(`${issuePath} is not the issues/${issueId} directory of the workspace at ${root}`);
  }

  const warnings = [];
  const project = safe(() => ws.loadProject(root), null, warnings) || {};
  const issue = safe(() => ws.loadIssue(root, issueId), null, warnings) || {};
  // A page whose YAML does not parse is shown as broken instead of stopping the board.
  const pages = safe(() => ws.listPages(root, issueId), null, warnings) ||
    ws.listPageIds(root, issueId).map((id) => ({ id, doc: safe(() => ws.loadPage(root, id), null, warnings) }));

  const outFile = options.out ? path.resolve(String(options.out)) : path.join(issuePath, 'board.html');
  const outDir = path.dirname(outFile);

  // Ledger check: only when a checker is available, and never fatal.
  const checker = options.checkContinuity === undefined ? loadLedgerCheck() : options.checkContinuity;
  let ledger = null;
  if (typeof checker === 'function') {
    try {
      const report = checker(root, { issue: issueId });
      if (report && Array.isArray(report.findings)) {
        ledger = report.findings.filter((f) => f && (!f.issue || f.issue === issueId));
      }
    } catch (err) {
      warnings.push(`ledger check failed: ${err.message}`);
    }
  }

  const statusCounts = {};
  let panelTotal = 0;
  for (const entry of pages) {
    const status = (entry.doc && entry.doc.status) || 'no status';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    panelTotal += list(entry.doc && entry.doc.panels).length;
  }
  const lettering = project.lettering || {};
  const meta = [
    project.comic_format,
    project.reading_direction ? `reads ${project.reading_direction}` : null,
    project.page && project.page.aspect_ratio ? `page ${project.page.aspect_ratio}` : null,
    project.color_mode ? String(project.color_mode).replace(/_/g, ' ') : null,
    lettering.mode ? `lettering ${String(lettering.mode).replace(/_/g, ' ')}` : null,
    issue.status ? `issue status: ${issue.status}` : null,
  ].filter(Boolean).join(' · ');
  const counts = [
    `${pages.length} page${pages.length === 1 ? '' : 's'}` +
      (typeof issue.page_count === 'number' && issue.page_count !== pages.length ? ` on disk, ${issue.page_count} declared` : ''),
    `${panelTotal} panel${panelTotal === 1 ? '' : 's'}`,
    ...Object.keys(statusCounts).sort().map((s) => `${statusCounts[s]} ${s}`),
  ].join(' · ');

  let ledgerSummary = '';
  if (ledger) {
    const loose = ledger.filter((f) => !f.page || !pages.some((p) => p.id === f.page));
    const errors = ledger.filter((f) => f.severity === 'error').length;
    ledgerSummary = `<h2 class="band">Panel ledger</h2><p>${ledger.length === 0
      ? `${badge('clean', 'good')} The ledger check found nothing in ${esc(issueId)}.`
      : `${badge(`${ledger.length} finding${ledger.length === 1 ? '' : 's'}`, errors ? 'bad' : 'warn')} ${errors} error${errors === 1 ? '' : 's'}, ${ledger.length - errors} warning${ledger.length - errors === 1 ? '' : 's'}. Each one is listed under its page.`}</p>` +
      (loose.length ? '<ul class="findings">' + loose.map((f) =>
        `<li>${badge(f.severity || 'finding', f.severity === 'error' ? 'bad' : 'warn')} ${esc(f.message || f.code || '')}</li>`).join('') + '</ul>' : '');
  }

  const index = pages.map((entry) => {
    const doc = entry.doc || {};
    return `<a href="#${esc(entry.id)}">${esc(doc.number != null ? doc.number : '?')}<span>${esc(doc.status || 'no status')}</span></a>`;
  }).join('');
  const sections = pages.map((entry) => pageSection(root, outDir, project, entry, ledger, warnings)).join('\n');
  const title = `${project.title || 'Untitled'}: ${issueId}${issue.title ? ` ${issue.title}` : ''}`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} board</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0b0e12; color:#e6e8eb; font:14px/1.45 system-ui, sans-serif; margin:24px; }
  h1 { margin:0 0 2px; font-size:22px; }
  h2 { font-size:16px; margin:0 0 4px; }
  h2.band, h3 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:#8b949e; border-bottom:1px solid #2a2f36; padding-bottom:4px; margin:18px 0 8px; }
  .meta, .dim, .note { color:#8b949e; } .meta { margin:0 0 4px; } .summary { max-width:70em; color:#c7cbd1; }
  .index { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0 4px; }
  .index a { background:#161b22; border:1px solid #2a2f36; border-radius:4px; padding:4px 9px; color:#e6e8eb; text-decoration:none; font-weight:600; }
  .index a span { display:block; font-weight:400; font-size:11px; color:#8b949e; }
  section.page { background:#11151b; border:1px solid #232930; border-radius:6px; padding:14px 16px; margin:16px 0; }
  .purpose { max-width:70em; margin:4px 0 10px; color:#c7cbd1; }
  .cols { display:grid; grid-template-columns:140px 170px 1fr; gap:18px; align-items:start; }
  .plan p { font-size:12px; margin:4px 0 0; }
  figure { margin:0; } figure img { width:100%; display:block; border-radius:3px; border:1px solid #2a2f36; } figcaption { font-size:11px; color:#8b949e; padding-top:3px; }
  .ph { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:200px; background:#161b22; border:1px dashed #3a4048; border-radius:4px; color:#8b949e; font-size:12px; text-align:center; padding:6px; }
  table { border-collapse:collapse; width:100%; font-size:12.5px; }
  th { text-align:left; color:#8b949e; font-weight:500; border-bottom:1px solid #2a2f36; padding:3px 8px 3px 0; }
  td { vertical-align:top; padding:4px 8px 4px 0; border-bottom:1px solid #1b2027; } td.n { text-align:right; }
  .badge { display:inline-block; border-radius:10px; padding:1px 8px; font-size:11px; font-weight:600; background:#2a2f36; color:#c7cbd1; }
  .badge.good { background:#12351f; color:#6fdd8b; } .badge.bad { background:#4a1518; color:#ff8a8f; } .badge.warn { background:#3d3210; color:#e3c264; } .badge.status { background:#1c2b44; color:#8ab8ff; }
  ul.findings { margin:4px 0; padding-left:18px; } ul.findings li { margin:3px 0; }
  @media (max-width: 860px) { .cols { grid-template-columns:1fr; } figure.render { max-width:220px; } }
  @media print { body { background:#fff; color:#000; } section.page { background:#fff; border-color:#999; break-inside:avoid; } }
</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">${esc(meta)}</p>
<p class="meta">${esc(counts)}</p>
${issue.summary ? `<p class="summary">${esc(issue.summary)}</p>` : ''}
<nav class="index" aria-label="pages">${index || '<span class="note">No pages yet.</span>'}</nav>
${ledgerSummary}
${sections}
<p class="note">Composed from the workspace files by scripts/build-board.js. Verdicts are the ones recorded in the review files; the board does not inspect artwork.</p>
</body></html>
`;

  if (options.write !== false) writeFileEnsuring(outFile, html);
  return { html, file: outFile, issue: issueId, root, pages: pages.map((p) => p.id), ledger: !!ledger, warnings };
}

function main() {
  const argv = process.argv.slice(2);
  helpIfRequested(argv, HELP);
  const { flags } = parseArgs(argv);
  if (!flags.issue || flags.issue === true) {
    console.error('error: --issue <issues/ISS_### dir> is required (see --help)');
    process.exit(1);
  }
  const result = buildBoard(String(flags.issue), {
    out: flags.out && flags.out !== true ? String(flags.out) : undefined,
  });
  for (const w of result.warnings) console.warn(`warning: ${w}`);
  console.log(`build-board: wrote ${result.file}`);
  console.log(`  ${result.issue}: ${result.pages.length} page${result.pages.length === 1 ? '' : 's'}, ledger check ${result.ledger ? 'included' : 'not available'}`);
}

module.exports = { buildBoard, panelsByTier, tierSchematic };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`build-board: ${err.message}`);
    process.exit(1);
  }
}
