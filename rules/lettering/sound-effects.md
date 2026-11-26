# Sound effects

## Purpose

Use sound effects where they tell the reader something the drawing cannot,
draw them as part of the picture, and leave them out where silence does more.

## Scope

Lettering layer. Applies to every lettering element of type `sfx` in
`page.yaml` and `lettering.yaml`, to the sound-effect conventions in the
style bible, and to the `lettering` check of the visual review. Used by
`/panel-script`, `/lettering`, and `/smart-page`.

## Core Principles

- A sound effect is drawing. Its shape, weight, and direction are designed
  with the panel, in the project's line.
- A sound effect earns its place by adding information: a sound from off
  panel, a sound that sets up the next panel, or a force the drawing alone
  undersells.
- A reader takes in a sound effect at a glance. If it has to be deciphered,
  it failed.
- The page can be quiet. Silence is the default, and each sound is a
  decision.

## Sound effects as part of the drawing

- An `sfx` element has `speaker: null` and exact `text`, including repeated
  letters and punctuation ("KRRAK", "tik tik"). The spelling in `page.yaml`
  is the spelling on the page.
- The style bible fixes the family of sound-effect lettering: hand-drawn or
  typeset, outlined or solid, and which spot color it may use. Sound effects
  follow the style block like any other mark on the page.
- The lettering follows the force. An impact radiates from the point of
  contact, a sliding sound stretches along the path, a distant sound sits
  small against its source.
- Size is loudness. Keep the scale consistent across the issue so a gunshot
  is never smaller than a footstep.
- In `overlay` mode a sound effect is an overlay element with `shape: none`,
  placed by the letterer in the space the layout left at the source. A
  project whose sound effects must sit behind figures or share the art's
  texture uses `in_image` mode.

## Legibility

- A sound effect is readable at the size the page is read. Default: at most
  two short words, and letterforms that keep their counters open.
- Give it contrast with what lies behind it. An outline or a clear patch of
  background is enough.
- It MUST NOT cover a face, a hand, a held prop the story tracks, or the
  panel's main moment. It may overlap background and the edge of a figure.
- It MUST NOT be mistaken for dialogue. Sound effects sit outside balloons
  and use their own lettering style.

## Placement at the source

- Place the effect at the thing that makes the sound: the muzzle, the
  hinge, the boot. The reader should never have to ask what made the noise.
- For a source outside the frame, place the effect at the panel edge on the
  side where the source is, in agreement with the scene's `geography` and
  the ledger. A launch that approaches from the stern is heard from the
  stern side in every panel.
- A sound that continues across panels keeps its position relative to the
  source and may grow or shrink as the source moves.
- A sound effect gets an `order` value like any other element. Give it the
  position where the reader meets it on the path through the panel (see
  `reading-order.md`).

## Language and consistency

- Sound effects are written in the project's `language` and follow that
  language's conventions for onomatopoeia. A Spanish-language comic does
  not borrow English effects by default.
- One sound, one spelling. The same door, weapon, or engine uses the same
  word every time it is heard. Record the spellings in the lettering
  section of the style bible as they are coined.
- Case follows the project's sound-effect convention, which may differ from
  `project.lettering.case` for dialogue. State it once in the style bible.
- A translated edition translates or redraws the effects. That is a new
  edition with new renders or a new overlay.

## When silence is stronger

- Do not letter a sound the drawing already delivers, unless the sound is
  the beat. A slammed door drawn mid-slam rarely needs "SLAM".
- Default: one sound effect in a panel and at most two. A panel with three
  is usually three panels.
- The peak of a scene often lands harder silent. Try the panel with the
  effect removed before keeping it.
- Letter the sounds the story depends on and the drawing cannot show. When
  Mara hears the crates shift behind her, the effect is the only evidence
  on the page, so it stays.
- A page that is silent by design (see `layout/pacing.md`) carries no sound
  effects added to fill space.

## Validation

- `schemas/page.schema.json` and `schemas/lettering.schema.json` accept
  `sfx` as a lettering type and require its `text` and `order`.
- `scripts/check-continuity.js` checks that lettering `order` values are
  unique on the page, sound effects included.
- Spelling consistency across an issue has no script. The letterer checks
  new effects against the style bible's list in the self-review of
  `/lettering`.
- Exact spelling in the render, legibility, and placement at the source are
  judged on pixels under the `lettering` check of the visual review. Whether
  the effect matches the project's line is part of `style_fidelity`.
- Whether a panel is better silent is human review on the thumbnails.
