# ORVIA live website source checkpoint

The public site is [orvia.fyi](https://orvia.fyi). This checkpoint records Netlify production deployment `6ae8d9a0d535b7bea82040ae`: [immutable deployment URL](https://6ae8d9a0d535b7bea82040ae--orvia-7ulo.netlify.app). It includes the stress-workflow integration and the terminal-job status correction.

- [Live research](https://orvia.fyi/live/) separates the current numerical job, sampled GPU activity, recorded molecular frames and mainnet report state.
- [Contracts](https://orvia.fyi/contracts/) publishes all 256 deployed addresses: one coordinator and 255 report stores backed by two Solidity implementations. Full inventory verification is dated; the current API separately checks the coordinator and recorded diagnostic report.
- [Status API](https://orvia.fyi/api/orvia/status) distinguishes current observations, historical records and unavailable data.

At the recorded public check (2026-11-02T18:43:09.025860+00:00), the live dashboard, JavaScript bundles, contracts page and status API returned HTTP 200. The checked static files matched this source snapshot byte for byte. The API confirmed the current mainnet check and first report, listed all 256 contracts, and exposed both earlier trajectories as historical. Both historical artifacts were downloaded and matched their published SHA-256 hashes. The newly configured stress job had not yet sent its first telemetry or device sample at that observation; this checkpoint does not claim the new run completed.

## The stale-warning correction

Completed and failed jobs retain their outcome and ended time after two minutes. They no longer turn into a stale heartbeat warning. Running work still requires fresh telemetry. If the status service becomes unavailable, the page labels its cached information without erasing a previously recorded terminal outcome. Job completion does not imply the Runpod GPU was stopped: allocation is not monitored by this page.

Optional authenticated `nvidia-smi` samples separately show whole-device GPU utilization, memory traffic, VRAM, power, temperature and active worker processes. These samples expire after 45 seconds. They describe the whole GPU, not exclusively ORVIA, and do not prove scientific correctness.

## Current and previous workflows

The new configured job is `orvia-stress-20261102-02`: four parallel replicas with 400,000 aggregate diagnostic steps, including checkpoint replays. Its two representative trajectories each contain 101 actual saved frames spanning 0–8,000 fs, with the runner and input-manifest hashes pinned in the server profile. Source support for this run does not claim that the stress run or its uploads have completed.

The previous `orvia-live-20261102-01` job completed and published two 101-frame trajectories spanning 0–100 fs. The explicit history setting `ORVIA_HISTORICAL_WORKFLOW_IDS=orvia-live-20261102-01` retains read-only access to those artifacts. The viewer labels previous-job frames separately from current-job frames. The history setting cannot authorize writes to an old job or open arbitrary artifact keys.

The active ADP/phosphate model is a separately named diagnostic experiment. Numerical completion, operator signatures and visualized coordinates do not establish scientific acceptance, production sampling or a binding-affinity result. New GPU artifacts are not automatically signed onto the chain.

## Archive and verification

`orvia-site-source.zip` contains the `orvia-site/` source tree, this publication note and a copy of `source-manifest.json`. The manifest records each source file's exact size and SHA-256. `SHA256SUMS` verifies the archive and accompanying checkpoint files.

The explicit source allowlist is `dist/`, `src/`, `server/`, `test/`, `netlify/`, `package.json`, `package-lock.json`, `netlify.toml` and the site `README.md`. It excludes local output, hosting/account metadata, dependency installs, Git data, private files, credentials and environment files. No application source was changed to create this archive.

This is a focused publication snapshot, not the complete design workspace. References in the site README to historical quality audits, art prompts, `.openai` hosting metadata or local outputs refer to files outside the archive. Public source publication does not mean contract source verification on the block explorer.

After extraction, serve `orvia-site/dist/` for the static experience. See `orvia-site/server/README.md` for the API configuration contract; secret values are provisioned separately and are not included. Locked dependencies support rebuilding the Three.js bundles. Run the included tests with `node --test test/*.test.mjs src/trajectory-data.test.mjs`. These checks do not run a simulation, spend funds or use a wallet. The public browser has no GPU provisioning, wallet or spending controls. Third-party asset licenses remain in `dist/assets/`.
