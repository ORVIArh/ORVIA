# ORVIA live website source checkpoint

This source is deployed at [orvia.fyi](https://orvia.fyi) as Netlify release `6ae8dd4a5ae59f932d341c83` ([immutable deployment](https://6ae8dd4a5ae59f932d341c83--orvia-7ulo.netlify.app)). The active workflow is the separate replay-only job `orvia-stress-replay-20261102-03`. At the recorded public check, it was running; this checkpoint does not claim that its result had completed or been accepted.

- [Live research](https://orvia.fyi/live/) separates numerical job outcomes, sampled GPU activity, recorded molecular frames and the mainnet record.
- [Contracts](https://orvia.fyi/contracts/) publishes all 256 deployed addresses: one coordinator and 255 report stores using two Solidity implementations. Full inventory verification is dated; current API checks cover the coordinator and recorded diagnostic report separately.
- [Status API](https://orvia.fyi/api/orvia/status) distinguishes current observations, historical records and unavailable data.

## Playback and status corrections

Completed and failed jobs retain their outcome and ended time. An old terminal event no longer becomes an unexplained stale heartbeat warning. Running work still requires fresh telemetry. Actual whole-device GPU measurements have an independent 45-second freshness limit and do not establish Runpod allocation or scientific correctness.

Playback displays Playing, Paused or Finished with the exact frame and recorded time. Short clips disclose their duration and maximum atom displacement and initially focus on the ligand. The new Reset view button restores atom visibility and camera framing; hiding every atom displays an explicit explanation. Back-forward navigation retains reusable graphics, and a restored graphics context redraws the recorded frame. Changed script URLs contain source hashes so the new viewer has distinct asset identities. No molecular coordinates, displacement scales or timing data are invented or amplified.

## Diagnostic workflows

The original bounded stress job `orvia-stress-20261102-02` requested 400,000 aggregate steps. Its public terminal event reports **failed**, with **338,800 / 400,000** reported steps, and the returned result records a bounded timeout. All four baseline numerical checks reported passed (80,000 steps each); the remaining replay work was incomplete. This source checkpoint does not reinterpret that as a completed full run or scientific acceptance. It did publish two representative 101-frame trajectories spanning **0–8,000 fs**, which remain separate from the terminal job outcome.

The preceding `orvia-live-20261102-01` diagnostic published two 101-frame trajectories spanning 0–100 fs. The viewer labels previous-job records and retains the user's selected trajectory when new records arrive. A fresh page initially selects the current complex when one is available; otherwise it selects the newest recorded job’s complex. This brings the 8 ps frames forward while the replay-only job runs.

The configured current job uses the replay-only profile `orvia-stress-replay-20261102-03`, counting **80,000 new replay steps**, not the original baseline work. It cannot upload new trajectory frames. An explicit read-only history allowlist can preserve both earlier jobs' trajectories. The previous job’s terminal and trajectory uploads were present before the replay configuration was activated. At 2026-11-02T18:58:37.213968+00:00, the public API reported the replay running at 5,800 / 80,000 new steps; that timestamped observation is not a final result.

The active ADP/phosphate experiment remains diagnostic. Numerical completion, operator signatures and visualized coordinates do not establish scientific acceptance, production sampling or a binding-affinity result. New GPU artifacts are not automatically signed onto the chain.

The recorded public check returned HTTP 200 for the dashboard, its two JavaScript bundles, the contracts page and the status API. The checked static responses matched this source byte for byte; the chain check and recorded report matched, all 256 addresses remained listed, and all four earlier trajectory records remained available as history.

## Archive and verification

`orvia-site-source.zip` contains the `orvia-site/` tree, this note and the source manifest. `source-manifest.json` records every included source file's exact size and SHA-256. `SHA256SUMS` verifies the archive and accompanying checkpoint files.

The explicit allowlist is `dist/`, `src/`, `server/`, `test/`, `netlify/`, `package.json`, `package-lock.json`, `netlify.toml` and the site `README.md`. Local output, hosting metadata, dependency installs, Git data, private files, credentials and environment files are excluded. No application code was changed by packaging.

This is a focused source snapshot, not the whole design workspace. References in the site README to older quality audits, art prompts or local hosting metadata refer to files outside the archive. Asset licenses remain in `dist/assets/`. Public source publication is not a claim of explorer source verification.

After extraction, serve `orvia-site/dist/` for the static experience. See `orvia-site/server/README.md` for the API configuration contract; secret values are provisioned separately. Run `node --test test/*.test.mjs src/trajectory-data.test.mjs` for the included bounded checks. All **36 tests passed** at packaging; these tests do not simulate molecules, sign transactions or spend funds. The public browser has no wallet, GPU provisioning or spending controls.
