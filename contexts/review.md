# Context: Review

The gate context. It applies at any point where work is judged before it
moves on: a bible before approval, a page plan before prompts, a render
before it becomes a reference, an issue before an edition. Review finds
problems and routes them. It does not fix them in place.

## Goals

- A verdict on a stated scope, with evidence a second person could check.
- A findings list where each entry has an owner and goes back to the phase
  that owns the fix.
- Mechanical validation and visual review reported apart, so neither is
  mistaken for the other.

## What to check

Structured data, by script:

- `scripts/validate-workspace.js`: schemas, cross-references, review-file
  rules, edition rules.
- `scripts/check-continuity.js`: the panel ledger (custody, level changes,
  state tags, wardrobe changes, the hands budget, speakers in cast, the
  page chain).

These checks say the files are well formed and agree with each other. They
say nothing about a drawing.

Rendered pages, by eye:

- Open the file. Read the whole page for order, then each panel at a size
  where faces, hands, objects, and lettering can be judged.
- Compare with the references, the ledger, and the neighboring pages. Fill
  every entry under `checks` in the review file, each with evidence that
  describes pixels.
- Record style fidelity and narrative continuity as separate gates.
- Do not infer a correct picture from a correct prompt or caption. If the
  image does not show who acts, write a finding.

Written artifacts (bibles, plans, scripts): the self-evaluation gates from
`rules/common/self-review.md`, which are schema, rules, the producing skill's
quality bar, and an improvement pass.

## Verdict vocabulary

- `pass`: nothing found. On a render this means zero findings and every
  check `pass` or `not_applicable`.
- `fixed`: something was found and repaired, and the corrected output was
  reopened and checked. Each fixed finding carries recheck evidence. A
  successful edit request is not that evidence.
- `flagged`: a blocking finding is still open, a gate failed, or the visible
  evidence is ambiguous.

Identity ambiguity, duplicates, impossible positions, broken causality, and
missing state transitions are blocking, and a blocking finding cannot be
accepted as is. State the scope that was reviewed and list minor issues
that remain.

Human approval is a separate decision. A `pass` or `fixed` verdict makes a
render eligible; `human_approval` on the review, `status: approved` on a
bible or master, and `status: published` on an edition record what a person
decided. No agent sets those on its own judgment.

## Defer

- Fixes. A finding goes to its owner: identity to the character-designer, a
  ledger gap to the continuity-editor, staging to the layout-artist and
  penciller, wording to the comic-writer, a prompt to the prompt-director.
- Further generation once a page has used its repair cycles. The plan or
  the references are corrected first.
- Opinions with no evidence attached. "Continuity was checked" is not a
  review result.

## Typically active

- Commands: `/visual-review`, `/continuity-review`, `/self-review`,
  `/humanize --check`, and the recheck step of `/repair-page`.
- Agents: visual-reviewer for pixels, continuity-editor for the ledger,
  art-director for the style gate, script-editor for fidelity and prose,
  production-qa for the mechanical gates, editor-in-chief to record the
  human's decision. The reviewer of a render is not the agent that
  generated it.
- Rule layers: every layer that governed the artifact, read as a checklist,
  with `common/visual-evidence`, `common/self-review`,
  `common/approval-policy`, and `common/repair-limits` always loaded. Use
  the project's own format layer (`paged/` or `webtoon/`) and ignore the
  other.

## Exit criteria

- Scripts clean, or each failure listed with file, code, and message.
- Every render in scope has a review file whose verdict follows the rules
  above.
- Zero open blocking findings, or the work returns to the owning phase with
  the findings list.
- The report keeps two headings, mechanical validation and visual review,
  and names what could not be verified.
