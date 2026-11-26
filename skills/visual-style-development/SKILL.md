---
name: visual-style-development
description: Define the comic's visual language (line, tone, texture, rendering) as an enforceable style bible.
origin: everything-ai-comics
category: visual
---

# Visual Style Development

## Purpose

Settle how the comic is drawn and write it down in three forms: a style
bible people read, a frozen prompt block that goes into every request word
for word, and a look master image that is attached to every request. The
written rules have to be specific enough that a page can be judged in or
out of style.

## Use When

- Starting the style bible for a new project.
- Props, characters, or locations need style rules to be drawn against.
- Pages come back with different line weight, shading, or rendering from
  one to the next.
- The user supplies style references that should become the look.

## Inputs

- `production/story/story-bible.yaml`: tone, genre, period.
- `production/project.yaml`: `color_mode`, `comic_format`, `lettering`,
  `style.influences`.
- Style references registered by `reference-ingestion`, and the presets in
  `templates/looks/`.
- Existing `LOOK_*` assets and `production/style/` files when revising.

## Process

1. Name the look (`LOOK_<NAME>`) and say in one sentence why it suits this
   story. Start from a preset in `templates/looks/` when one is close.
2. Define the line: the tool it imitates (brush, nib, technical pen), the
   range of weights, whether contours are heavier than interior lines, and
   how weight separates near from far.
3. Define inking and tone: how much of a page is solid black, whether
   shadows are solid shapes or hatching, whether screentone or gradients
   are allowed at all.
4. Define texture and rendering: flat, cel-shaded, or painted; paper grain
   or clean; how far faces, hands, and backgrounds are simplified, and how
   that changes with panel size.
5. Record the color mode from `project.color_mode` and pass palette, spot
   color, and tonal progression to `color-scripting`.
6. Define the page furniture with the letterer: panel borders, gutter
   width and color, balloon shape, caption boxes, how sound effects are
   drawn. Record font and case in `project.lettering`.
7. State what the style may never alter: identity anchors, wardrobe
   details, map geometry. Then state what the comic never looks like
   (photographic rendering, 3D shading, soft airbrush), in plain terms.
8. Write `production/style/style-bible.md` from steps 1 to 7. Each rule is
   a statement a page can fail: "no gradients", "shadows are solid black
   shapes", "three line weights".
9. Write `production/style/style-block.txt`: the same rules as one dense
   paragraph of literal description for the image model. Describe traits
   and avoid artists' names. This file is model-facing and exempt from the
   prose rules.
10. Generate the look page through `/visual-development`:
    `node scripts/compile-prompts.js --asset <LOOK_ID> --sheet look --root <workspace>`
    writes `references/style/prompts/<provider>.<LOOK_ID>.yaml`, and
    `node scripts/generate-assets.js --asset <LOOK_ID> --root <workspace>`
    runs it. The brief is a sample page of three or four bordered panels
    with an anonymous figure, a plain setting, and, in `in_image` lettering
    mode, one balloon and one caption. The first look page of a project is
    compiled with no reference image; later versions attach the approved
    look. Candidates land in `production/references/style/` as
    `<LOOK_ID>_V##`. Compare each with the written rules, correct whichever
    is wrong, and repeat until they agree. Save the pick as
    `<LOOK_ID>_MASTER_V##` and register it with `kind: look` and
    `default_role: style`.
11. Freeze on approval. Set `project.style.look_refs` and
    `project.style.style_block`. From here on the block is reused verbatim
    in every request and the look master is attached to every request with
    role `style`. Repeating a style word in a prompt is no substitute for
    attaching the image.
12. Treat any later edit as a version change. Editing the block changes
    `source_hashes.style_block`, which makes every compiled package stale.
    A changed look gets the next `_V##`, and pages rendered under the old
    one are reviewed again against the new one.
13. Apply the same rules to props when `/prop-bible` asks: a prop's
    `description`, `distinguishing_features`, and `prompt_summary` use the
    look's vocabulary for line and rendering.

## Outputs

- `production/style/style-bible.md`.
- `production/style/style-block.txt`, frozen once approved.
- The approved look master under `production/references/style/`, registered
  in `production/references/manifest.yaml`.
- `style`, `color_mode`, and `lettering` settings in
  `production/project.yaml`.

## Quality Bar

- Every rule in the style bible can be checked against a page with a yes or
  no answer.
- The style block contains no rule the style bible lacks, and the reverse.
- An approved look master exists and shows every stated rule.
- `project.style.style_block` points at the block and `look_refs` at the
  master.
- The block contains no character, location, or story content.
- No compiled prompt package carries a style block hash that differs from
  the current file.

## Common Failure Modes

- Adjective soup ("gritty, moody, cinematic") with nothing a page can fail.
- Relying on the word "noir" in each prompt and attaching no image. The
  style then drifts toward the model's default within a few pages.
- A look master that is a single figure. Without panels, gutters, and a
  balloon, the model has no reference for how a page is built.
- Tweaking the style block for one difficult page, which quietly forks the
  style.
- A style rule that overwrites identity: "all faces angular" erases the
  round face that separates one character from another.
- A look master approved while it contradicts the written rules, so
  reviewers do not know which one to enforce.
- An artist's name standing in for a description. The result depends on
  what the model associates with that name.
- A style reference used as an identity reference because the character in
  it looked right.

## Related Agents

- art-director
- colorist
- letterer
- environment-designer

## Related Commands

- style-bible
- visual-development
- prop-bible
- ingest-references

## Notes

`prompt-compilation` takes style language from the style block and nowhere
else. If a page needs something the look lacks, extend the look as a new
version first. The policy is the frozen style block in
`rules/visual/visual-language.md` and one role per image in
`rules/image/reference-roles.md`.
