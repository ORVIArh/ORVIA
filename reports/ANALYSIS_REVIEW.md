# Analysis-path engineering review

Reviewed source: `ReducedPotentialCollector`, `MBARFreeEnergyEstimator`, `SamplingDiagnostics` and `UncertaintyAndResults`. This is a parallel engineering and mathematical review, not an independent security audit or validation of molecular sampling. Execution results belong in the analysis test log and full validation summary.

## Resolved finding: repeat-set provenance

The first repeat-summary implementation accepted arbitrary diagnostic-ID arrays after analysis while describing them as predeclared. An unchecked campaign label did not prevent choosing a favorable subset of completed repeats.

The revised implementation registers a plan through its immutable owner before any selected series has samples. Every complex/solvent series must already exist, be empty and unsealed, match its prescribed leg, pair by seed and share the declared protocol, temperature, state count and analysis policy. Repeat seeds are unique within the plan. The plan freezes both complete ordered series lists and their initial configuration digests.

Result creation requires the plan's exact repeat count. Advancement verifies that each diagnostic resolves to the corresponding frozen series. Missing, wrong, reordered or failed repeats cannot yield a completed subset result. The mean and SEM remain partial until every preregistered pair passes. A transaction that processes a valid pair and then fails rolls back all of that transaction's writes. The owner still controls protocol/plan registration; this is reproducible preregistration, not proof that an operator selected unbiased scientific hypotheses.

## Mathematical checks

- The collector subtracts each configuration's reference-state energy before dividing all cross-state energies by kT. A configuration-dependent additive energy constant cancels in MBAR, so this storage gauge preserves relative free energies while retaining the reference energy and original sample digest.
- MBAR uses `log D_n = log sum_k N_k exp(f_k-u_nk)` and `f_i' = -log sum_n exp(-u_ni-log D_n)`, followed by the `f_0=0` gauge. The fixed-point update is consistent with the sampled-state MBAR equations. All states must have at least one sample; unsampled target states are outside this component's declared domain.
- Current and next free-energy arrays are separate. Denominators and updates consume a complete preceding iteration. Convergence triggers a fresh denominator pass using the final free energies before the analysis enters Converged.
- Max-iteration exhaustion is terminal failure, distinct from convergence. Fixed-point residual convergence is not an accuracy, equilibration or overlap certificate.
- With at most 4,096 samples, `u_n0=0`, `|u_nk| <= 32` and `|f_k| <= 64`, denominator log-sums are between 0 and approximately 104.318. Intermediate log-add exponent differences remain inside the scalar exp domain of ±256; the largest conservative relevant magnitude is approximately 200.318. This is a domain-bound check, not a propagated rounding-error proof.
- Diagnostic weights use `W_ni = exp(f_i-u_ni)/D_n`. Weight sums are checked against the frozen normalization tolerance. Effective sample size is `(sum W)^2 / sum W^2`. Overlap is `O_ij = N_j sum_n W_ni W_nj`, with a conservative two-direction threshold for graph edges.
- A numerically converged but disconnected overlap graph is rejected by `assertAccepted`. Weight ESS and connectivity do not establish temporal decorrelation or equilibrium.
- Repeat uncertainty is calculated on the paired differences `kT*(f_last-f_first)_complex - kT*(f_last-f_first)_solvent`. Welford accumulation and `SEM = sqrt(M2/[R*(R-1)])` are the appropriate sample-SEM equations for independent repeat-level differences. Pairing includes within-pair covariance implicitly; this is not the formula for two assumed-independent leg means.

## Provenance and execution checks

The collector binds a deployed immutable writer and its code hash. External accounts cannot directly append numerical samples. Each sample contains all state energies, sampled-state identity and step; state-specific minimum spacing, finite values and bounded normalized differences are checked before the sample becomes visible. Sealed series cannot be changed and their digest binds original energies and order.

The estimator pins collector, arithmetic and scalar dependencies; diagnostics pin those dependencies and the estimator. Result advancement reaches the same dependency checks transitively through accepted diagnostics and sealed input series. A runtime code change cannot silently continue the accepted analysis. The supplied immutable implementations are the supported model; hashing arbitrary proxy bytecode would not freeze its storage behavior.

The solver and diagnostic cursors fix the numerical order across caller changes and transaction partitions. Each accepted output requires the proper terminal state. Analysis tolerance and diagnostic thresholds are frozen in the collector configuration rather than chosen after observing the output. Constructor/configuration and input commitments distinguish separate numerical implementations and series.

## Remaining acceptance limits

The test writer harness can feed synthetic values for validation and is not a production simulation source. The production dynamics/alchemical engine must become the collector's actual writer and produce every complete cross-state energy record on-chain. A deployed contract address alone does not establish trustworthy energy provenance.

Minimum sample spacing is not a measured correlation time. Weight ESS is not autocorrelation-adjusted effective sample size. Unique seeds do not prove statistically independent or equilibrated repeats. Shared force-field/model bias is not included in repeat SEM. No asymptotic MBAR covariance, confidence interval, molecular convergence proof or clinical effect is claimed by these components. These remain explicit scientific acceptance boundaries for the complete protocol.

The deployment/readiness gate must not treat successful synthetic analysis tests as completion of the prepared myosin model, all alchemical integration stages or full-scale scientific validation.

Equation/reference checks: [Shirts and Chodera, JCP 2008](https://pmc.ncbi.nlm.nih.gov/articles/PMC2671659/) and the maintainers' [PyMBAR weight/overlap/ESS documentation](https://pymbar.readthedocs.io/en/latest/mbar.html), accessed 2026-11-02. Exponent-domain bounds and code/provenance conclusions above are this review's direct analysis of the implementation. They are not external certifications.
