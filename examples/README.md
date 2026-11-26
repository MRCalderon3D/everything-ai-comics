# examples/

Sample workspaces. Each one is a full `production/`-style workspace under
another name: a directory with a `project.yaml` at its root, which is all the
scripts need to find it.

| Example | What it is |
|---|---|
| [the-night-ferry/](the-night-ferry/) | A two-page noir one-shot. One issue, one scene, eight panels, two characters, two props, and a page that failed review once and was repaired. |

The repository tests run against these workspaces, so they have to pass every
mechanical gate: schema validation, cross-references, the panel ledger audit,
and the review and edition rules. If you change a file here, run the checks
again:

```bash
node scripts/validate-workspace.js --root examples/the-night-ferry
node scripts/check-continuity.js --root examples/the-night-ferry
```

## About the images

The PNG files in an example are flat placeholders. They exist so that paths
resolve and the scripts have files to read, copy, and pack. They are not
comic pages and they are not reference art.

The review files are written as if real pages had been inspected, to show
what evidence looks like. Read them for their form. Nothing in this directory
is a claim about the quality of any generated image.

## Use an example as a starting point

Copy the directory, rename it, and replace its contents from the top down:
source text, story bible, characters and locations, then issues and pages.
For an empty workspace use `node scripts/create-project.js --title "<title>"`.
