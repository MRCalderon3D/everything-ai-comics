'use strict';
/**
 * The general options of a project: a form over production/project.yaml.
 * Only the fields a person picks in the studio are writable here; the rest
 * of the file belongs to the scaffold's commands.
 */

const fs = require('fs');
const path = require('path');
const S = require('./scaffold');
const { HttpError } = require('./util');

const FORMATS = ['paged', 'webtoon'];
const DIRECTIONS = ['ltr', 'rtl'];
const COLOR_MODES = ['monochrome', 'limited', 'full_color'];
const LETTERING_MODES = ['in_image', 'overlay'];
const PUBLICATIONS = ['strip', 'one-shot', 'miniseries', 'ongoing', 'graphic-novel', 'webtoon-series'];
const RATINGS = ['all-ages', 'teen', 'mature'];

/** Page sizes offered in the form. Width and height in pixels at the listed ratio. */
const PAGE_SIZES = [
  { id: 'comic-2-3', label: 'Comic page 2:3', aspect_ratio: '2:3', width_px: 2000, height_px: 3000, formats: ['paged'] },
  { id: 'album-3-4', label: 'Album page 3:4', aspect_ratio: '3:4', width_px: 2100, height_px: 2800, formats: ['paged'] },
  { id: 'square', label: 'Square 1:1', aspect_ratio: '1:1', width_px: 2048, height_px: 2048, formats: ['paged'] },
  { id: 'scroll-9-16', label: 'Scroll segment 9:16', aspect_ratio: '9:16', width_px: 1080, height_px: 1920, formats: ['webtoon'] },
];

function bad(message) {
  return new HttpError(400, 'bad_options', message);
}

/**
 * Check an options patch and return it as a nested partial of project.yaml.
 * Unknown keys are refused, so a typo is not silently dropped.
 */
function checkOptions(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw bad('Options must be an object.');
  const out = {};
  const text = (name, max) => {
    if (typeof patch[name] !== 'string' || !patch[name].trim() || patch[name].length > max) {
      throw bad(`"${name}" must be text of at most ${max} characters.`);
    }
    return patch[name].replace(/\s+/g, ' ').trim();
  };
  const oneOf = (value, list, name) => {
    if (!list.includes(value)) throw bad(`"${name}" must be one of ${list.join(', ')}.`);
    return value;
  };
  for (const key of Object.keys(patch)) {
    switch (key) {
      case 'title': out.title = text('title', 120); break;
      case 'logline': out.logline = text('logline', 400); break;
      case 'genre': out.genre = text('genre', 60); break;
      case 'language':
        if (typeof patch.language !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(patch.language)) {
          throw bad('"language" must be a language code such as en or es.');
        }
        out.language = patch.language;
        break;
      case 'comic_format': out.comic_format = oneOf(patch.comic_format, FORMATS, 'comic_format'); break;
      case 'publication': out.publication = oneOf(patch.publication, PUBLICATIONS, 'publication'); break;
      case 'reading_direction': out.reading_direction = oneOf(patch.reading_direction, DIRECTIONS, 'reading_direction'); break;
      case 'color_mode': out.color_mode = oneOf(patch.color_mode, COLOR_MODES, 'color_mode'); break;
      case 'lettering_mode': out.lettering = { mode: oneOf(patch.lettering_mode, LETTERING_MODES, 'lettering_mode') }; break;
      case 'rating': out.content = { rating: oneOf(patch.rating, RATINGS, 'rating') }; break;
      case 'repair_limit':
        if (!Number.isInteger(patch.repair_limit) || patch.repair_limit < 0 || patch.repair_limit > 10) {
          throw bad('"repair_limit" must be a whole number from 0 to 10.');
        }
        out.repair_policy = { max_cycles: patch.repair_limit };
        break;
      case 'page_size': {
        const size = PAGE_SIZES.find((s) => s.id === patch.page_size);
        if (!size) throw bad(`"page_size" must be one of ${PAGE_SIZES.map((s) => s.id).join(', ')}.`);
        out.page = { aspect_ratio: size.aspect_ratio, width_px: size.width_px, height_px: size.height_px };
        break;
      }
      case 'page': {
        const p = patch.page;
        if (!p || typeof p !== 'object' || !/^\d+:\d+$/.test(String(p.aspect_ratio)) ||
            !Number.isInteger(p.width_px) || !Number.isInteger(p.height_px) ||
            p.width_px < 256 || p.height_px < 256 || p.width_px > 12000 || p.height_px > 12000) {
          throw bad('"page" needs aspect_ratio ("2:3"), width_px and height_px (256 to 12000).');
        }
        out.page = { aspect_ratio: p.aspect_ratio, width_px: p.width_px, height_px: p.height_px };
        break;
      }
      default:
        throw bad(`"${key}" is not an option. Options: title, logline, genre, language, comic_format, publication, reading_direction, color_mode, lettering_mode, rating, repair_limit, page_size, page.`);
    }
  }
  return out;
}

