# templates/looks/previews/

Sample pages for the look presets, one image per preset. They let a person
see a style before choosing it, and they let you compare looks side by side
because every sample shows the same page.

Every preset has its sample. The first set was drawn on 2026-11-26.

## What goes here

- One PNG per preset, named after the preset file:
  `<preset file stem>.jpg`, for example `noir-ink.jpg` for `noir-ink.yaml`.
- Every image draws the page in [scene.md](scene.md): one portrait page,
  three panels, the same character, place, prop, caption, and balloon.
- Drawn with the `codex-cli` image provider
  (`providers/image/codex-cli.js`), in its 2:3 frame, then scaled to 768
  pixels wide and saved as JPEG (quality 86) to keep the repository small.
  The studio also accepts `.png` and `.webp`.
- The prompt is the preset's `style_block` as it stands in the YAML file,
  a line listing its `negative_vocabulary` to avoid, and the scene from its
  `## Page` heading on. Nothing else is added for one preset and not the
  others.
- A preset added later gets its sample in the same change, drawn the same
  way.

A sample shows what the look can produce. It is not an approved look master
and nothing in a workspace points at it. A production still freezes its own
block and approves its own look page.

## Drawing a sample

1. Build the prompt from the preset's `style_block` and the text of
   `scene.md` below it.
2. Draw it twice with `codex-cli`. Compare the two against the preset's
   `drift_risks` and against each other. If they differ in the ways the
   preset lists, note it; if they differ in a way it does not list, add
   that to `drift_risks`.
3. Look at the better of the two against `scene.md`: the exact caption and
   balloon text, no extra text, the character's fixed features, the box in
   all three panels, hands drawn whole. Draw again if it fails. A script
   cannot make this call.
4. Save it here as `<preset file stem>.jpg` and add its row to the table
   below.

## Provenance

One row per file. Codex does not report a seed, and it names its image model
only sometimes, so those columns say `not reported` when it gives nothing.

| File | Preset ID | Provider | Model | Drawn on | Attempts | Reviewed by | Notes |
|---|---|---|---|---|---|---|---|
| adventure-strip.jpg | LOOK_ADVENTURE_STRIP_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Drawn in the shared three-panel layout, not as a single strip tier. |
| charcoal-graphite.jpg | LOOK_CHARCOAL_GRAPHITE_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| cyberpunk-neon.jpg | LOOK_CYBERPUNK_NEON_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| fantasy-illuminated.jpg | LOOK_FANTASY_ILLUMINATED_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| four-color-sixties.jpg | LOOK_FOUR_COLOR_SIXTIES_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| franco-belgian-humor.jpg | LOOK_FRANCO_BELGIAN_HUMOR_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| franco-belgian-realistic.jpg | LOOK_FRANCO_BELGIAN_REALISTIC_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Close to superhero-modern with this scene. |
| gekiga.jpg | LOOK_GEKIGA_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Close to italian-popular-bw and horror-scratch-wash at thumbnail size. |
| horror-scratch-wash.jpg | LOOK_HORROR_SCRATCH_WASH_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Close to gekiga at thumbnail size. |
| indie-minimal-line.jpg | LOOK_INDIE_MINIMAL_LINE_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| italian-popular-bw.jpg | LOOK_ITALIAN_POPULAR_BW_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Close to gekiga at thumbnail size. |
| ligne-claire.jpg | LOOK_LIGNE_CLAIRE_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| manga-screentone.jpg | LOOK_MANGA_SCREENTONE_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| newspaper-strip.jpg | LOOK_NEWSPAPER_STRIP_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Drawn in the shared three-panel layout, not as a single strip tier. |
| noir-ink.jpg | LOOK_NOIR_INK_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| painted-album.jpg | LOOK_PAINTED_ALBUM_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| painted-watercolor.jpg | LOOK_PAINTED_WATERCOLOR_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| retro-pulp-scifi.jpg | LOOK_RETRO_PULP_SCIFI_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| risograph-two-color.jpg | LOOK_RISOGRAPH_TWO_COLOR_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| shojo-manga.jpg | LOOK_SHOJO_MANGA_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| superhero-modern.jpg | LOOK_SUPERHERO_MODERN_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Reads close to webtoon-color and franco-belgian-realistic with this quiet scene; the look shows more in action. |
| underground-comix.jpg | LOOK_UNDERGROUND_COMIX_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| webtoon-color.jpg | LOOK_WEBTOON_COLOR_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Close to superhero-modern here. Drawn in the shared 2:3 page layout, not as a vertical scroll. |
| woodcut-print.jpg | LOOK_WOODCUT_PRINT_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |
| yonkoma-comedy.jpg | LOOK_YONKOMA_COMEDY_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Drawn in the shared three-panel layout, not as a four-panel column. |
| young-readers-cartoon.jpg | LOOK_YOUNG_READERS_CARTOON_V01 | codex-cli | not reported | 2026-11-26 | 1 | lead, against scene.md | Caption and balloon text exact; character, box and hands consistent across the three panels. |

The first set was drawn once per preset, not twice as step 2 asks, so the
`drift_risks` of each preset are not yet checked against a second draw.

Columns:

- File: the PNG in this folder.
- Preset ID: the `id` of the preset at the time of drawing, for example
  `LOOK_NOIR_INK_V01`. When a preset's style block changes, its sample is
  drawn again.
- Provider: `codex-cli`.
- Model: the model Codex reported for the session or the image, or
  `not reported`.
- Drawn on: the date, as YYYY-MM-DD.
- Attempts: how many images were drawn before this one was kept.
- Reviewed by: who looked at it against `scene.md`.
- Notes: drifts seen between the two draws, and anything in the image that
  departs from the scene.
