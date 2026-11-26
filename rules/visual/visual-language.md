# Visual language

## Purpose

Hold the comic to one look. A drawing style is a small set of choices about
line, tone, texture, and color, applied on every page. This rule keeps those
choices written down and attached to every request, so a model's defaults
never get to set the look.

## Scope

Visual layer. Applies to the style bible, the style block, the color script,
visual development, reference sheets, and the style constraints compiled
into every prompt package.

## Core Principles

- The style bible defines a finite visual system. Pages draw from it. They do
  not invent.
- The look is shown as well as described. An approved look master is attached
  as an image to every request, and the style text is the same on every
  request.
- Restraint is the style. Fewer line weights and fewer colors, used
  consistently, read as one hand. Default prettiness from the model is
  drift.
- Every deviation from the system is a marked story event, approved in the
  style bible before it is generated.

## Line, tone, and texture

`style/style-bible.md` states each of these in terms someone could check
against a page.

- Line: weight and how much it varies, the quality of the contour (clean,
  broken, brushed), and how form is modelled (hatching, feathering, or none).
- Tone: where the blacks go, whether greys exist and how they are made
  (wash, screentone, flat grey), whether gradients are allowed.
- Texture: paper grain, dry brush, halftone dots, or a clean digital
  surface.
- The style bible also names what the look excludes. For `LOOK_NOIR_INK`:
  heavy blacks, no gradients.
- The bible declares three to five named pillars that sum up the system
  ("light comes from one source per panel"). A page that breaks a pillar
  MUST say which and why.
- Reference sheets and location plates are drawn in the same look. A
  character sheet in a different style teaches the generator the wrong one.

## Color mode

- `project.color_mode` is `monochrome`, `limited`, or `full_color`, and
  every page obeys it.
- `spot_colors` lists each permitted spot color with its name, hex value,
  and `use`. A spot color appears only for its stated use. In the sample
  project, signal red is for flare light and nothing else.
- A spot color that turns up outside its use is a style defect, even when
  it looks good.
- Palette and tonal progression per scene and page are planned in
  `style/color-script.md`. A shift that is not scheduled there does not
  happen on a page.

## The frozen style block

- The style prompt lives in `style/style-block.txt`. Every prompt package
  includes it verbatim. Agents MUST NOT paraphrase it, extend it, or trim it
  for one page.
- Changing the block changes the look of everything compiled afterwards. It
  is a style-bible revision with its own approval, and pages compiled against
  the old block are stale.
- Page prompts MUST NOT contradict the block to get a nicer result on one
  page.
- Influences listed in the project or the style bible are direction for the
  people working on it. NEVER prompt "in the style of" a living artist or a
  franchise.

## The look master

- The project has at least one approved look master
  (`LOOK_<NAME>_MASTER_V##`), listed in `project.style.look_refs` and
  registered in `references/manifest.yaml`.
- The look master is attached to every generation request, for pages and for
  reference art, in the `style` role. Repeating a style word in the prompt
  is not a substitute for the image.
- A look master has one job. It never stands in for a character's face or a
  location's layout (`image/reference-roles.md`).
- When the provider's reference limit is tight, the look master is the last
  reference to be dropped, and dropping it needs a recorded reason in the
  reference plan's `exclude` notes.
- A new look master supersedes the old one (`common/approval-policy.md`).
  Pages of one issue SHOULD all be generated against the same version.

## Validation

- `project.schema.json` restricts `color_mode` to its three values and each
  spot color's `hex` to a six-digit value.
- `prompt-package.schema.json` requires `source_hashes`, which includes the
  hash of the style block the package was compiled with, and lists the
  attached references with their roles.
- `reference-plan.schema.json` restricts each entry to one role.
- Whether every plan and package for an issue includes the current look
  master in the `style` role is read from those files by the prompt-director
  and by `production-qa` at the generation gate.
- Whether a page matches the look is visual review. The `style_fidelity`
  check and the `style_fidelity` gate of every review are filled in by
  comparing the render with the look master, and the art-director decides
  doubtful cases.
