<p align="center">
  <img src="assets/brand/orvia-banner.png" alt="ORVIA — Open Molecular Research" width="100%">
</p>

<h2 align="center">$ORVIA is live</h2>

<p align="center"><strong>Robinhood mainnet · Token contract</strong></p>

<h3 align="center"><code>0x3e9094546fbfd726d96ef8433835d59415195f9a</code></h3>

<p align="center">
  <a href="https://robinhoodchain.blockscout.com/token/0x3e9094546fbfd726d96ef8433835d59415195f9a"><strong>View token contract</strong></a> &nbsp;·&nbsp;
  <a href="https://orvia.fyi"><strong>orvia.fyi</strong></a>
</p>

---

<h1 align="center">Open science. Inspectable computation.</h1>

<p align="center">
  Molecular research on Robinhood Chain.<br>
  Public inputs, reproducible methods, and evidence you can inspect.
</p>

<p align="center">
  <a href="docs/README.md"><strong>Explore the docs</strong></a> &nbsp;·&nbsp;
  <a href="STATUS.md"><strong>Research status</strong></a> &nbsp;·&nbsp;
  <a href="ROADMAP.md"><strong>Roadmap</strong></a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md"><strong>Contribute</strong></a>
</p>

---

ORVIA stands for **Onchain Research through Verified Inference and Analysis**. We are building toward molecular calculations whose inputs, intermediate state and analysis can be inspected on-chain. The proposed first experiment compares compound 17 with aficamten in a declared cardiac-myosin state.

> **Research in development.** The published **v0.5.1** checkpoint passed **212 Node/EVM tests**, **63 Python references** and **all nine check groups**. These are local component and integration results. A complete prepared-myosin experiment, validated binding-free-energy result and mainnet-ready system remain unfinished. [Read the evidence →](reports/README.md)

## Find your starting point

| You want to… | Start here |
| :--- | :--- |
| Understand the research question | [Experiment protocol](docs/PROTOCOL_ORVIA_001.md) · [Scientific readiness](docs/SCIENTIFIC_READINESS.md) |
| Understand how the system works | [Architecture](docs/ARCHITECTURE.md) · [Engine reference](docs/README.md#engine-reference) |
| Inspect what has been demonstrated | [Checkpoint overview](docs/DEVELOPMENT_CHECKPOINT.md) · [Validation evidence](reports/README.md) |
| See what remains | [Current status](STATUS.md) · [Production gaps](docs/PRODUCTION_GAPS.md) |
| Follow ongoing work | [Research log](RESEARCH_LOG.md) · [Development proposal](https://github.com/ORVIArh/ORVIA/pull/1) |

## From molecular inputs to inspectable evidence

<p align="center">
  <img src="assets/brand/research-flow.svg" alt="Intended workflow: register molecular inputs, compute bounded steps, and inspect state and analysis. The complete production path remains in development." width="100%">
</p>

The intended design uses permissionless, bounded transactions to advance scientific work. Current components cover numerical kernels, molecular forces, alternative dynamics paths and analysis. They do not yet form one validated production experiment; swap and pool triggers are deferred.

| Foundation | What is in this checkpoint |
| :--- | :--- |
| **Numerics** | Binary128-format arithmetic, bounded scalar functions and counter-addressed random streams |
| **Molecular mechanics** | Bond, angle, torsion and nonbonded forces; paged inputs; periodic geometry |
| **Dynamics** | Neighbor-list NVE, Langevin, constrained and Ewald paths; minimization |
| **Analysis** | Alchemical/MC primitives, reduced potentials, MBAR, overlap and time-series diagnostics |
| **Evidence** | Independent references, local deployment rehearsal, gas measurements and limited read-only target-node probes |

[Browse the full component inventory and its limits →](docs/DEVELOPMENT_CHECKPOINT.md#implemented-and-exercised)

## Reproduce the checkpoint

The recorded run used **Node.js 24.22.1** and **Python 3.12.14**. Run from the repository root:

```bash
npm ci
python3.12 -m venv .venv-research
.venv-research/bin/python -m pip install -r requirements-research.txt
ORVIA_RESEARCH_PYTHON=.venv-research/bin/python npm run check
```

The checks use an in-process local EVM and require no wallet or mainnet RPC. The runner regenerates reports for the checked source. See [Contributing](CONTRIBUTING.md) for individual commands and [the evidence guide](reports/README.md) for how to read results.

## Repository map

```text
ORVIA/
├── contracts/       Numerical kernels, state and coordinators
├── data/            Molecular inputs, provenance and manifests
├── reference/       Independent Python calculations
├── test/            Node/EVM checks
├── scripts/         Validation, preparation and packaging tools
├── docs/            Methods, architecture and research decisions
├── reports/         Recorded evidence, reviews and measurements
└── assets/brand/    Repository artwork
```

## Read the results in context

The architecture describes **64 planned production instances**; none is claimed complete or deployed to Robinhood in this checkpoint. Small fixtures do not establish full-system accuracy, physical sampling or computational feasibility. Local gas measurements and read-only numerical probes do not establish production fees or throughput.

[Scientific limits](docs/DEVELOPMENT_CHECKPOINT.md#scientific-and-computational-limits) · [Workload feasibility](docs/WORKLOAD_FEASIBILITY.md) · [Mainnet readiness](docs/MAINNET_READINESS.md)

---

**Attribution** · This product includes software developed by ABDK Consulting. The vendored source retains its [BSD-4-Clause license](contracts/math/vendor/LICENSE.md) and provenance. Scientific-source attribution and redistributed-model terms are recorded in the [source audit](docs/SOURCE_AUDIT.md) and [model provenance](data/source/alternative_models/README.md).
