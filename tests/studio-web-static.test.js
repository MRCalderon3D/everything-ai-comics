'use strict';
/**
 * Static checks of the browser app in studio/web/. Nothing is started and no
 * browser is needed: the files are read and compared with each other and
 * with the server's route table.
 *
 * - index.html lives within the server's Content-Security-Policy: no inline
 *   script, no inline event handler, nothing loaded from another host.
 * - Every module import resolves to a file, and every imported name is
 *   exported by it.
 * - Both dictionaries have the same keys and placeholders, and every key the
 *   code uses exists.
 * - Every request the API client makes matches a route of the server, and
 *   every request and the event stream carry the interface language.
 * - The sentences the server writes (job titles, step labels, summaries,
 *   blockers, errors) are shown as the server sends them, not rebuilt from
 *   their codes with dictionaries of the app's own.
 * - Text from files or from the AI is never parsed as markup.
 * - three.js is vendored (the ES module and its MIT license), loaded only
 *   through a dynamic import by the 3D layer, never by a static import, and
 *   every 3D stage has a flat fallback and respects reduced motion.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'studio', 'web');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
/** Source with comments removed, so a commented example is not mistaken for code. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const files = walk(WEB);
const VENDOR = path.join(WEB, 'vendor');
// The app's own modules. Vendored libraries are checked on their own below.
const jsFiles = files.filter((f) => f.endsWith('.js') && !f.startsWith(VENDOR));
const vendorFiles = files.filter((f) => f.startsWith(VENDOR));
const cssFiles = files.filter((f) => f.endsWith('.css'));
const htmlFiles = files.filter((f) => f.endsWith('.html'));

function checkHtml() {
  assert.ok(htmlFiles.length >= 1, 'studio/web has no index.html');
  for (const file of htmlFiles) {
    const html = read(file);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      assert.ok(/\bsrc\s*=/.test(m[1]), `${rel(file)}: inline script (the policy only allows scripts from files)`);
      assert.strictEqual(m[2].trim(), '', `${rel(file)}: a script tag with src must be empty`);
      assert.ok(/type\s*=\s*"module"/.test(m[1]), `${rel(file)}: scripts are ES modules`);
    }
    assert.ok(!/<[^>]+\son[a-z]+\s*=/i.test(html), `${rel(file)}: inline event handler`);
    assert.ok(!/<style\b/i.test(html), `${rel(file)}: inline style block; styles live in css files`);
    assert.ok(!/\sstyle\s*=/i.test(html), `${rel(file)}: inline style attribute`);
    for (const m of html.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)) {
      const url = m[1];
      if (url.startsWith('#')) continue;
      assert.ok(url.startsWith('/') && !url.startsWith('//'), `${rel(file)}: ${url} is not a path on this server`);
      assert.ok(fs.existsSync(path.join(WEB, url)), `${rel(file)}: ${url} does not exist in studio/web`);
    }
    assert.ok(/<html[^>]*\blang=/.test(html), `${rel(file)}: the html element needs a lang`);
    assert.ok(/<main\b/.test(html), `${rel(file)}: no main landmark`);
  }
}

/** The server sends the policy the app lives within: nothing from another host. */
function checkPolicy() {
  const http = code(read(path.join(ROOT, 'studio', 'server', 'http.js')) + read(path.join(ROOT, 'studio', 'server', 'security.js')));
  const m = /"(default-src 'self'[^"]*)"/.exec(http);
  assert.ok(m, "the server no longer sends a Content-Security-Policy with default-src 'self'");
  const policy = m[1];
  assert.ok(!/https?:|\*/.test(policy), 'the Content-Security-Policy allows another host');
  assert.ok(!/script-src/.test(policy) && !/'unsafe-eval'/.test(policy), 'scripts may come from somewhere other than the server');
}

/**
 * three.js: one vendored ES module with its license, imported only with a
 * dynamic import() from the 3D layer, so screens without 3D never load it.
 */
