'use strict';
/**
 * Chat: one conversation per screen. A screen key names what the person is
 * looking at; from it come the files the AI is given and the command files
 * that govern them. Transcripts live in <project>/.studio/chats/.
 *
 * Keys: story, style, options, characters, character:<CHAR_ID>, places,
 * location:<LOC_ID>, prop:<PROP_ID>, pages:<ISS_ID>, page:<PAGE_ID>,
 * cover:<ISS_ID>, publish:<ISS_ID>.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const { HttpError, appendJsonl, readJsonl, newId, nowIso } = require('./util');

const KEY_RE = /^(story|style|options|characters|places|(character|location|prop|pages|page|cover|publish):[A-Z][A-Z0-9_]{2,60})$/;

/** An issue of the project: a directory under issues/, or an entry of the series plan not planned yet. */
function knownIssue(root, id) {
  if (!S.ws.ID.issue.test(String(id))) return false;
  if (S.ws.listIssues(root).includes(id)) return true;
  const plan = S.ws.loadYaml(S.ws.abs(root, 'story/series-plan.yaml'));
  return !!(plan && Array.isArray(plan.issues) && plan.issues.some((i) => i && i.id === id));
}

function existing(root, rels) {
  return rels.filter((rel) => fs.existsSync(S.ws.abs(root, rel)));
}

/**
 * The context of a screen key.
 * @returns {{key, screen, files: string[], commands: string[]}} files are
 *   workspace-relative and exist.
 * @throws 400 on a malformed key, 404 when the thing it names is not there
 */
