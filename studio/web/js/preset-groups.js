// The families of look presets, as templates/looks/README.md groups them.
// The server does not send a group with a preset, so the list lives here; a
// preset that is not listed goes under "other looks".

export const GROUPS = [
  ['traditions', ['ligne-claire', 'franco-belgian-realistic', 'painted-album', 'italian-popular-bw', 'superhero-modern', 'four-color-sixties', 'adventure-strip', 'underground-comix']],
  ['manga', ['manga-screentone', 'shojo-manga', 'gekiga', 'yonkoma-comedy', 'webtoon-color']],
  ['indie', ['painted-watercolor', 'indie-minimal-line', 'risograph-two-color', 'woodcut-print', 'charcoal-graphite']],
  ['humor', ['newspaper-strip', 'young-readers-cartoon', 'franco-belgian-humor']],
  ['genre', ['noir-ink', 'horror-scratch-wash', 'retro-pulp-scifi', 'cyberpunk-neon', 'fantasy-illuminated']],
];

/** [[group, presets]] in the README's order, with unlisted presets last. */
export function groupPresets(presets) {
  const byKey = new Map(presets.map((p) => [p.key, p]));
  const used = new Set();
  const out = [];
  for (const [group, keys] of GROUPS) {
    const list = keys.map((k) => byKey.get(k)).filter(Boolean);
    list.forEach((p) => used.add(p.key));
    if (list.length) out.push([group, list]);
  }
  const rest = presets.filter((p) => !used.has(p.key));
  if (rest.length) out.push(['misc', rest]);
  return out;
}
