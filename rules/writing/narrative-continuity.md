# Narrative continuity

## Purpose

Keep story facts consistent across pages and issues: what happened, in which
order, who knows it, what caused what. Visual continuity cannot be right when
the narrative record underneath it is wrong.

## Scope

Writing layer. Governs `story/story-bible.yaml`, `story/series-plan.yaml`,
issue and scene summaries, beats, and the panel script in every `page.yaml`.

## Core Principles

- The story bible is the ledger of narrative fact. The pages dramatize it. A
  fact established on a page MUST be in the bible before the next writing
  pass (`common/source-of-truth.md`).
- Event order is explicit. The bible's `timeline` gives every event an
  `order`, and presentation order on the pages is tracked apart from it.
- Cause comes before effect. A panel can depend only on something the reader
  has been shown or can infer from a declared ellipsis.
- Knowledge is state. A character acts only on information an earlier panel
  gave them.

## Story facts

- Established facts (names, ages, relationships, injuries, deaths, who owns
  what) are canon once the page that establishes them is approved.
  Contradicting one requires a deliberate bible revision.
- Every fact in the bible carries its provenance
  (`adaptation-fidelity.md`), and its `affects` list names the entities to
  revisit when it changes.
- `world_rules` hold on every page. In the sample story the ferry runs
  without lights after curfew, so a lit deck in a later issue is either a
  plot event or a mistake.

## Event order and causality

- Each timeline entry SHOULD name the issue in which its event is shown.
  Flashbacks keep their true `order` and are marked in the scene summary and
  with a `scene` transition on the page.
- Scenes and pages follow the order in `issue.yaml` and the `continuity`
  chain in each `page.yaml`. A reordering made for the adaptation is recorded
  as such, with its reason.
- Elapsed time between scenes MUST be plausible for travel, healing, and
  changes of clothes. Wardrobe and physical state on the page derive from
  this (`visual/state-continuity.md`).
- The character who performs an action is one whose earlier state allows it.
  A boy with a cut hand does not haul a mooring line two panels later without
  the script acknowledging the hand.
- A scene's `time_of_day` agrees with the timeline.

## Setups and payoffs

- A payoff needs its setup on an earlier page. When compression cuts the
  setup, the payoff is cut too or the setup is restored.
- A setup that is never paid off is either removed or carried forward on
  purpose. Threads left open at the end of an issue are listed in
  `open_threads` in `continuity/<ISS_ID>.final-state.yaml`.
- The writer records each setup and payoff pair in the beat summaries of the
  scene files, by page ID, so an edit to either page shows what else it
  touches.
- Objects are setups. An object used on page nine is seen, placed, or
  mentioned before page nine.

## Across issues

- An issue after the first names the state it opens from in
  `issue.opens_from`. Its first page starts there: same wounds, same clothes,
  same custody of every object, unless the timeline places a gap between the
  issues and the script accounts for it.
- The series plan gives each issue a `source_span` and a summary. Together
  the spans cover the story without overlap, and an event belongs to one
  issue.
- Open threads from the previous issue are resolved, continued, or dropped by
  a recorded decision.

## Character knowledge and arcs

- Track per character what they know, when they learned it, and from whom. A
  page where a character uses knowledge they were never given fails review.
- Each main character's arc is stated in the bible. Page work that moves a
  character off the arc MUST flag the deviation for the editor-in-chief
  instead of bending the arc quietly.
- A character's goal in a scene follows from their last state on the page,
  wherever the plot would prefer them to be.

## Validation

- `story-bible.schema.json` requires the fact registry with provenance, and a
  timeline entry requires `order` and `event`.
- `scripts/validate-workspace.js` schema-checks the bible, the series plan,
  and the issue and scene files. It checks that issue, scene, and page files
  list each other consistently and that a scene's location and cast exist.
  IDs cited inside the bible and the series plan are not resolved.
- `scripts/check-continuity.js` verifies that each issue's pages form one
  unbroken `enters_from` / `exits_to` chain (`PAGE_CHAIN`) and that state
  tags carry from one appearance to the next (`STATE_DROPPED`).
- The data model has no fields for knowledge, causality, or setup and payoff
  pairs, so no script checks them. The script-editor reviews them at the
  script gate and the editor-in-chief arbitrates arc deviations.
- On the rendered page, the `role_causality` check of the visual review
  confirms that the visible actor is the planned one.