function contextOf(project, key) {
  const root = project.root;
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new HttpError(400, 'bad_chat_key',
      'Unknown chat key. Use story, style, options, characters, places, character:<ID>, location:<ID>, prop:<ID>, pages:<ISS_ID>, page:<PAGE_ID>, cover:<ISS_ID> or publish:<ISS_ID>.');
  }
  const [kind, id] = key.split(':');
  const missing = (what) => new HttpError(404, 'chat_target_not_found', `${what} does not exist in this project.`);
  switch (kind) {
    case 'story': {
      let sources = [];
      try {
        sources = fs.readdirSync(path.join(root, 'story', 'source')).map((n) => `story/source/${n}`);
      } catch (err) {
        sources = [];
      }
      return {
        key, screen: 'story',
        files: existing(root, ['story/story-bible.yaml', 'story/series-plan.yaml', ...sources.slice(0, 6)]),
        commands: ['commands/story-bible.md', 'commands/series-plan.md', 'commands/source-analyze.md'],
      };
    }
    case 'style':
      return {
        key, screen: 'style',
        files: existing(root, ['style/style-bible.md', 'style/style-block.txt', 'style/color-script.md', 'project.yaml']),
        commands: ['commands/style-bible.md'],
      };
    case 'options':
      return { key, screen: 'project options', files: existing(root, ['project.yaml']), commands: ['commands/project-init.md'] };
    case 'characters': {
      const files = [];
      for (const charId of S.ws.listEntityIds(root, 'characters')) {
        files.push(`characters/${charId}/character.yaml`, `characters/${charId}/wardrobe.yaml`);
      }
      return { key, screen: 'characters', files: existing(root, files), commands: ['commands/character-bible.md'] };
    }
    case 'character':
      if (!S.ws.loadCharacter(root, id)) throw missing(id);
      return {
        key, screen: `character ${id}`,
        files: existing(root, [`characters/${id}/character.yaml`, `characters/${id}/wardrobe.yaml`]),
        commands: ['commands/character-bible.md'],
      };
    case 'places': {
      const files = [];
      for (const locId of S.ws.listEntityIds(root, 'locations')) files.push(`locations/${locId}/location.yaml`, `locations/${locId}/map.yaml`);
      for (const propId of S.ws.listEntityIds(root, 'props')) files.push(`props/${propId}/prop.yaml`);
      return { key, screen: 'places and objects', files: existing(root, files), commands: ['commands/location-bible.md', 'commands/prop-bible.md'] };
    }
    case 'location':
      if (!S.ws.loadLocation(root, id)) throw missing(id);
      return {
        key, screen: `location ${id}`,
        files: existing(root, [`locations/${id}/location.yaml`, `locations/${id}/map.yaml`]),
        commands: ['commands/location-bible.md'],
      };
    case 'prop':
      if (!S.ws.loadProp(root, id)) throw missing(id);
      return { key, screen: `prop ${id}`, files: existing(root, [`props/${id}/prop.yaml`]), commands: ['commands/prop-bible.md'] };
    case 'pages': {
      if (!knownIssue(root, id)) throw missing(id);
      const files = [`issues/${id}/issue.yaml`, 'story/series-plan.yaml', ...S.ws.listScenes(root, id).map((s) => S.ws.rel(root, s.file))];
      for (const pageId of S.ws.listPageIds(root, id).slice(0, 40)) files.push(`issues/${id}/pages/${pageId}/page.yaml`);
      return {
        key, screen: `pages of ${id}`, files: existing(root, files),
        commands: ['commands/issue-breakdown.md', 'commands/page-plan.md', 'commands/panel-script.md', 'commands/panel-ledger.md'],
      };
    }
    case 'page': {
      if (!S.ws.ID.page.test(id) || !S.ws.loadPage(root, id)) throw missing(id);
      const issue = S.ws.issueOfPage(id);
      const base = `issues/${issue}/pages/${id}`;
      const page = S.ws.loadPage(root, id);
      const files = [`${base}/page.yaml`, `${base}/lettering.yaml`];
      if (page.current_render) files.push(`${base}/reviews/${page.current_render}.review.yaml`);
      if (page.scene) files.push(`issues/${issue}/scenes/${page.scene}.yaml`);
      return {
        key, screen: `page ${id}`, files: existing(root, files),
        commands: ['commands/page-plan.md', 'commands/panel-script.md', 'commands/panel-ledger.md'],
      };
    }
    case 'cover':
      if (!knownIssue(root, id)) throw missing(id);
      return {
        key, screen: `cover of ${id}`,
        files: existing(root, [`issues/${id}/cover/cover.yaml`, `issues/${id}/issue.yaml`, 'story/story-bible.yaml']),
        commands: ['commands/cover.md'],
      };
    case 'publish': {
      if (!knownIssue(root, id)) throw missing(id);
      const editions = S.ws.listEditions(root).filter((e) => e.startsWith(`ED_${id.slice(4)}_`));
      const files = [`issues/${id}/issue.yaml`];
      if (editions.length) files.push(`editions/${editions[editions.length - 1]}/edition.yaml`);
      return { key, screen: `publishing ${id}`, files: existing(root, files), commands: ['commands/build-edition.md', 'commands/continuity-review.md'] };
    }
    default:
      throw new HttpError(400, 'bad_chat_key', 'Unknown chat key.');
  }
}

function fileOf(project, key) {
  return path.join(project.chatsDir, `${key.replace(/:/g, '--')}.jsonl`);
}

/** Messages of a conversation, oldest first. */
function transcript(project, key) {
  return readJsonl(fileOf(project, key));
}

/** Append a message and return it with its id and time. */
function append(project, key, message) {
  const full = Object.assign({ id: newId('msg'), at: nowIso(), key, role: 'assistant', text: '', job: null }, message);
  appendJsonl(fileOf(project, key), full);
  return full;
}

/** Keys that have a transcript, with their size and last message time. */
function list(project) {
  let names = [];
  try {
    names = fs.readdirSync(project.chatsDir).filter((n) => n.endsWith('.jsonl'));
  } catch (err) {
    return [];
  }
  return names.map((name) => {
    const key = name.replace(/\.jsonl$/, '').replace(/--/g, ':');
    const messages = readJsonl(path.join(project.chatsDir, name));
    const last = messages[messages.length - 1] || null;
    return { key, messages: messages.length, last_at: last ? last.at : null };
  }).sort((a, b) => (a.key < b.key ? -1 : 1));
}

module.exports = { KEY_RE, contextOf, transcript, append, list };
