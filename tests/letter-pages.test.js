'use strict';
/** scripts/letter-pages.js: text authority, SVG output, fit warnings. */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { letterPage, fitText } = require('../scripts/letter-pages');
const svgLib = require('../scripts/lib/svg');
const { makeWorkspace, cleanup, editYaml } = require('./fixtures/publishing/helpers');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'letter-pages.js');
const roots = [];

function workspace() {
  const root = makeWorkspace();
  roots.push(root);
  const dir = path.join(root, 'issues', 'ISS_001', 'pages', 'PG_001_001');
  return {
    root,
    dir,
    page: path.join(dir, 'page.yaml'),
    lettering: path.join(dir, 'lettering.yaml'),
    render: path.join(dir, 'renders', 'PG_001_001_V01.png'),
    out: path.join(dir, 'renders', 'PG_001_001_V01.lettered.svg'),
  };
}
const codes = (result) => result.errors.map((e) => e.code);

/**
 * Well-formedness check without an XML parser: tags balance, attribute values
 * are quoted, and neither text nor attributes hold a bare "<" or "&".
 */
function assertWellFormed(xml) {
  const body = xml.replace(/^<\?xml [^?]*\?>\s*/, '');
  const token = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  const entity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)/;
  const stack = [];
  let pos = 0;
  let roots = 0;
  let m;
  while ((m = token.exec(body))) {
    assert.strictEqual(m.index, pos, `unparseable markup near ${JSON.stringify(body.slice(pos, pos + 40))}`);
    pos = token.lastIndex;
    if (m[5] !== undefined) {
      assert.ok(!entity.test(m[5]), `bare & in text: ${JSON.stringify(m[5])}`);
      assert.ok(!m[5].includes('>') || true);
      if (!stack.length) assert.strictEqual(m[5].trim(), '', 'text outside the root element');
      continue;
    }
    assert.ok(!entity.test(m[3]), `bare & in attributes of <${m[2]}>`);
    if (m[1]) {
      assert.ok(!m[3] && !m[4], `closing tag </${m[2]}> with attributes`);
      assert.strictEqual(stack.pop(), m[2], `</${m[2]}> closes the wrong element`);
    } else {
      if (!stack.length) roots++;
      if (!m[4]) stack.push(m[2]);
    }
  }
  assert.strictEqual(pos, body.length, `unparseable markup near ${JSON.stringify(body.slice(pos, pos + 40))}`);
  assert.deepStrictEqual(stack, [], 'every element is closed');
  assert.strictEqual(roots, 1, 'exactly one root element');
}

