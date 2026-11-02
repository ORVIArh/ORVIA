# On-chain free-energy analysis components

These contracts implement a general sampled-state MBAR solve, weight diagnostics, and a preregistered paired-repeat summary. They execute their arithmetic in contracts. They are not evidence that molecular sampling, equilibration, temporal decorrelation, the alchemical endpoints or the intended cardiac-myosin model are valid. The current integration fixture uses synthetic energies supplied by a **test-only** writer harness; a production simulation writer remains a separate integration requirement.

The mathematical reference is Shirts and Chodera, *Statistically optimal analysis of samples from multiple equilibrium states*, J. Chem. Phys. **129**, 124105 (2008), [doi:10.1063/1.2978177](https://doi.org/10.1063/1.2978177), [open paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC2671659/). The [PyMBAR documentation](https://pymbar.readthedocs.io/en/latest/mbar.html) describes normalized MBAR weights, weight effective sample numbers, overlap, and the need to account for correlated data. These are equation references; the implementation does not import PyMBAR code or claim its full feature set.

## Collection and preregistration

`ReducedPotentialCollector(writer, math)` requires deployed code at both addresses and pins both code hashes. Only the immutable writer can create series, append samples, or seal. The production writer must itself compute the complete cross-state energies and be registered as an approved executable module. Merely deploying arbitrary writer code does not certify scientific provenance. `AnalysisWriterHarness` is explicitly excluded from production types.

`createSeries(id, Configuration)` takes this tuple:

```text
(protocolHash, runHash, leg, repeatSeed, stateCount, expectedSamples,
 kT, stride, equilibrationEnd,
 mbarTolerance, overlapThreshold, minimumESS, normalizationTolerance)
```

All hashes/identifiers must be nonzero. Each series supports 2–16 states and at most 4,096 samples. Every state must receive at least one sample; unsampled target states are not implemented. `kT` is positive and expressed in the same energy units as the writer's complete energies. The four analysis-policy fields are frozen before sampling. This prevents another caller from relaxing convergence, overlap, weight-ESS or weight-normalization requirements after viewing results. These declared thresholds still require scientific justification; freezing an unsuitable threshold does not make it sufficient.

`appendSample(id, sampledState, step, energies)` accepts exactly one complete state-energy vector. It computes `(E_k - E_0)/kT` on-chain and stores the centered reduced potentials, original reference energy, source state and step. Subtracting one common energy from every state for a given configuration leaves MBAR unchanged. Centered differences are restricted to the development domain `[-32,32]`; unsupported values revert rather than being clipped. All energies must be finite.

The step must be beyond the frozen equilibration cutoff. Within each source state, steps increase by at least the frozen stride; duplicates and insufficient spacing revert. A stride is only a declared selection rule. It does not estimate autocorrelation or establish statistical independence. The separate `TimeSeriesDiagnostics` component computes bounded single-observable statistical inefficiency with explicit limitations; see [its specification](TIMESERIES_DIAGNOSTICS.md). It does not automatically derive or enforce a decorrelated MBAR sample selection. Production readiness still requires that correlation-analysis/selection integration and its validation.

Sealing requires exactly the declared sample total and positive counts for every state. The collector commits the configuration, dependency identities and every complete sample record in order. Sealing is irreversible. Failed writes roll back all words, counts, timestamps and digests in the transaction.

## General MBAR solver

`MBARFreeEnergyEstimator(collector, math, scalar)` verifies and pins the numerical dependency chain. `createAnalysis(seriesId, tolerance, maxIterations)` requires a sealed series; tolerance must match its frozen value. The computational iteration budget is 1–10,000. Anyone may advance a registered analysis with `advanceAnalysis(id, workLimit)`, where the work limit is 1–32.

For sample n, source-state counts N_j, reduced potentials u_jn and the current dimensionless free energies f_j, the solver evaluates

```text
log D_n = log sum_j N_j exp(f_j - u_jn)
f_new,k = -log sum_n exp(-u_kn - log D_n)
f_new,k <- f_new,k - f_new,0
```

It uses pairwise log-sum-exp, an explicit `f_0=0` gauge, and fixed summation order. It never accepts submitted free-energy values. The scalar library enforces its documented exp/ln domain; there is no silent exponential clipping. Normalized free energies are additionally bounded to `[-64,64]`. Combined with the centered input and count bounds, this keeps supported log-sum-exp exponent differences within the scalar exp range.

| Status | Meaning | One work unit |
|---|---|---|
| Missing | Invalid analysis | None |
| Denominators | Compute current log denominators | One sample/state cell |
| Update | Compute the self-consistent update | One state/sample cell |
| Normalize | Set the gauge and measure maximum absolute change | One state |
| FinalDenominators | Refresh denominators using the accepted final f | One sample/state cell |
| Converged | Solver reached declared tolerance; immutable output | None |
| MaxIterations | Budget exhausted without convergence | None |

A work unit does not mean a fixed gas cost. Initialization computes up to 16 log counts; all matrix passes are resumed by scalar cell. After normalization, the stopping residual is `max_k abs(f_new,k-f_old,k)`. Meeting it triggers a complete final denominator pass, so diagnostic weights use the same final f as their denominators. Max-iteration failure cannot create an accepted diagnostic. A small fixed-point residual is not by itself a reliable free-energy error bound, particularly with poor overlap.

`runInfo` exposes status, cursors, iteration counts, tolerance and residual. `fAt` can expose intermediate values, so consumers must check `assertConverged`; this checks dependency identities and sealed sample commitments. `logDenominatorAt` is available only after convergence. Different transaction schedules preserve the fixed operation order and final bytes.

The core configuration hash binds the collector/math/scalar addresses and their runtime hashes. An analysis commitment binds chain, estimator address, analysis ID, sealed series ID/digest, that configuration hash, tolerance and iteration budget. The test independently reconstructs the full commitment.

## Weight diagnostics

`SamplingDiagnostics(estimator)` uses the estimator's verified dependencies. `createDiagnostic(analysisId, edgeThreshold, minimumESS, normalizationTolerance)` requires a converged analysis and exact equality with the frozen series policy. `advanceDiagnostic` supports 1–32 work units.

For each sample/state it computes

```text
W_ni = exp(f_i - u_in - log D_n)
ESS_i = (sum_n W_ni)^2 / sum_n W_ni^2
O_ij = N_j * sum_n W_ni W_nj
```

Weights and their sums/squares are accumulated first. Each overlap cell is then accumulated sample by sample in fixed order. At exact convergence the weight columns normalize to one and the overlap rows sum to one. ESS is a measure of weight concentration. It is not a number of temporally independent samples.

An undirected edge between i and j requires **both** O_ij and O_ji to meet the frozen threshold. Bounded bitset reachability checks whether all sampled states connect. This is a declared threshold graph diagnostic, not PyMBAR's eigenvalue overlap scalar or a rigorous convergence test. The final state separately exposes weight normalization, minimum-ESS and connectivity flags. `assertAccepted` requires all three, but that name refers only to these declared diagnostic checks. It does not certify equilibrium, adequate conformational exploration, lack of bias or clinical validity.

The summary stage processes one state, with at most 16 overlap comparisons; final connectivity involves at most 16×16 integer-bitset steps. No unbounded matrix operation is hidden in a single advancement. Singular/invalid arithmetic reverts the current transaction and preserves earlier checkpoints.

## Complete repeat plans and uncertainty

`UncertaintyAndResults(diagnostics, owner)` requires the operator to call `registerPlan(planId, campaignHash, complexSeries[], solventSeries[])` **before any listed series contains a sample**. There must be 3–32 paired repeats. Each campaign hash has one immutable plan. Each pair must have matching protocol hash, state count, kT, frozen analysis policy and repeat seed; paired leg identities must be `keccak256("ORVIA.COMPLEX.v1")` and `keccak256("ORVIA.SOLVENT.v1")`. Seeds are unique across repeat pairs. The complete ordered series lists and their initial commitments are bound by the plan.

This prevents post-hoc omission of a failed or inconvenient repeat within the registered campaign. It does not prove that distinct seeds produced independent trajectories, or prevent an operator from reporting only selected, separately registered campaigns; complete public reporting remains part of the scientific protocol.

After analyses exist, `createResult(planId, complexDiagnosticIds[], solventDiagnosticIds[])` requires exactly the plan's full sizes. `advanceResult(id, workLimit)` handles at most eight paired repeats per transaction, verifies each diagnostic resolves to the corresponding preregistered series and requires its diagnostic acceptance. Missing, nonconverged or rejected repeats prevent completion. They are not dropped, reweighted or silently replaced. Their underlying estimator/diagnostic state remains readable; the result does not present a subset SEM.

For repeat r it computes in energy units

```text
x_r = kT * [(f_complex,last - f_complex,0) - (f_solvent,last - f_solvent,0)]
mean = sum_r x_r / R
SEM = sqrt(sum_r (x_r - mean)^2 / (R*(R-1)))
```

Mean and centered sum of squares use sequential Welford updates. The sign matches ORVIA-001: negative favors endpoint B under the declared model. The SEM estimates variation of the mean across independent repeat-pair estimates. It is **not** MBAR's asymptotic covariance, an automatically valid confidence interval, or uncertainty in a biased model. Shared bias and insufficient sampling can produce misleadingly small repeat variation. All original series and their underlying samples remain accessible.

A transaction that processes a valid first repeat and encounters a wrong-series diagnostic later reverts the entire batch, including the first repeat's accumulator and commitment update. Completed results cannot be resumed or modified.

## Validation and limits

`reference/generate_mbar_reference.py` independently solves normalized MBAR weight equations with 90-digit Newton root finding; the contracts use fixed-point iteration. The three-state fixture has unequal sampled-state counts, six synthetic configurations and nonconstant cross-state energy differences. Reference tests cover exact constant offsets, per-configuration energy-gauge invariance, overlap row normalization, weight ESS, disconnected states and the paired-repeat SEM formula.

`test/analysis.test.mjs` checks sealed writer-only collection, numerical domains and rollback, all MBAR/weight outputs against that reference, bitwise partition invariance, gauge invariance, max-iteration failure, converged-but-disconnected data, independent commitment reconstruction, frozen policies, preregistered complete repeat plans, mean/SEM, wrong-series rollback and changed-code rejection. Reports contain actual completed validation outcomes and local advancement gas. They are not a protein free-energy result or a Robinhood fee quote.

Current limitations include the finite matrix and reduced-potential domains, all-states-sampled requirement, fixed-point convergence speed, lack of integrated temporal correlation correction/selection and lack of MBAR asymptotic covariance. Full simulation-to-collector production integration, physical endpoint validation, sampling diagnostics and scientific review remain required before claiming the intended molecular calculation is ready.
