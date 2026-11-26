# Visual evidence

## Purpose

Separate what a tool reports from what a page shows. A generation call that
returns without error has produced a file. Whether the right person is in
panel three, holding the right object, standing where the plan put them, can
only be learned by opening that file and looking.

## Scope

All layers. Applies to every render and every piece of reference art, to the
reviews written about them, and to every report an agent makes to the user
about the state of a page, an issue, or an edition.

## Core Principles

- A successful tool call means an image exists. It says nothing about what is
  in the image.
- The returned file is opened and inspected before anything else happens to
  it: before a verdict, before it is used as a continuity reference, before
  it is described to the user.
- Evidence describes pixels. A statement about a render is a statement about
  what is visible in it, in a named panel of a named version.
- A correct prompt does not make a correct picture, and neither does a
  correct caption.
- Tests and schema checks verify structured data and tooling. They NEVER
  certify identity, anatomy, geography, or comic continuity.

## Inspecting a render

- Read the whole page first, in reading order, as a reader would. Then go
  panel by panel at a size where faces, hands, objects, and lettering can be
  judged. A check made at thumbnail size counts as not made.
- Compare each character with the assigned identity reference, and each panel
  with the panels before and after it. Review pages together at page
  boundaries.
- Count each named identity separately within every panel.
- Judge asymmetric details on the actual region and name sides anatomically
  ("her left cuff", "his left hand"), never by where they fall in the frame.
  In a profile or three-quarter view, work out which side is visible before
  judging. Mirror confusion is the most common audit error.
- List what the pixels were compared against in `compared_against`: the
  reference assets and the neighbouring renders that were open at the time.

## Recording evidence

- Each of the fourteen check keys in the review (`identity`, `cast_count`,
  `position`, `movement`, `role_causality`, `object_identity`,
  `object_custody`, `physical_state`, `wardrobe`, `spatial_logic`,
  `drawing_clarity`, `lettering`, `page_structure`, `style_fidelity`) gets a
  result and a line of evidence.
- Evidence names what was seen and where: "Torn left cuff present in panels
  1, 2, and 4". Evidence that repeats the plan ("as specified"), the prompt,
  or a general assurance ("continuity checked") is void.
- `not_applicable` is a result with evidence too: say what the page lacks
  that makes the check empty, such as "no props on this page".
- A finding states what canon or the plan expected, what is visible instead,
  its severity, and the smallest useful repair. It MAY mark the area it is
  about with `region` (`x`, `y`, `w`, `h` in fractions of the page).
- A finding carries its `source`. `reviewer`, the default, means the review
  found it in the pixels. `user_request` means a person asked for the
  change; such a finding quotes the request in `repair`, may leave `check`
  out, and keeps the review `flagged` while it is open
  (`scripts/lib/review-requests.js` writes it).
- `not_performed` is the result of a check nobody has judged. Only a review
  opened by a change request on a render without a review records it, for
  its checks and its two gates. A reviewer NEVER uses it to skip a check,
  and a review that holds one cannot be `pass` or `fixed`.
- A finding marked `fixed` carries a `recheck` that names the corrected
  render and what is now visible there. A repair request that returned
  without error is not evidence of a repair (`repair-limits.md`).

## Identity and captions

- If the pixels do not clearly establish who acts, record a finding, even
  when a caption or a balloon supplies the intended name. The reader sees the
  face before reading the name.
- A character drawn with another character's face fails `identity` whatever
  the lettering says. In the sample story: a boy on deck with a long face and
  cropped grey hair is Mara's face on Oskar, and the word "Oskar" in a
  balloon does not repair it.
- Identity ambiguity, duplicated characters, impossible positions, broken
  causality, and missing state transitions the story depends on are blocking.

## Two kinds of result

- Mechanical validation covers what scripts can read: schemas,
  cross-references, the panel ledger, review bookkeeping, edition lists.
- Visual review covers what only the image can tell: who is drawn, where they
  stand, what they hold, whether the hands work, whether the words are right.
- Reports keep the two apart. A report MUST name the commands that ran and
  their result under one heading, and the renders that were opened with their
  verdicts under another. "Validated" or "passes" without saying which kind
  is not acceptable.
- A report states its scope: which renders were reviewed and which were not.
  An unopened render is reported as unreviewed.
- Every review records two gates, `style_fidelity` and
  `narrative_continuity`. A page can match the look and still fail the
  story, or the reverse, and the verdict needs both.

## Validation

- `visual-review.schema.json` requires all fourteen checks, each with
  `result` and `evidence`, plus `compared_against`, both gates, and a
  verdict.
- `scripts/validate-workspace.js` enforces the review rules: a `pass` has no
  findings, a `fixed` finding has a recheck with evidence, an open blocking
  finding or a failed gate forces `flagged`. So does an open change request
  from a person, and so does a check or gate left `not_performed`. A
  `region` that reaches past the page is an error.
- Those checks confirm that evidence was written. Whether it describes the
  pixels is visual review: a reviewer who did not generate the image
  (`independent: true`) or a person opens the same file and reads the
  evidence against it.
- Passing `npm test`, `npm run validate`, `scripts/validate-workspace.js`, or
  `scripts/check-continuity.js` is never reported as a page having passed
  review.