try {
  // --- the checker itself rejects broken markup ----------------------------------------------
  assert.throws(() => assertWellFormed('<svg><g></svg>'));
  assert.throws(() => assertWellFormed('<svg><text>a & b</text></svg>'));
  assert.throws(() => assertWellFormed('<svg><text>a < b</text></svg>'));
  assert.throws(() => assertWellFormed('<svg a=1></svg>'));
  assert.throws(() => assertWellFormed('<svg></svg><svg></svg>'));
  assertWellFormed('<?xml version="1.0"?>\n<svg a="1"><g id="x"><text>a &amp; b &#39;c&#39;</text><rect x="1"/></g></svg>\n');

  // --- a clean run ----------------------------------------------------------------------------
  {
    const w = workspace();
    const renderBefore = fs.readFileSync(w.render);
    const result = letterPage(w.page);
    assert.deepStrictEqual(result.errors, [], JSON.stringify(result.errors));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.render, 'PG_001_001_V01');
    assert.strictEqual(result.elements, 5);
    assert.strictEqual(path.relative(result.file, w.out), '', 'written next to the render');
    const svg = fs.readFileSync(w.out, 'utf8');
    assert.strictEqual(svg, result.svg);
    assert.ok(fs.readFileSync(w.render).equals(renderBefore), 'the render itself is untouched');

    assertWellFormed(svg);
    assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /width="400" height="600" viewBox="0 0 400 600"/, 'canvas size from lettering.yaml');
    assert.match(svg, /<image x="0" y="0" width="400" height="600" href="PG_001_001_V01\.png" xlink:href="PG_001_001_V01\.png"\/>/, 'relative href to the render');

    // One group per element, in page.yaml reading order.
    const ids = [...svg.matchAll(/<g id="(L\d\d)" data-type="(\w+)" data-panel="(PN_[\d_]+)">/g)].map((m) => [m[1], m[2], m[3]]);
    assert.deepStrictEqual(ids, [
      ['L01', 'caption', 'PN_001_001_01'],
      ['L02', 'balloon', 'PN_001_001_02'],
      ['L03', 'thought', 'PN_001_001_02'],
      ['L04', 'sfx', 'PN_001_001_03'],
      ['L05', 'shout', 'PN_001_001_04'],
    ]);
    const group = (id) => new RegExp(`<g id="${id}"[^>]*>([\\s\\S]*?)\\n  </g>`).exec(svg)[1];

    // Shapes by element.
    assert.match(group('L01'), /<rect x="16" y="16" width="240" height="24" fill="#FFFFFF" stroke="#000000"/, 'caption is a rect');
    assert.match(group('L02'), /<path d="M [\d.]+ [\d.]+ A 85 40 0 1 1 [\d.]+ [\d.]+ L 120 320 Z"/, 'balloon is an ellipse with a tail to the tip');
    assert.match(group('L03'), /<path d="M [^"]* Z"/, 'thought is a cloud path');
    assert.strictEqual((group('L03').match(/<circle /g) || []).length, 3, 'thought tail is a run of bubbles');
    assert.ok(!/<(rect|path|polygon|circle|ellipse) /.test(group('L04')), 'sfx has no shape');
    assert.strictEqual((group('L05').match(/<polygon /g) || []).length, 2, 'shout is a burst plus a tail');
    assert.strictEqual(group('L05').match(/<polygon points="([^"]*)"/g)[1].split(' ').length, 28 + 1, 'burst polygon has 28 vertices');

    // Text: upper-cased (project.lettering.case), escaped, centred, in the configured font.
    assert.match(group('L01'), /<text text-anchor="middle" font-family="&#39;Comic Neue&#39;, sans-serif" font-size="12" fill="#000000">/);
    const textOf = (id) => [...group(id).matchAll(/<tspan [^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1]).join(' ');
    assert.strictEqual(textOf('L01'), 'LAST CROSSING OF THE NIGHT.');
    assert.strictEqual(textOf('L02'), 'WHO&#39;S THERE? &lt;ANSWER&gt; &amp; BE QUICK.', 'XML special characters are escaped');
    assert.ok(!/<ANSWER>/.test(svg));
    assert.strictEqual(textOf('L03'), 'RATS DON&#39;T COUGH.');
    assert.strictEqual(textOf('L04'), 'THUNK');
    assert.strictEqual(textOf('L05'), 'OUT. NOW!');
    assert.ok(group('L02').match(/<tspan /g).length >= 2, 'the balloon text wraps');
    for (const m of group('L02').matchAll(/<tspan x="([\d.]+)"/g)) assert.strictEqual(Number(m[1]), 105, 'lines centred on the box');
    assert.match(group('L04'), /fill="#C0392B" font-weight="bold" stroke="#FFFFFF"/, 'sfx uses its style colours');
    const sfxSize = Number(/font-size="([\d.]+)"/.exec(group('L04'))[1]);
    assert.ok(sfxSize > 12 && sfxSize <= 50 / 1.15 + 0.01, `sfx text is scaled to its box (got ${sfxSize})`);

    assert.deepStrictEqual(result.warnings.filter((x) => x.code === 'overflow'), [], 'the fixture boxes fit');

    // Rewriting is fine: the overlay is a derived file.
    assert.strictEqual(letterPage(w.page).svg, svg, 'same input, same SVG');
  }

  // --- --embed inlines the render ---------------------------------------------------------------
  {
    const w = workspace();
    const result = letterPage(w.page, { embed: true });
    assert.strictEqual(result.ok, true);
    assertWellFormed(result.svg);
    const href = / href="(data:image\/png;base64,[A-Za-z0-9+/=]+)"/.exec(result.svg)[1];
    assert.ok(Buffer.from(href.split(',')[1], 'base64').equals(fs.readFileSync(w.render)), 'embedded bytes are the render');
    assert.ok(!/href="PG_001_001_V01\.png"/.test(result.svg));
  }

  // --- text authority: mismatch, missing id, extra id ----------------------------------------------
  {
    const w = workspace();
    const original = fs.readFileSync(w.lettering, 'utf8');
    const attempt = (change) => {
      fs.writeFileSync(w.lettering, original);
      editYaml(w.lettering, change);
      const result = letterPage(w.page);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.file, null);
      assert.ok(!fs.existsSync(w.out), 'nothing is written when the text check fails');
      return result;
    };

    const mismatch = attempt((doc) => { doc.elements[0].text = 'Last crossing of the night'; });
    assert.deepStrictEqual(codes(mismatch), ['text-mismatch']);
    assert.match(mismatch.errors[0].message, /L01: text differs from page\.yaml/);
    assert.match(mismatch.errors[0].message, /"Last crossing of the night\."/);
    assert.match(mismatch.errors[0].message, /"Last crossing of the night"/);

    const cased = attempt((doc) => { doc.elements[3].text = 'THUNK'; });
    assert.deepStrictEqual(codes(cased), ['text-mismatch'], 'the comparison is exact, case included');

    const missing = attempt((doc) => { doc.elements.splice(2, 1); });
    assert.deepStrictEqual(codes(missing), ['missing-id']);
    assert.match(missing.errors[0].message, /L03: page\.yaml has this lettering but lettering\.yaml has no element/);

    const extra = attempt((doc) => { doc.elements.push({ ...doc.elements[0], id: 'L09' }); });
    assert.deepStrictEqual(codes(extra), ['extra-id']);
    assert.match(extra.errors[0].message, /L09/);

    const doubled = attempt((doc) => { doc.elements.push({ ...doc.elements[0] }); });
    assert.deepStrictEqual(codes(doubled), ['duplicate-id']);

    const badBox = attempt((doc) => { doc.elements[1].box.width = 0; });
    assert.deepStrictEqual(codes(badBox), ['box']);

    const badShape = attempt((doc) => { doc.elements[1].shape = 'hexagon'; });
    assert.deepStrictEqual(codes(badShape), ['shape']);

    // The CLI reports the same and exits 1.
    fs.writeFileSync(w.lettering, original);
    editYaml(w.lettering, (doc) => { doc.elements[4].text = 'Out!'; });
    const cli = spawnSync(process.execPath, [SCRIPT, '--page', w.page], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 1);
    assert.match(cli.stderr, /L05: text differs from page\.yaml/);
    assert.ok(!fs.existsSync(w.out));
  }

  // --- overflow is a warning with the measured amount -------------------------------------------------
  {
    const w = workspace();
    editYaml(w.lettering, (doc) => {
      doc.elements[1].box = { x: 20, y: 200, width: 90, height: 30 };
      doc.elements[0].box.width = 100;
    });
    const result = letterPage(w.page);
    assert.strictEqual(result.ok, true, 'text that does not fit still produces the overlay');
    const overflow = result.warnings.filter((x) => x.code === 'overflow');
    assert.deepStrictEqual(overflow.map((x) => x.element), ['L01', 'L02']);
    for (const warning of overflow) {
      assert.ok(warning.overflow.x > 0 || warning.overflow.y > 0, 'measured overflow is reported');
      assert.match(warning.message, /over by \d+px in width and \d+px in height/);
    }
    assert.match(overflow[1].message, /L02 \(PN_001_001_02, balloon\): text does not fit its ellipse/);
    assertWellFormed(result.svg);
  }

  // --- case, render selection, canvas ------------------------------------------------------------------
  {
    const w = workspace();
    editYaml(path.join(w.root, 'project.yaml'), (doc) => { doc.lettering.case = 'sentence'; });
    const sentence = letterPage(w.page, { write: false });
    assert.match(sentence.svg, />Last crossing of the night\.</, 'sentence case keeps the text as written');
    assert.ok(!fs.existsSync(w.out), 'write: false leaves the disk alone');

    const absent = letterPage(w.page, { render: 'PG_001_001_V02' });
    assert.deepStrictEqual(codes(absent), ['render-missing']);
    const foreign = letterPage(w.page, { render: 'PG_001_002_V02' });
    assert.deepStrictEqual(codes(foreign), ['render-page']);

    // A second render of the page: allowed, with a warning that the geometry was made for V01.
    fs.copyFileSync(w.render, path.join(w.dir, 'renders', 'PG_001_001_V02.png'));
    const other = letterPage(w.page, { render: 'PG_001_001_V02' });
    assert.strictEqual(other.ok, true);
    assert.ok(other.warnings.some((x) => x.code === 'render-differs'));
    assert.ok(fs.existsSync(path.join(w.dir, 'renders', 'PG_001_001_V02.lettered.svg')));
    assert.match(other.svg, /href="PG_001_001_V02\.png"/);

    editYaml(path.join(w.root, 'project.yaml'), (doc) => { doc.lettering.mode = 'in_image'; });
    const inImage = letterPage(w.page, { write: false });
    assert.ok(inImage.warnings.some((x) => x.code === 'lettering-mode'));

    fs.rmSync(w.lettering);
    assert.deepStrictEqual(codes(letterPage(w.page)), ['lettering-missing']);
    assert.deepStrictEqual(codes(letterPage(path.join(w.dir, 'nope.yaml'))), ['page-missing']);
  }

  // --- CLI and help ----------------------------------------------------------------------------------
  {
    const w = workspace();
    const cli = spawnSync(process.execPath, [SCRIPT, '--page', w.page, '--embed'], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /wrote issues\/ISS_001\/pages\/PG_001_001\/renders\/PG_001_001_V01\.lettered\.svg/);
    assert.match(cli.stdout, /approximate/);
    assert.match(fs.readFileSync(w.out, 'utf8'), /href="data:image\/png;base64,/);
    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    assert.strictEqual(help.status, 0);
    assert.match(help.stdout, /layout is approximate/i);
    assert.match(help.stdout, /browser or a\s+vector tool/);
    assert.strictEqual(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 1);
  }

  // --- the text model ------------------------------------------------------------------------------------
  {
    assert.strictEqual(svgLib.escapeXml(`<a href="x">Tom & 'Jerry'</a>\u0001`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;');
    assert.ok(svgLib.measureText('MMMM', 10) > svgLib.measureText('iiii', 10), 'wide letters measure wider');
    assert.strictEqual(svgLib.measureText('abc', 20), 2 * svgLib.measureText('abc', 10), 'width scales with the font size');
    const lines = svgLib.wrapText('one two three four five six seven', 60, 10);
    assert.ok(lines.length > 1);
    assert.strictEqual(lines.join(' '), 'one two three four five six seven', 'wrapping keeps every word, in order');
    for (const line of lines) assert.ok(svgLib.measureText(line, 10) <= 60, `"${line}" fits the wrap width`);
    assert.deepStrictEqual(svgLib.wrapText('a\nb', 500, 10), ['a', 'b'], 'explicit line breaks are kept');
    assert.deepStrictEqual(svgLib.wrapText('Incomprehensibilities', 20, 10), ['Incomprehensibilities'], 'a long word is never split');

    const roomy = fitText('A SHORT LINE', { x: 0, y: 0, width: 300, height: 120 }, 'ellipse', 12, 1.15);
    assert.strictEqual(roomy.overflowX + roomy.overflowY, 0);
    const tight = fitText('FAR TOO MANY WORDS FOR A BALLOON THIS SMALL, TRULY', { x: 0, y: 0, width: 80, height: 30 }, 'ellipse', 12, 1.15);
    assert.ok(tight.overflowX + tight.overflowY > 0);
    const rect = fitText('ONE TWO', { x: 0, y: 0, width: 20, height: 10 }, 'rect', 12, 1.15);
    assert.ok(rect.overflowX > 0 && rect.overflowY > 0);
  }

  console.log('letter-pages: OK');
} finally {
  roots.forEach(cleanup);
}
