# Bounded on-chain time-series diagnostics

`TimeSeriesDiagnostics` computes a single observable's mean, variance, lagged autocovariances and a finite-window initial-positive/initial-monotone estimate of statistical inefficiency. Inputs and calculations are stored and executed on-chain. This is a diagnostic component, not a proof of stationarity, adequate molecular sampling, replica independence or a valid force field. It is not a multichain R-hat or Stan's full multichain ESS implementation.

The estimator follows the adjacent-pair construction in C. J. Geyer, *Practical Markov Chain Monte Carlo*, Statistical Science **7**(4), 473–483 (1992), [doi:10.1214/ss/1177011137](https://doi.org/10.1214/ss/1177011137). See the author's [initial-sequence documentation](https://www.stat.umn.edu/geyer/mcmc/library/mcmc/html/initseq.html) and the [Stan explanation of positive and monotone paired autocorrelations](https://mc-stan.org/docs/2_38/reference-manual/analysis.html). The underlying sequence properties presume a stationary reversible chain. The contract does not test or establish those assumptions.

## Frozen input plan and provenance

The constructor takes `(writer, math)`, requires deployed code, and pins both runtime hashes. Only that immutable writer can register, append or seal a series. Its configuration is fixed before any observations:

```text
(protocolHash, runHash, replicaHash, observableHash,
 state, expectedSamples, firstStep, stride, maxLag, minimumSamples)
```

The hashes identify the exact protocol, run, replica and observable definition. A production writer must compute this observable from the named simulation state and enforce the meaning of those identifiers. A caller cannot establish scientific provenance by deploying an arbitrary writer that supplies numbers. `TimeSeriesWriterHarness` is test-only and accepts synthetic observations; it is not a production source.

A series contains 1–4,096 finite binary128 observations of one state/replica/observable. `append(id, firstStep, values)` accepts 1–64 values, all at the declared stride. Its first step must be exactly `registeredFirstStep + currentCount*stride`. Missing, duplicated, reordered and excessive observations revert. Every observation, index and step extends the digest. Registration commits chain ID, contract and series identity, dependency code hashes and the complete configuration. Sealing requires the exact count and is irreversible.

`maxLag` is an odd positive integer smaller than the count, capped at 255; a one-observation series requires zero. Odd maximum lags provide complete adjacent pairs. `minimumSamples` is frozen in the range 4–4,096. It is a declared reporting threshold, not a theorem that that many observations suffice. Values and commitments remain publicly readable. A malformed later value rolls back the whole append transaction.

## Resumable calculation

Anyone may call `advance(id, workLimit)` after sealing, for 1–32 work units. All arithmetic uses the pinned `FloatMath` dependency; unsupported numerical arithmetic reverts without corrupting earlier checkpoints. The calculation always follows the same operation order, regardless of transaction partitioning.

| Stage | One work unit | Stored result |
|---|---|---|
| Mean | One observation in sequential Welford updates | Mean and centered sum of squares M2 |
| Covariance | One product at one lag | Fixed-order lag sums |
| Sequence | One adjacent autocovariance pair | Positive monotone pair sum |
| Completed | No further work accepted | Immutable result digest and flags |

The streaming Welford algorithm runs over the sealed values. Population variance is `gamma_0 = M2/N`; the descriptive sample variance is `M2/(N-1)` for N > 1. It is not a correlation-corrected estimator of uncertainty in the mean. For each registered lag:

```text
gamma_t = (1/N) * sum_{i=0}^{N-t-1} (x_i-mean)*(x_{i+t}-mean)
Gamma_p = gamma_{2p} + gamma_{2p+1}
```

This uses biased autocovariances with the common denominator N, not N-t. The first nonpositive `Gamma_p` terminates the retained window. Positive retained pairs are replaced by their running minimum. Then:

```text
g = max(1, -1 + 2*sum(retained monotone Gamma_p)/gamma_0)
effectiveSamples = N/g
```

The explicit clamp `g >= 1` conservatively prevents an effective count greater than N for anticorrelated data. This is a declared choice, not a claim that all legitimate estimators must impose that clamp. `usedLag` is the highest lag included in a retained pair. All registered covariance lags are calculated even when an earlier pair will terminate the final estimator.

## Flags and consumer requirements

`summary(id)` returns input/result digests, status/cursors, moments, g, effective count, used lag and four flags:

| Flag | Meaning |
|---|---|
| `constantSeries` | All stored observations are numerically equal; correlation is undefined |
| `shortSeries` | N is below the frozen minimumSamples |
| `truncated` | Every available adjacent pair stayed positive, so the registered lag window ended before the stopping criterion |
| `validEstimate` | Calculation is complete and none of those three flags is set |

For a constant series, g and effectiveSamples are **zero sentinels meaning undefined**. They must not be interpreted as zero correlation or zero true information. Its covariances are zero. A nonconstant series whose positive variance underflows to zero fails arithmetic instead of being mislabeled constant. A one-observation series is both constant and short.

A truncated or short nonconstant series exposes its computed finite-window g for inspection, while `validEstimate` remains false. Absence of the flags means only that the declared computational checks passed. It does not establish equilibrium, sufficient trajectory length or reliability of this estimate. A finite-sample negative pair may prematurely terminate an otherwise long correlation tail.

Consumers must check `assertCompleted(id)` and the returned validity flag; it also verifies dependency hashes. Reading partial `summary` fields alone is not acceptance. Completed output cannot be changed. The result digest binds the sealed input digest, mean, population variance, g, effective count, used lag and diagnostic flags.

## Relation to MBAR

The free-energy collector's frozen stride remains only a selection rule. This module can provide observable-specific correlation evidence, but no production integration yet derives a validated sampling/subsampling plan from it or binds that decision into MBAR acceptance. Correlation can differ between observables and thermodynamic states; one favorable series does not establish independence of all reduced-potential samples.

**Do not divide MBAR weight ESS by this g and label the result MBAR covariance or reliable free-energy uncertainty.** `SamplingDiagnostics` measures weight concentration and overlap. `UncertaintyAndResults` reports variation across a complete preregistered repeat set. Neither becomes a general correlated-sample MBAR uncertainty estimator through this component. Burn-in selection, multiple observables, correlation-aware sampling and the scientific interpretation remain separate requirements.

## Validation

`reference/generate_timeseries_reference.py` uses independent 80-digit two-pass centered moments and direct autocovariance sums, followed by a list-based paired window. It avoids the contract's Welford update and resumable state machine. The stored fixture has 16 synthetic observations and maximum lag 7. Tests compare mean, both variances, all eight autocovariances, g and effective count at absolute-plus-relative tolerance `1e-27 + 1e-27*abs(reference)`.

Python tests verify the fixture, shift/scale invariance, constant/short/truncation handling, anticorrelation clamping and an independently generated AR(1) sanity series with coefficient 0.5. Its theoretical asymptotic g is 3; the finite deterministic-seed realization is checked against a broad 2.4–3.6 range. This reference sanity check does not assert finite-sample unbiasedness.

EVM tests cover writer authorization, exact chronology, atomic rejection, invalid plans, moment/reference agreement, bitwise partition invariance, independent input/result digest reconstruction, immutable completion, constant/short/truncated/anticorrelated series, nonconstant variance underflow and changed dependency code. Reports record only completed local tests and actual advancement gas for the synthetic fixture, excluding deployment and collection. They are not a molecular trajectory validation or Robinhood fee estimate.
