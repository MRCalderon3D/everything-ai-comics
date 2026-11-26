---
description: Run the self-evaluation pass on existing artifacts and report or fix what it finds.
---

# /self-review

## Purpose

Apply the `self-evaluation` skill on demand to artifacts that already
exist. Each one is read cold and taken through four gates: its schema, the
rules that govern it, the quality bar of the skill that produced it, and
an improvement pass. New output goes through the same gates when it is
written (`rules/common/self-review.md`). This command covers the rest:
files made before that rule, files edited by hand, and files whose
upstream canon has changed since.

## Use When

- Before submitting work for the user's approval or a `/full-production`
  phase gate, to catch earlier what the gate would catch.
- A bible, a map, or a plan changed upstream and the files derived from it
  may have drifted.
- Imported or hand-edited files entered `production/` without the
  write-time pass.
- You want to know whether an issue's review files are complete before
  `/build-edition`.

## Inputs

- `target` (path or ID, required): one file, a page directory, a page ID
  (`PG_001_002`), or an issue ID (`ISS_001`, the issue's whole artifact
  set).
- `--fix` (flag, optional): apply unambiguous fixes in place. The default
  is a report.
- `--depth` (enum, optional, default `full`): `mechanical` (schema, IDs,
  and cross-references only) | `full` (all four gates).

## Invokes Agents

- production-qa
- editor-in-chief

## Required Skills

- self-evaluation

## Process

1. Resolve the target to a list of artifacts. For each, load its schema,
   the rule layers that govern it (common, domain, and the one format layer
   selected by `comic_format`), and the Quality Bar of the skill that
   produced it.
2. Schema gate. Run `node scripts/validate-workspace.js --root production
   --issue <ISS_ID>` and, when page files are in the set, `node
   scripts/check-continuity.js --root production --issue <ISS_ID>`. Check
   IDs against the naming scheme and that every cross-reference resolves.
3. With `--depth full`, rules gate and quality-bar gate per artifact. Cite
   the specific rule or quality-bar point for every finding. A point
   passes when the file demonstrably meets it.
4. Improvement pass. Name concrete candidate changes and judge each
   against the story and the canon. Clear wins become fixes. Rewording
   that changes no decision, reference, or number is dropped.
5. Review files get a completeness check only: every one of the fourteen
   checks has evidence, every `fixed` finding has a `recheck`, the verdict
   agrees with the findings and gates, and `independent` is set. Whether
   the drawing is right is not judged here; that takes an opened image and
   `/visual-review`.
6. Without `--fix`: report per artifact with a verdict (`pass`, `fixed`
   available, or `flagged`) and the citations, and change nothing.
7. With `--fix`: the agent that owns the artifact applies the unambiguous
   fixes; production-qa never edits. Run the gates once more. A finding
   that needs a person goes where the next reader will see it: the
   artifact's `notes`, the story bible's `open_questions`, or `open_issues`
   in the continuity state.
8. editor-in-chief reads the flagged findings and rules on the ones that
   are an editorial call. Summarize: verdict per artifact, fixes applied,
   flags recorded, and the upstream defects that a downstream fix must not
   hide. State which scripts ran, and keep that line apart from anything
   said about rendered pages.

## Outputs

- A self-review report per artifact: verdict, cited findings, fixes
  applied, flags recorded.
- With `--fix`: the repaired artifacts in place, still valid against their
  schemas, and flags written to `notes`, to `open_questions` in
  `production/story/story-bible.yaml`, or to `open_issues` in
  `production/continuity/<ISS_ID>.final-state.yaml`
  (`schemas/continuity-state.schema.json`).

## Notes

- A clean run here says the files are well formed and follow the rules. It
  says nothing about identity, anatomy, or geography in a render
  (`rules/common/visual-evidence.md`).
- Approved assets are immutable. A finding against an approved master
  becomes a proposal to supersede it (`rules/common/approval-policy.md`),
  never an edit.
- A self-review verdict is not an approval. The move from `review` to
  `approved` is still the user's act.
- Two fix rounds at most per artifact. A failure that survives them is an
  upstream defect and goes to the command that owns the bible or the plan.
- Prose findings belong to `/humanize`. This command checks structure,
  canon, and craft, and points there when the prose itself is the finding.
- This command generates nothing and costs nothing.
