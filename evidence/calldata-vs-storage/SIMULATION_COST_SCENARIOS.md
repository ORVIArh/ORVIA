# Simulation-cost scenarios: full total remains unquoted

**A defensible full simulation price is not available.** The three schedules below count complete proposed campaigns, but only the constraint-solver component can be priced here from current-source recorded measurements. The resulting ETH figures are sensitivity calculations, not full budgets, target-chain quotes, guaranteed minima or maxima, or evidence of a completed simulation.

The previously estimated approximately 0.15 ETH covers an infrastructure allowance and one input pass. It does not cover molecular simulation. Four-way input batching does not remove the repeated numerical work below.

## Schedules

Each illustration uses both available candidate systems, 16 total alchemical states, three independent repeat pairs and 100 raw samples per state: **96 windows**, arranged into six campaigns. Half of each window's steps are allocated to equilibration. These choices, including the illustrative 2 fs timestep, are not accepted scientific settings or a claim of sufficient sampling.

| Scenario | Steps per window, including equilibration | Time per window at 2 fs | Total energy/force evaluations |
|---|---:|---:|---:|
| Short | 1,000 | 2 ps | 240,096 |
| Medium | 100,000 | 0.2 ns | 9,744,096 |
| Long | 1,000,000 | 2 ns | 96,144,096 |

The current pipeline performs one initial evaluation, one per step, and 15 additional state evaluations per raw sample. Therefore the total is `96 × (steps + 1 + 100 × 15)`. The short case still includes 144,000 cross-state evaluations. Sample strides are respectively 5, 500 and 5,000 after equilibration; 1,600 samples per campaign fit the current 4,096-sample limit. Numerical admission does not establish statistical quality.

The available assembled candidate has **132,936 complex atoms with 120,519 constraints**, and **151,506 solvent atoms with 151,179 constraints**. These are the existing ADP/phosphate candidate inputs. They are not an approved replacement for the selected original vanadate protocol. Its complete executable model and scientific acceptance remain unresolved.

## Constraint-work sensitivity in ETH

The current constrained pipeline invokes **two position projections and five velocity projections per timestep**, plus one initial velocity projection per window. Each solver sweep processes a correction pass and a checking pass over every constraint. The number of sweeps needed for the actual model is unknown.

Source-bound local measurements from the current solver are:

- Position fixture: 90,444,524 gas over 156 processed records, or 579,772.59 gas per record. It used 26 sweeps and one record per transaction.
- Velocity fixture: 51,270,178 gas over 174 processed records, or 294,656.20 gas per record. It used 29 sweeps and up to eight records per transaction.

Those are whole local transaction receipts divided by records. Different batching, data, storage locality, scale and future implementation changes alter these rates. They are not a matched comparison between position and velocity kernels.

Using the recorded **0.020258 gwei** RPC gas price at **21:15:19 IST on 2 November 2026**, and holding that price constant throughout the hypothetical campaign:

| Scenario | Constraint work: assume one sweep per projection | Constraint work: repeat the tiny fixture's 26/29 sweep counts | Full simulation total |
|---|---:|---:|---|
| Short | ~1.39 million ETH | ~38.51 million ETH | **Unknown** |
| Medium | ~139.12 million ETH | ~3.85 billion ETH | **Unknown** |
| Long | ~1.39 billion ETH | ~38.51 billion ETH | **Unknown** |

**Neither column is a bound or an expected bill.** One sweep is an optimistic sensitivity, not evidence of convergence. Reusing the tiny fixture's sweep counts is another sensitivity, not a prediction of full-model behavior. The enormous fixed-price extrapolations do not predict available ETH, future fees, throughput, time to completion or a practically executable market purchase.

For `K=16`, `R=3`, `Q=120519+151179`, timestep count `T`, position/velocity sweep assumptions `Ip/Iv` and measured gas-per-record proxies `Gp/Gv`:

`constraint gas = K × R × 2 × Q × [2 × T × Ip × Gp + (1 + 5 × T) × Iv × Gv]`

The outer factor 2 accounts for correction and checking passes. The two physical systems are already included in the sum of their constraints; they are not counted twice again. [simulation-cost-scenarios.json](simulation-cost-scenarios.json) preserves exact rational arithmetic, counts, source hashes and a further 32-sweep sensitivity.

## What prevents a full price

The displayed component excludes all full-scale energy/force evaluations, reciprocal electrostatics, C4, initialization, atom updates, state imports and snapshots, topology/constraint validation, input resupply, sample processing, MBAR, convergence diagnostics and repeat uncertainty. Current-source work counts are recorded, but representative full-model gas rates and iteration counts are missing. Some production fields and required scientific integrations remain unresolved.

These local execution extrapolations also exclude target L1 data-posting charges. [Robinhood's fee documentation](https://docs.robinhood.com/chain/gas-and-fees/) distinguishes execution and data fees and explains that standard target estimates combine them. This calculation did not obtain such estimates for an executable full campaign.

The appropriate conclusion is that **the current implementation has not demonstrated an economically feasible full-scale on-chain simulation**. Input compression and batching alone cannot establish that result. A full price requires a scientifically accepted schedule and representative measurements of every execution phase after integration and optimization.

`simulation-cost-sources.zip` includes the calculator, exact count inputs, recorded current-source solver evidence and price snapshot. Extract under an AURA-shaped root and run `python3 output/simulation-cost-scenarios/calculate.py`. No GPU, network, wallet, or large-model execution is required to reproduce this arithmetic. No public transaction was sent.