function checkThree() {
  const dir = path.join(VENDOR, 'three');
  const module = path.join(dir, 'three.module.min.js');
  const license = path.join(dir, 'LICENSE');
  assert.ok(fs.existsSync(module), 'studio/web/vendor/three/three.module.min.js is missing');
  assert.ok(fs.existsSync(license), 'studio/web/vendor/three/LICENSE is missing');
  assert.ok(/MIT License/.test(read(license)) && /three\.js authors/i.test(read(license)), 'the three.js LICENSE is not the MIT license of its authors');
  const lib = read(module);
  assert.ok(/REVISION\s*=\s*['"]\d+['"]/.test(lib.slice(0, 2000)) || /const \w+=["']\d{3}["']/.test(lib.slice(0, 4000)), 'the vendored file does not look like the three.js module build');
  assert.ok(!/import\s*[{(*'"]/.test(lib.replace(/import\.meta/g, '')), 'the vendored three.js imports other files; vendor the self-contained module build');
  assert.deepStrictEqual(vendorFiles.map(rel).sort(), ['studio/web/vendor/three/LICENSE', 'studio/web/vendor/three/three.module.min.js'], 'only three.js and its license are vendored');
  const users = [];
  for (const file of jsFiles) {
    const text = code(read(file));
    assert.ok(!/import\s[^;]*from\s*'\/vendor\//.test(text), `${rel(file)}: imports three.js statically; load it with import() so other screens never download it`);
    if (/\/vendor\/three\//.test(text)) users.push(rel(file));
  }
  assert.deepStrictEqual(users, ['studio/web/js/gl/stage.js'], 'three.js is loaded from one place, the stage of the 3D layer');
  const stage = code(read(path.join(WEB, 'js', 'gl', 'stage.js')));
  assert.ok(/import\(THREE_URL\)/.test(stage), 'stage.js does not load three.js with a dynamic import');
  assert.ok(/prefers-reduced-motion/.test(stage), 'the 3D layer does not respect reduced motion');
  assert.ok(/IntersectionObserver/.test(stage) && /visibilitychange/.test(stage), 'the 3D layer does not pause off screen or in a hidden tab');
  assert.ok(/getContext\('webgl2'\)|getContext\('webgl'\)/.test(stage) && /gl-fallback/.test(stage), 'the 3D layer has no WebGL check or flat fallback');
}

function checkNoNetwork() {
  for (const file of [...jsFiles, ...vendorFiles.filter((f) => f.endsWith('.js')), ...cssFiles, ...htmlFiles]) {
    const text = code(read(file));
    // The SVG namespace is a name, not a request.
    const stripped = text.replace(/http:\/\/www\.w3\.org\/[A-Za-z0-9/]+/g, '');
    assert.ok(!/https?:\/\//.test(stripped), `${rel(file)}: refers to another host; the app works offline`);
    assert.ok(!/@import\b/.test(text) || !file.endsWith('.css'), `${rel(file)}: @import in css`);
  }
  for (const file of cssFiles) {
    for (const m of read(file).matchAll(/url\(\s*['"]?([^'")]+)/g)) {
      assert.ok(m[1].startsWith('/') || m[1].startsWith('data:'), `${rel(file)}: url(${m[1]}) leaves the server`);
    }
  }
}

function exportsOf(source) {
  const names = new Set();
  const text = code(source);
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.add(name);
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default');
  return names;
}

function checkImports() {
  const exported = new Map();
  for (const file of jsFiles) exported.set(file, exportsOf(read(file)));
  const resolve = (spec, from) => {
    assert.ok(spec.startsWith('/'), `${rel(from)}: import of "${spec}" (imports use paths from the web root)`);
    const target = path.join(WEB, spec);
    assert.ok(fs.existsSync(target), `${rel(from)}: imports ${spec}, which does not exist`);
    return target;
  };
  let count = 0;
  for (const file of jsFiles) {
    const text = code(read(file));
    for (const m of text.matchAll(/import\s+([^'"]+?)\s+from\s+'([^']+)'/g)) {
      const target = resolve(m[2], file);
      const names = exported.get(target);
      const clause = m[1].trim();
      const braces = /\{([^}]*)\}/.exec(clause);
      const before = clause.replace(/\{[^}]*\}/, '').replace(/,/g, '').trim();
      if (before && !before.startsWith('*')) {
        assert.ok(names.has('default'), `${rel(file)}: ${m[2]} has no default export`);
      }
      if (braces) {
        for (const part of braces[1].split(',')) {
          const name = part.trim().split(/\s+as\s+/)[0];
          if (!name) continue;
          assert.ok(names.has(name), `${rel(file)}: ${m[2]} does not export "${name}"`);
          count += 1;
        }
      }
    }
    for (const m of text.matchAll(/import\(\s*'([^']+)'\s*\)/g)) resolve(m[1], file);
    assert.ok(!/\brequire\s*\(/.test(text), `${rel(file)}: require() in a browser module`);
  }
  assert.ok(count > 100, `only ${count} named imports were checked`);
}

function checkScreens() {
  const main = read(path.join(WEB, 'js', 'main.js'));
  const routes = [...main.matchAll(/route\('([^']+)',\s*\(\)\s*=>\s*import\('([^']+)'\)/g)];
  assert.ok(routes.length >= 18, `only ${routes.length} routes in main.js`);
  for (const [, pattern, spec] of routes) {
    const file = path.join(WEB, spec);
    assert.ok(fs.existsSync(file), `route ${pattern}: ${spec} does not exist`);
    const names = exportsOf(read(file));
    assert.ok(names.has('view'), `route ${pattern}: ${spec} does not export view()`);
    assert.ok(names.has('load'), `route ${pattern}: ${spec} does not export load()`);
  }
  // Every route the server builds for a link in the conversation opens a screen.
  const { routeOf } = require('../studio/server/screens.js');
  const patterns = routes.map(([, pattern]) => new RegExp(`^${pattern.replace(/:[a-z]+/g, '[^/]+')}/?$`));
  for (const key of ['home', 'story', 'style', 'options', 'settings', 'characters', 'character:CHAR_X', 'places', 'location:LOC_X', 'prop:PROP_X',
    'pages:ISS_001', 'page:PG_001_001', 'cover:ISS_001', 'publish:ISS_001', 'check', 'corrections', 'history']) {
    const url = routeOf('demo', key);
    assert.ok(url && patterns.some((re) => re.test(url)), `the server links ${key} to ${url}, which the app does not route`);
  }
  // The screens of the brief each have a route.
  for (const screen of ['story', 'style', 'characters', 'places', 'pages', 'check', 'corrections', 'cover', 'publish', 'history', 'settings', 'decisions']) {
    assert.ok(routes.some(([, pattern]) => pattern.includes(`/${screen}`)), `no route for the ${screen} screen`);
  }
}

function loadDictionary(name) {
  const text = read(path.join(WEB, 'js', 'i18n', `${name}.js`));
  const at = text.indexOf('export default');
  assert.ok(at !== -1, `${name}.js has no default export`);
  // eslint-disable-next-line no-new-func
  return new Function(`return ${text.slice(at + 'export default'.length).trim().replace(/;\s*$/, '')}`)();
}

function checkDictionaries() {
  const en = loadDictionary('en');
  const es = loadDictionary('es');
  const enKeys = Object.keys(en).sort();
  const esKeys = Object.keys(es).sort();
  assert.deepStrictEqual(enKeys.filter((k) => !(k in es)), [], 'keys in en.js that es.js lacks');
  assert.deepStrictEqual(esKeys.filter((k) => !(k in en)), [], 'keys in es.js that en.js lacks');
  assert.ok(enKeys.length > 500, `only ${enKeys.length} keys`);

  const holes = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const key of enKeys) {
    for (const [lang, dict] of [['en', en], ['es', es]]) {
      assert.strictEqual(typeof dict[key], 'string', `${lang}: ${key} is not a string`);
      assert.ok(dict[key].trim() !== '', `${lang}: ${key} is empty`);
    }
    assert.strictEqual(holes(es[key]), holes(en[key]), `${key}: the placeholders differ between en and es`);
  }
  // A plural pair is complete.
  for (const key of enKeys) {
    const m = /^(.*)\.(one|other)$/.exec(key);
    if (m) assert.ok(`${m[1]}.${m[2] === 'one' ? 'other' : 'one'}` in en, `${key} has no counterpart`);
  }
  // Spanish has to be Spanish: a text copied over from English is a miss.
  // Names, codes and short labels that are the same in both are listed here.
  const same = enKeys.filter((k) => en[k] === es[k] && /[a-z]{4,}/i.test(en[k]));
  const allowed = /^(tool\.|actor\.(claude|codex)|pubformat\.(pdf|cbz|epub)|job\.chat\.turn|field\.id|time\.|settings\.model_for|language\.|lettering_type\.radio$|mech\.error$|pages\.link_plan$)/;
  assert.deepStrictEqual(same.filter((k) => !allowed.test(k)), [], 'texts identical in en and es');

  // Every key the code names exists.
  const used = new Set();
  const plural = new Set();
  const prefixes = new Set();
  for (const file of jsFiles) {
    if (/[\\/]i18n[\\/](en|es)\.js$/.test(file)) continue;
    const text = code(read(file));
    for (const m of text.matchAll(/(?<![\w.$])t\(\s*'([^']+)'/g)) used.add(m[1]);
    for (const m of text.matchAll(/(?<![\w.$])tn\(\s*'([^']+)'/g)) plural.add(m[1]);
    for (const m of text.matchAll(/(?<![\w.$])tv\(\s*'([^']+)'/g)) prefixes.add(m[1]);
    for (const m of text.matchAll(/(?<![\w.$])(?:t|has)\(\s*`([^`$]+)\.\$\{/g)) prefixes.add(m[1]);
  }
  for (const key of plural) {
    used.add(`${key}.one`);
    used.add(`${key}.other`);
  }
  assert.ok(used.size > 400, `only ${used.size} keys found in the code`);
  for (const key of used) assert.ok(key in en, `the code uses "${key}", which is in no dictionary`);
  for (const prefix of prefixes) {
    assert.ok(enKeys.some((k) => k.startsWith(`${prefix}.`)), `the code builds keys under "${prefix}.", and none exists`);
  }

  // Values the server sends that the interface puts into words.
  const expect = {
    screen: ['story', 'style', 'characters', 'places', 'pages', 'check', 'corrections', 'cover', 'publish'],
    status: ['done', 'in_progress', 'todo', 'blocked', 'next', 'optional'],
    job_status: ['queued', 'running', 'needs_decision', 'done', 'failed', 'cancelled'],
    step_status: ['pending', 'running', 'done', 'failed', 'cancelled', 'waiting', 'skipped'],
    check_result: ['pass', 'fail', 'not_applicable', 'not_performed'],
    finding_status: ['open', 'fixed', 'accepted'],
    severity: ['blocking', 'minor'],
    actor: ['person', 'claude', 'codex', 'studio'],
    change: ['added', 'modified', 'deleted'],
    check: ['identity', 'cast_count', 'position', 'movement', 'role_causality', 'object_identity', 'object_custody',
      'physical_state', 'wardrobe', 'spatial_logic', 'drawing_clarity', 'lettering', 'page_structure', 'style_fidelity'],
  };
  for (const [prefix, values] of Object.entries(expect)) {
    for (const value of values) assert.ok(`${prefix}.${value}` in en, `no text for ${prefix}.${value}`);
  }
  return { en, es };
}

/**
 * The server localizes its own sentences. The app keeps no copy of them: no
 * dictionary families for job titles, step labels, screen summaries,
 * blockers, correction paths, presets, page sizes or the server's error
 * codes, and the code shows the server's fields.
 */
function checkServerTextNotRebuilt(en) {
  const families = ['job.project.', 'job.pages.generate', 'job.page.', 'job.cover.', 'step.', 'summary.', 'blocker.',
    'publish.blocker.', 'correction.path.', 'preset.', 'page_size.', 'pubformat.'];
  for (const key of Object.keys(en)) {
    assert.ok(!families.some((f) => key.startsWith(f)), `en.js keeps "${key}", a sentence the server now writes`);
  }
  const serverCodes = Object.keys(require('../studio/server/i18n-text.js').en || {})
    .filter((k) => k.startsWith('error.')).filter((k) => k !== 'error.other');
  const local = ['error.offline', 'error.http', 'error.not_found_title', 'error.screen_title', 'error.no_such_screen'];
  for (const key of serverCodes) {
    if (local.includes(key)) continue;
    assert.ok(!(key in en), `en.js words the server error ${key}; show the server's message instead`);
  }
  const api = code(read(path.join(WEB, 'js', 'api.js')));
  assert.ok(!/has\(`error\./.test(api), 'api.js rebuilds error messages from their codes');
  const labels = code(read(path.join(WEB, 'js', 'labels.js')));
  assert.ok(/job\.title/.test(labels) && /step\.label/.test(labels), 'labels.js does not use the job title and step label the server sends');
  const home = code(read(path.join(WEB, 'js', 'screens', 'home.js')));
  assert.ok(/s\.summary/.test(home) && /b\.message/.test(home), 'home.js does not show the summaries and blockers the server sends');
  // Overrules are data on the summaries: no sentence matching, no fetch per page.
  for (const file of jsFiles) {
    const text = code(read(file));
    assert.ok(!/Overruled by the person/.test(text), `${rel(file)}: looks for an overrule in the text of a review`);
    assert.ok(!/markOverrules/.test(text), `${rel(file)}: fetches every page to find overrules`);
  }
  // The web reader is the real one, in a sandboxed frame.
  const publish = code(read(path.join(WEB, 'js', 'screens', 'publish.js')));
  assert.ok(/'iframe'/.test(publish) && /sandbox:\s*'allow-scripts'/.test(publish), 'publish.js does not frame the web reader with sandbox="allow-scripts"');
  assert.ok(!/DOMParser/.test(publish), 'publish.js parses the reader instead of showing it');
}

function checkApiClient() {
  const { createServer } = require('../studio/server');
  const { createApi } = require('../studio/server/api');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comics-studio-web-'));
  const app = createServer({ port: 0, home, fake: true });
  const router = createApi(app.services);
  try {
    const text = code(read(path.join(WEB, 'js', 'api.js')));
    const calls = [...text.matchAll(/request\('(GET|POST|PUT|DELETE)',\s*(`[^`]*`|'[^']*')/g)];
    assert.ok(calls.length >= 40, `only ${calls.length} requests found in api.js`);
    for (const [, method, raw] of calls) {
      let url = raw.slice(1, -1);
      // The query string is built by q() or passed in as `query`.
      url = url.replace(/\$\{q\(\{[^`]*\}\)\}$/, '').replace(/\$\{query\}$/, '');
      url = url.replace(/\$\{project\(id\)\}/g, '/api/projects/the-night-ferry').replace(/\$\{enc\(\w+\)\}/g, 'X');
      assert.ok(!url.includes('${'), `api.js: cannot read the path of ${raw}`);
      const match = router.match(method, url);
      assert.ok(match && match.route, `api.js calls ${method} ${url}, which the server does not route`);
    }
    for (const route of ['/diff', '/history', '/approve/page', '/conversation', '/conversation/new', '/conversations', '/proposals', '/decide', '/api/tools/refresh']) {
      assert.ok(calls.some(([, , raw]) => raw.includes(`${route}`)), `api.js does not call ${route}`);
    }
    // The history and the chat show files as they were at a commit through
    // the before_url and after_url of a diff.
    assert.ok(router.match('GET', '/api/projects/the-night-ferry/at/0123abc/raw/story/story-bible.yaml'), 'the server has no file-at-a-commit route');
    const diff = code(read(path.join(WEB, 'js', 'components', 'diff.js')));
    assert.ok(/before_url/.test(diff) && /after_url/.test(diff), 'diff.js does not use before_url and after_url');
    // Every request asks for the interface language, the stream too.
    assert.ok(/path = withLang\(path\)/.test(text) && /lang=\$\{encodeURIComponent\(getLang\(\)\)\}/.test(text), 'api.js requests do not carry ?lang=');
    assert.ok(/eventsUrl:\s*\(id\)\s*=>\s*withLang\(`\$\{project\(id\)\}\/events`\)/.test(text), 'the events URL does not carry ?lang=');
    assert.ok(router.match('GET', '/api/projects/x/events'), 'the server has no events route');
  } finally {
    app.services.events.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function checkEventTypes() {
  const store = code(read(path.join(WEB, 'js', 'store.js')));
  for (const type of ['hello', 'job', 'log', 'activity', 'files', 'chat']) {
    assert.ok(store.includes(`addEventListener('${type}'`), `store.js does not listen to the "${type}" event`);
  }
}

function checkSafety() {
  for (const file of jsFiles) {
    const text = code(read(file));
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function(']) {
      assert.ok(!text.includes(bad), `${rel(file)}: uses ${bad}; text from files and from the AI is never parsed as markup or code`);
    }
  }
  for (const file of [...jsFiles, ...cssFiles, ...htmlFiles]) {
    const text = read(file);
    assert.ok(!/[A-Za-z]:\\Users\\|\/Users\/[a-z]/i.test(text), `${rel(file)}: holds a local path`);
    assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text), `${rel(file)}: holds an e-mail address`);
  }
}

function checkThemesAndMotion() {
  const css = cssFiles.map(read).join('\n');
  assert.ok(/prefers-color-scheme:\s*dark/.test(css), 'no dark theme for a system set to dark');
  assert.ok(/\[data-theme="dark"\]/.test(css) && /\[data-theme="light"\]/.test(css), 'no way to force a theme');
  assert.ok(/prefers-reduced-motion:\s*reduce/.test(css), 'reduced motion is not respected');
  assert.ok(/:focus-visible/.test(css), 'no visible focus style');
}

/** The frame's layout: resizable, collapsible, focus mode, kept per person in the browser. */
function checkLayout() {
  const layout = code(read(path.join(WEB, 'js', 'layout.js')));
  assert.ok(/role:\s*'separator'/.test(layout) && /ArrowLeft/.test(layout) && /dblclick/.test(layout), 'the column handles are not keyboard separators with a double-click reset');
  assert.ok(/localStorage/.test(layout) && !/projectId/.test(layout), 'the layout is not kept per person in the browser');
  assert.ok(/focus/.test(layout) && /shiftKey/.test(layout), 'there is no focus mode shortcut');
  const css = cssFiles.map(read).join('\n');
  assert.ok(/data-rail="collapsed"/.test(css) && /data-dock="collapsed"/.test(css) && /data-focus="true"/.test(css), 'the layout states have no styles');
}

function main() {
  checkHtml();
  checkLayout();
  checkPolicy();
  checkThree();
  checkNoNetwork();
  checkImports();
  checkScreens();
  const { en } = checkDictionaries();
  checkServerTextNotRebuilt(en);
  checkApiClient();
  checkEventTypes();
  checkSafety();
  checkThemesAndMotion();
  console.log(`studio-web-static: ${jsFiles.length} modules, ${cssFiles.length} stylesheets, ${Object.keys(en).length} texts in two languages, three.js vendored`);
}

main();
