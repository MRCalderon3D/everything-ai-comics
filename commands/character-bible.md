---
description: Define identity, distinguishing features, wardrobe states, and reference-sheet plans for every character.
---

# /character-bible

## Purpose

Fix who each character is and how a reader tells them apart. Image models
blend faces: in the pilot a civilian was drawn with a soldier's face while
the caption named the right man. This command writes each character's
description in drawable terms, the features that separate them from the rest
of the cast, their wardrobe states, and the reference sheets
`/visual-development` will produce. The files it writes are what prompts
and reviews check identity against.

## Use When

- The story bible is approved and the cast needs to become drawable.
- A character is added, or a user change alters someone's role, clothing,
  or injuries.
- A review flagged an identity mix-up and the two characters need a clearer
  stated difference before any repair.

## Inputs

- `character` (ID, optional): a single `CHAR_*` to build or rebuild; default
  is every character in the story bible.
- `detail` (enum, optional, default by `role`): `principal` (full sheet
  plan) | `supporting` (a turnaround and one wardrobe state) |
  `background` (description only).

## Invokes Agents

- character-designer
- comic-writer

## Required Skills

- character-consistency
- character-sheet-generation

## Process

1. Collect each character's facts from `production/story/story-bible.yaml`
   through `affects`, with their provenance. List what the timeline does to
   them: clothing, injuries, objects carried, event by event.
2. comic-writer writes `personality`, `voice` (how they speak, in a form the
   dialogue can follow), and `arc`.
3. character-designer writes the `description` in terms a drawing can show:
   `summary`, `age`, `build`, `hair`, `face`, `skin`. Then
   `distinguishing_features`, at least one: the features that separate this
   character from every other member of the cast. Write `prompt_summary` as
   one sentence that names them.
4. Compare the cast side by side. Any two characters who share an age band,
   a build, a hair shape, or a clothing silhouette go into each other's
   `visually_adjacent_to`. For each such pair, state the difference in face
   shape, hair, facial hair, build, or silhouette. Where the source is
   silent, change one design until the pair differs in at least two visible
   features, and record the invented detail as an `addition` fact. A name in
   a prompt does not stop one face replacing another.
5. Write `wardrobe.yaml`: one outfit per state with an ID
   (`WARD_<CHARACTER>_<NAME>`), `description`, `layers`, `accessories`,
   `hands` (`bare` | `gloved` | `bandaged`), and `used_in`. Set
   `default_wardrobe` in the character file.
6. Plan the reference sheets by kind: a `turnaround` for every principal,
   `expressions` where the acting needs them, one `wardrobe` sheet per
   outfit beyond the default. A recurring secondary character gets a
   turnaround too, whenever they have to be recognized across panels. List
   the planned sheets in the file's `notes`. `/visual-development` compiles
   each one from this file with `compile-prompts.js --asset <CHAR_ID>
   --sheet <kind>`, and the approved pick is registered as
   `<CHAR_ID>_<TAG>_MASTER_V##` (`CHAR_MARA_TURN_MASTER_V01`, or
   `CHAR_MARA_WARD_OILSKIN_MASTER_V01` for an outfit sheet, which carries
   the outfit name). `references` stays empty until then.
7. Apply pending user changes from the story bible to the description and
   the wardrobe in the same run, and note which registered sheets no longer
   match.
8. Set `status: review`, run `node scripts/validate-workspace.js --root
   production`, then the self-evaluation gates on each character and
   wardrobe file. Report the adjacent pairs and how each is told apart.

## Outputs

- `production/characters/<CHAR_ID>/character.yaml`, validates against
  `schemas/character.schema.json`.
- `production/characters/<CHAR_ID>/wardrobe.yaml`, validates against
  `schemas/wardrobe.schema.json`.
- `production/characters/<CHAR_ID>/refs/`, empty until
  `/visual-development` fills it.

## Notes

- No images are generated here, so the command is free. The sheets are
  produced and cost-gated in `/visual-development`.
- Keep `distinguishing_features` short and visible at panel size. Reviews
  check the `identity` row of every page against this list.
- `visually_adjacent_to` has consequences downstream: when both characters
  are on a page, `/reference-plan` requires both identity sheets and the
  prompt states the difference.
- An approved character file is immutable. A design change is a new version
  of the affected sheets and a `user_change` or `addition` fact in the story
  bible.
- Related: `/story-bible` (before), `/visual-development` (draws the
  sheets), `/reference-plan` (attaches the approved masters).