/** Leaves of a nested partial as [path[], value] pairs. */
function leaves(obj, prefix = []) {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...leaves(value, [...prefix, key]));
    else out.push([[...prefix, key], value]);
  }
  return out;
}

/** Apply a nested partial to project.yaml, keeping its comments when the edit can be placed. */
function applyToProject(root, partial) {
  const file = path.join(root, 'project.yaml');
  const edit = S.yamlEdit;
  const changes = leaves(partial);
  const mutate = (doc) => {
    for (const [keys, value] of changes) {
      let node = doc;
      for (const key of keys.slice(0, -1)) {
        if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {};
        node = node[key];
      }
      node[keys[keys.length - 1]] = value;
    }
  };
  if (edit && typeof edit.rewriteYamlFile === 'function') {
    return edit.rewriteYamlFile(file, mutate, (lines) => {
      for (const [keys, value] of changes) {
        let from = 0;
        let to = lines.length;
        let indent = 0;
        let range = null;
        for (const key of keys) {
          range = edit.findKey(lines, key, indent, from, to);
          if (!range) return false;
          from = range.line + 1;
          to = range.end;
          const child = edit.childIndent(lines, range);
          indent = child === null ? indent + 2 : child;
        }
        if (edit.setValue(lines, range, value) === false) return false;
      }
      return true;
    });
  }
  const doc = S.ws.loadProject(root) || {};
  mutate(doc);
  fs.writeFileSync(file, S.yaml.stringify(doc));
  return { changed: true, preserved: false, doc };
}

/** The options as the form shows them. */
function readOptions(root) {
  const doc = S.ws.loadProject(root) || {};
  const page = doc.page || {};
  const size = PAGE_SIZES.find((s) => s.aspect_ratio === page.aspect_ratio && s.width_px === page.width_px && s.height_px === page.height_px);
  return {
    title: doc.title || '',
    logline: doc.logline || '',
    genre: doc.genre || '',
    language: doc.language || 'en',
    comic_format: doc.comic_format || 'paged',
    publication: doc.publication || 'one-shot',
    reading_direction: doc.reading_direction || 'ltr',
    color_mode: doc.color_mode || 'full_color',
    lettering_mode: (doc.lettering && doc.lettering.mode) || 'in_image',
    rating: (doc.content && doc.content.rating) || null,
    repair_limit: doc.repair_policy && Number.isInteger(doc.repair_policy.max_cycles) ? doc.repair_policy.max_cycles : 2,
    page: { aspect_ratio: page.aspect_ratio || '2:3', width_px: page.width_px || null, height_px: page.height_px || null },
    page_size: size ? size.id : null,
    image_provider: (doc.default_providers && doc.default_providers.image) || null,
  };
}

const CHOICES = {
  comic_format: FORMATS,
  reading_direction: DIRECTIONS,
  color_mode: COLOR_MODES,
  lettering_mode: LETTERING_MODES,
  publication: PUBLICATIONS,
  rating: RATINGS,
  page_size: PAGE_SIZES,
};

module.exports = { checkOptions, applyToProject, readOptions, CHOICES, PAGE_SIZES };
