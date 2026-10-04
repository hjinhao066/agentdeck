# HANDOFF — feat/arch-scifi (终端架构图 科幻化) — WIP

Stopped on 队长's orders (US seat quota). Design note: /Users/jinhao/reports/agentdeck-arch-scifi/DESIGN.md

## Done
- **crew-map-core.js `routes()`**: dispatch is now a bundled tree. One trunk from 队长's bottom centre to a hub,
  then the main bus, then one feeder per project, then a project bus 16px above the project box, then a drop into each card.
  Wrapped-row and review cards still enter from the left gap, as before. A feeder blocked by another project box takes
  the nearest gap beside it (the `gutters` logic). Projects sharing a gap get stepped lanes so they never cross.
  Each dispatch route now carries `project`, `hub`, `feederX` and `branch` (the per-line part drawn in colour);
  `points` is still the full polyline. Added the `spine(routes)` helper (trunk/arms/takeoffs, drawn once) and `tidy(points)`.
- **crew-map.js `drawEdges()`**: layers are returns → reviews → halos (group opacity, so they don't add up)
  → coloured lines (sorted done→working) → pulses → spine → dots. Arrowheads are gone from dispatch lines;
  a socket dot marks each card entry. `fit()` now includes dispatch points (gap routes at the canvas edge).
- **style.css** (the #crewMap block, rewritten): deep-space background with grid, dots and vignette; glass projects
  (blur on ::before, HUD corner ticks on ::after, frosted title strip at z-index 1 above the lines); glass cards with a
  status light on top; a slow scan over working cards; done cards dimmed to 0.66; a muted red for failed;
  captain core halo (box-shadow on ::before, 6s breathe) and a partial ring; capsule badges; mono numbers;
  `prefers-reduced-motion` turns everything off. Light theme has its own tokens.
- **index.html**: the legend's 派出 key now uses the new line + dot.
- **tests/crew-map-core.test.js**: `noSharedStretch` now lets dispatch lines share a stretch only on the trunk/main bus
  or within one project. Two new tests: the bundled tree with lower projects routed round upper ones; `tidy`.
- **tests/e2e/crew-map-scifi.spec.js** (new): single port, no dispatch line crosses a foreign project box,
  done lines thinner than working, glass blur, icon controls ≥32px with labels, reduced motion stops animations.
  Screenshots go to `$ARCH_SCIFI_SHOTS` (env var names must NOT start with AGENTDECK_; the clean wrapper strips those).

## Not verified after the last edits
- Unit tests (23/23 crew-map-core) and the new spec passed **before** these last 3 edits:
  (a) `fit()` includes dispatch points, (b) line saturation 82%→72%, (c) a review session `w14` added to the spec data,
  plus an `expect review count 2`. Re-run both.
- The existing e2e `crew-map.spec.js`, `crew-map-projects.spec.js` and `crew-map-acceptance.spec.js` were **not run**
  (instruction: only unit tests + new spec). The acceptance spec checks fit-in-viewport and project backgroundColor/borderColor
  differing per project (still true: hsl(hue … / 0.035)).

## Next
1. Re-run unit tests + the new spec (commands below), then look at the after shots.
2. Regenerate the **before** shot with the same data. The old `before-dark-1920.png` was deleted because the data changed.
   Use a detached worktree of origin/main (76a20a5), copy the new spec in, and run with `ARCH_SCIFI_BEFORE=1 ARCH_SCIFI_SHOT_PREFIX=before`.
3. Look at review lines and left-side entries in the shot. Possible polish: a red-hued project (yitiaolong) still reads a bit like an alert;
   health's feeder picked the far-left gap (a near tie with the middle gap).
4. Delete this HANDOFF.md, commit, push, and send the complete receipt (branch, commit, tests, screenshot dir).

## Running tests (inside an AgentDeck terminal you must strip AGENTDECK_* in the child process only)
```bash
cat > /tmp/clean.sh <<'X'
#!/bin/bash
for v in $(env | grep -o '^AGENTDECK_[A-Z_]*'); do unset "$v"; done
exec "$@"
X
chmod +x /tmp/clean.sh
/tmp/clean.sh npm test                                  # unit tests
ARCH_SCIFI_SHOTS=/Users/jinhao/reports/agentdeck-arch-scifi /tmp/clean.sh npx playwright test tests/e2e/crew-map-scifi.spec.js --workers=1
```
node_modules is a symlink to ~/agentdeck/node_modules (gitignored). Don't install, restart or touch the live AgentDeck.
