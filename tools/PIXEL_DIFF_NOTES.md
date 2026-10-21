# Pixel-diff gate — working notes

Status: **tooling written and working, threshold NOT yet calibrated.** Do not
open the PR until step 1 below is measured and the threshold is set from that
measurement.

Branch: `feature/pixel-diff-gate` (fork: `zwmaupin/The-Ninth-Vigil`).

## What is built

| file | what it does |
|---|---|
| `tools/frame-metrics.mjs` | The metric definitions and the thresholds, extracted from `sheet.mjs` so the two tools cannot drift apart. `sheet.mjs` now imports it; output verified byte-identical to the previous analyzer (boss colors=532, closeup=158, overworld=370). |
| `tools/diff.mjs` | Captures a scenario, compares it to the committed baseline in `shots/`, writes a diff PNG, reports which metrics moved and which crossed out of range. |
| `tools/sheet.mjs --check` | Makes the existing analyzer exit non-zero when a frame is out of range, so it can gate a build. `--analyze` is unchanged. |
| `.github/workflows/ci.yml` | A `pixel-diff` job, with the diff images uploaded as an artifact. |
| `package.json` | `npm run diff`, `npm run sheet:check`. |
| `CONTRIBUTING.md` | The automated version of "prove it in pixels", under "Proving a visual change". |

## Step 1 — measure the re-capture drift (REQUIRED before the PR)

The threshold has to come from a measurement, not a guess. The floor is: how
much does the frame move when the SAME build is captured again?

```
node tools/diff.mjs --scenario=closeup --w=1600 --h=900
```

That captures `closeup` at its authored **60** frames (the per-scenario table
in `diff.mjs` matches `shot.mjs` — see the trap below) and compares it to the
committed baseline. Record the reported percentage.

Then repeat under software rendering, because **that** is what CI runs:

```
node tools/diff.mjs --scenario=closeup --w=640 --h=360 --frames=45 --software
```

The SwiftShader number will be larger than the hardware one. **The CI
threshold must be set from the SwiftShader number**, or CI will be red on an
unchanged build.

## Step 2 — prove the gate can fail

Move something small and visible — nudge a light, move a prop — and confirm
the gate catches it and writes a diff PNG that shows where. A gate that
cannot fail is not a gate, and the whole point of this change is that the
repo's objective function should be able to fail.

## Step 3 — set the threshold, then open the PR

Set it from step 1, with headroom, and document the number and where it came
from in the PR body. Then update the CI job's `--threshold` to match.

## Traps hit while building this

**The frame count is part of the definition of the frame.** `closeup` is
authored at 60 frames, `combat` at 180, `boss` at 240 — the table lives in
`shot.mjs`. Capturing `closeup` at 120 instead put the simulation in a
different moment (torches advanced, cloth settled further) and reported
**51 % of pixels changed** on an unchanged build. A diff that reports a huge
number on a build nobody touched is almost always comparing two different
moments, not a broken render. `diff.mjs` now has the same table.

**Do not return raw RGBA over the CDP bridge.** A 1600x900 frame is 5.76 MB
of numbers, and serialising that back to Node is slow enough to look like a
hang. It hung twice. Everything now happens inside the page and only the
results come back; the diff PNG is encoded in the page and sent as base64.

**`page.evaluate` takes ONE argument, and it must be an object.** Two
positional arguments throw `Too many arguments`.

**A stale Vite server serves stale modules.** If the page times out waiting
for `window.__NONA__.ready`, kill whatever is listening on the port and
`rm -rf node_modules/.vite` before retrying — otherwise the next attempt
fails the same way.

**The `stdin is not a tty` message.** The harness wrapper injects it into
background runs and the process exits 1. Pipe through a shell script with
`< /dev/null` and redirect to a log file instead of running the tool
directly in the background.

## What the diff PNG looks like

Unchanged pixels are dimmed to a grey ghost. Changed pixels are lit: **red
where the candidate is brighter, blue where it is darker**. So the image shows
the *direction* of a change, not just that one happened — which is the thing a
hash would have thrown away.
