'use strict';
/**
 * Recognise a usage-limit answer from a drawing or writing tool, so a
 * provider can record it as its own error kind (`tool_quota`) instead of a
 * failed drawing. Pure, no I/O, zero dependencies.
 *
 * The wording comes from the tools themselves, read from their binaries and
 * from real runs (2026-11-27):
 * - Codex's image tool, in its final message: "Image generation failed
 *   because the usage limit was reached" and "the built-in tool's usage
 *   limit was reached". The Codex CLI itself: "You've hit your usage limit.
 *   ... or try again at <time>.", "Usage limit reached. You've reached your
 *   usage limit.", "rate limit reached".
 * - Claude Code: "Usage limit reached · limit resets <time>", "You've hit
 *   your limit · resets <time>", "5-hour limit reached", "Claude AI usage
 *   limit reached|<unix seconds>" in older versions, and the API's "rate
 *   limited", "credit balance too low".
 * - HTTP image APIs: status 429, "Too Many Requests", "quota".
 *
 * Anything else matching broadly ("usage limit", "rate limit", "quota")
 * counts too: a false positive pauses work the person can resume with one
 * click, a false negative burns the next pages on the same refusal.
 */

const PATTERNS = [
  /\busage[ -]limits?\b/i,
  /\brate[ -]limit(?:ed|s)?\b/i,
  /\bhit your (?:[\w-]+ )?limit\b/i,
  /\b(?:5-hour|five-hour|weekly|daily|monthly|session|opus|fast|spend) limit (?:reached|was reached|hit)\b/i,
  /\bquota\b/i,
  /\btoo many requests\b/i,
  /\bcredit balance (?:is )?too low\b/i,
  /\bout of credits\b/i,
  /\bHTTP 429\b|\bstatus 429\b|\b429 Too Many\b/i,
];

/** Words that look like a limit but are not the tool's quota. */
const NOT_QUOTA = [
  /\brepair limit\b/i,
  /\bcontext limit\b/i,
  /\bnesting limit\b/i,
  /\bsubagent limit\b/i,
];

/** What a tool said about when the limit resets, in its own words, or null. */
function resetText(text) {
  const source = String(text || '');
  // Claude Code before 2.x: "Claude AI usage limit reached|1754024400".
  const unix = /limit reached\|(\d{9,11})\b/i.exec(source);
  if (unix) {
    const at = new Date(Number(unix[1]) * 1000);
    if (!Number.isNaN(at.getTime())) return at.toISOString();
  }
  const m = /\b(?:try again (?:at|in|after)|(?:limit )?resets?(?: at| in| on)?)\s+([^.\n|"·∙]{2,60})/i.exec(source);
  if (!m) return null;
  let value = m[1].trim().replace(/[,;:\]]+$/, '').trim();
  // A closing bracket that closes nothing opened in the value belongs to the sentence around it.
  while (value.endsWith(')') && (value.match(/\(/g) || []).length < (value.match(/\)/g) || []).length) value = value.slice(0, -1).trim();
  if (!value || /^(later|soon|shortly)$/i.test(value)) return null;
  return value;
}

/**
 * @param {...string} texts what the tool printed: its final message, error
 *   events, stderr. Empty values are skipped.
 * @returns {{kind: 'tool_quota', resets: string|null, said: string}|null}
 *   said: the sentence that matched, for the record.
 */
function detectQuota(...texts) {
  for (const raw of texts) {
    const text = String(raw || '');
    if (!text.trim()) continue;
    if (!PATTERNS.some((re) => re.test(text))) continue;
    // "repair limit reached" and friends alone are not a quota answer.
    const cleaned = NOT_QUOTA.reduce((acc, re) => acc.replace(new RegExp(re.source, 'gi'), ''), text);
    if (!PATTERNS.some((re) => re.test(cleaned))) continue;
    const sentence = (cleaned.split(/(?<=[.!?])\s+|\n/).find((s) => PATTERNS.some((re) => re.test(s))) || cleaned)
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    return { kind: 'tool_quota', resets: resetText(text), said: sentence };
  }
  return null;
}

module.exports = { detectQuota, resetText, PATTERNS };
