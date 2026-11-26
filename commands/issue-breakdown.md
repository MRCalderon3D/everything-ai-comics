---
description: Break one issue into scenes and beats with cast, geography, and a page budget per beat.
---

# /issue-breakdown

## Purpose

Take one issue from the series plan and prepare it for page planning. The
issue is cut into scenes, each scene into beats, and each beat is given the
pages it can spend. Every scene also gets its cast, its location, and its
geography: which way the characters travel across the page and which side a
threat comes from. Those directions are decided once here, so every page of
the scene agrees on them.

## Use When

- An issue in `production/story/series-plan.yaml` has `status: planning`
  and the bibles it uses are approved.
- The source span of an issue changed, or a user change moved an event.
- Page planning showed that the budget per beat does not work and the split
  has to be redone.

## Inputs

- `issue` (ID, required): the `ISS_###` to break down.
- `page_budget` (int, optional, default the issue's `page_budget` in the
  series plan): total pages to divide among the beats.
- `scene` (ID, optional): rework a single `SC_<issue>_##` and keep the rest.

## Invokes Agents

- editor-in-chief
- comic-writer
- layout-artist

## Required Skills

- narrative-structure
- scene-blocking

## Process

1. Read the issue's entry in the series plan, its `source_span`, the story
   bible, and `comic_format`. If a previous issue exists, read
   `production/continuity/<ISS_ID>.final-state.yaml`: it says where every
   character and prop is when this issue opens.
2. comic-writer cuts the span into scenes. A change of location or a jump
   in time starts a new scene. Write one `scenes/<SC_ID>.yaml` each, with
   `location`, `time_of_day`, `cast`, and a `summary` that says what
   changes in the scene and for whom.
3. Divide each scene into `beats` (`BT_<issue>_<scene>_##`): one beat per
   shift in intention, information, or advantage, each with a one-sentence
   `summary`.
4. Check the cast and the places against the bibles. Every `cast` entry has
   a character file, the location has a `map.yaml`, and each lists the
   masters it needs. Report missing or unapproved items now; they block
   `/reference-plan` later.
5. Stage each scene on the location map. Fix `geography.travel_direction`
   and `geography.threat_direction`, and write in `geography.notes` where
   each group starts (level, side, landmark), where anything enters, and
   which side it holds. If the scene needs a level or a landmark the map
   does not have, stop and send that to `/location-bible`.
6. layout-artist divides the page budget. Give each beat its pages in
   `beats[].pages` as page IDs (`PG_<issue>_###`), by weight: a reveal or a
   transfer of an object needs room, a transit can share a page. Paged
   projects place reveals with the page turn in mind
   (`rules/paged/page-turn-grammar.md`); webtoon projects think in scroll
   distance (`rules/webtoon/scroll-grammar.md`). List the scene's `pages`.
7. editor-in-chief checks the whole: every event of the span lands in a
   beat, the issue has its setup, escalation, and ending, and the page
   total matches the budget or the difference is argued.
8. Write `issue.yaml`: `id`, `number`, `title`, `source_span`, `summary`,
   `scenes`, `page_count`, `status: planning`, and `opens_from` pointing at
   the previous issue's final-state file, or `null`. If `page_count`
   differs from the series plan, update the plan.
9. Run `node scripts/validate-workspace.js --root production --issue
   <ISS_ID>`, then the self-evaluation gates on the issue and scene files.
   Present the breakdown for approval.

## Outputs

- `production/issues/<ISS_ID>/issue.yaml`, validates against
  `schemas/issue.schema.json`.
- `production/issues/<ISS_ID>/scenes/<SC_ID>.yaml`, one per scene; validates
  against `schemas/scene.schema.json`.
- `production/story/series-plan.yaml`, `page_budget` updated when the count
  changed (`schemas/series-plan.schema.json`).

## Notes

- This command costs nothing. It is also the cheapest place to move a beat.
- Geography written here binds every panel of the scene. A patrol launch
  that approaches from the stern approaches from screen right on every
  page, and `/visual-review` checks `spatial_logic` against it.
- No page files are written yet. `/page-plan` or `/smart-page` creates
  them from `beats[].pages`.
- Escalate to the user when the budget cannot hold the beats without
  pushing a handoff, an arrival, or a reveal off the page.
- Related: `/series-plan` (before), `/page-plan` or `/smart-page` (next),
  `/continuity-review` (writes the state the next issue opens from).
