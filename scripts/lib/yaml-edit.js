'use strict';
/**
 * Change a value in a YAML file and keep the rest of the text: comments,
 * blank lines, key order, and the flow or block style of lists.
 *
 * yaml.stringify() rewrites a whole document and drops its comments, which
 * is wrong for files people annotate (project.yaml, character.yaml, the
 * reference registry). The helpers here edit the lines instead. Every edit
 * goes through rewriteYamlFile(), which parses the edited text and compares
 * it with the document the caller asked for. When the two differ, or the
 * text edit cannot find its place, the file is written from the document
 * with yaml.stringify() and only the comment block at the top survives. So
 * the result is always the requested document; keeping the comments is best
 * effort.
 */

const fs = require('fs');
const yaml = require('./yaml');
const { deepEqual } = require('./schema');

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line) {
  const text = line.trim();
  return text === '' || text.startsWith('#');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Split `key: value  # comment` after the colon: the value text and the comment with its leading spaces. */
function splitComment(rest) {
  let single = false;
  let double = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (double) {
      if (ch === '\\') i++;
      else if (ch === '"') double = false;
    } else if (single) {
      if (ch === "'") single = false;
    } else if (ch === '"') {
      double = true;
    } else if (ch === "'") {
      single = true;
    } else if (ch === '#' && (i === 0 || /\s/.test(rest[i - 1]))) {
      const cut = rest.slice(0, i).replace(/\s+$/, '').length;
      return { value: rest.slice(0, cut), comment: rest.slice(cut) };
    }
  }
  return { value: rest.replace(/\s+$/, ''), comment: '' };
}

function scalarText(value) {
  return yaml.stringify({ k: value }).slice(3).replace(/\n$/, '');
}

/**
 * Index one past the last line that belongs to the node starting at `start`
 * (a key line or a list item line). Blank and comment lines at the end of
 * the block are left outside it.
 * @param {number} indent indentation of the line at `start`
 * @param {boolean} [listAtSameIndent] a key's block list may sit at the key's own indentation
 */
function blockEnd(lines, start, indent, limit, listAtSameIndent = false) {
  let end = start + 1;
  for (let i = start + 1; i < limit; i++) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const depth = indentOf(line);
    const sameIndentItem = listAtSameIndent && depth === indent && /^-(\s|$)/.test(line.trimStart());
    if (depth > indent || sameIndentItem) end = i + 1;
    else break;
  }
  return end;
}

/** The line of `key:` at exactly `indent` inside [from, to), with the end of its block; or null. */
function findKey(lines, key, indent, from = 0, to = lines.length) {
  const pattern = new RegExp(`^ {${indent}}${escapeRegExp(key)}:(\\s|$)`);
  for (let i = from; i < to; i++) {
    if (pattern.test(lines[i])) return { line: i, end: blockEnd(lines, i, indent, to, true), indent };
  }
  return null;
}

/** Indentation of the first content line inside a block, or null when it is empty. */
function childIndent(lines, range) {
  for (let i = range.line + 1; i < range.end; i++) {
    if (!isBlankOrComment(lines[i])) return indentOf(lines[i]);
  }
  return null;
}

/**
 * The list item whose first field is `<field>: <value>` inside [from, to):
 * `- id: CHAR_MARA_TURN_MASTER_V01`. Returns its lines and the indentation
 * of its fields, or null.
 */
function findItem(lines, field, value, from = 0, to = lines.length) {
  const pattern = new RegExp(`^(\\s*)-(\\s+)${escapeRegExp(field)}:\\s*["']?${escapeRegExp(value)}["']?\\s*(#.*)?$`);
  for (let i = from; i < to; i++) {
    const m = pattern.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    return { line: i, end: blockEnd(lines, i, indent, to), indent, fieldIndent: indent + 1 + m[2].length };
  }
  return null;
}

/**
 * Replace the value of the key at `range` (from findKey) with a scalar or a
 * list of scalars. A list keeps the style it had: `[a, b]` stays on the key
 * line, a block list stays a block. A trailing comment on the key line is
 * kept. Mutates `lines`; returns false when the value cannot be written here.
 */
function setValue(lines, range, value) {
  const head = /^(\s*[^:#]+:)(.*)$/.exec(lines[range.line]);
  if (!head) return false;
  const { value: inline, comment } = splitComment(head[2]);
  const inlineText = inline.trim();
  const blockLines = range.end - range.line - 1;
  const padComment = comment ? (comment.startsWith(' ') ? comment : ` ${comment}`) : '';

  if (!Array.isArray(value)) {
    if (value !== null && typeof value === 'object') return false;
    if (blockLines > 0 && inlineText === '') return false; // a nested map or list: not ours to flatten
    lines.splice(range.line, range.end - range.line, `${head[1]} ${scalarText(value)}${padComment}`);
    return true;
  }
  if (value.some((item) => item !== null && typeof item === 'object')) return false;

  const flow = `[${value.map(scalarText).join(', ')}]`;
  const wasBlock = inlineText === '' && blockLines > 0;
  if (!wasBlock || value.length === 0) {
    if (inlineText !== '' && !inlineText.startsWith('[')) return false;
    lines.splice(range.line, range.end - range.line, `${head[1]} ${flow}${padComment}`);
    return true;
  }
  let itemIndent = range.indent + 2;
  for (let i = range.line + 1; i < range.end; i++) {
    if (!isBlankOrComment(lines[i])) {
      itemIndent = indentOf(lines[i]);
      break;
    }
  }
  const items = value.map((item) => `${' '.repeat(itemIndent)}- ${scalarText(item)}`);
  lines.splice(range.line + 1, range.end - range.line - 1, ...items);
  return true;
}

/** Comment and blank lines before the first content line, as text. */
function leadingComments(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    if (!isBlankOrComment(line)) break;
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.length ? `${kept.join('\n')}\n\n` : '';
}

/**
 * Rewrite a YAML file so that it parses to a changed document.
 *
 * @param {string} file
 * @param {(doc: object) => void} mutate Changes a copy of the parsed document in place.
 * @param {(lines: string[], doc: object) => boolean|void} [edit] Applies the
 *   same change to the lines of the file. Return false when it cannot.
 * @returns {{changed: boolean, preserved: boolean, doc: object}}
 *   `preserved` is false when the file had to be written from the document
 *   and lost the comments below its header.
 */
function rewriteYamlFile(file, mutate, edit) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const before = yaml.parse(text);
  const doc = JSON.parse(JSON.stringify(before === undefined ? null : before));
  mutate(doc);
  if (deepEqual(before, doc)) return { changed: false, preserved: true, doc };

  let next = null;
  if (typeof edit === 'function') {
    try {
      const lines = text.split('\n');
      if (edit(lines, doc) !== false) {
        const candidate = lines.join('\n');
        if (deepEqual(yaml.parse(candidate), doc)) next = candidate;
      }
    } catch (err) {
      next = null;
    }
  }
  const preserved = next !== null;
  if (!preserved) next = leadingComments(text) + yaml.stringify(doc);
  fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`);
  return { changed: true, preserved, doc };
}

module.exports = {
  indentOf,
  isBlankOrComment,
  blockEnd,
  findKey,
  childIndent,
  findItem,
  setValue,
  scalarText,
  leadingComments,
  rewriteYamlFile,
};
