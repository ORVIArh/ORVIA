# Actual local 256-contract prototype

The local connected fixture deploys **256 distinct contract addresses**: 32 core contracts and 224 fixed storage banks. Of the core contracts, 31 participate in the connected simulation/analysis architecture; the 32nd is a separately exercised raw C4 pair primitive. This is a tested local prototype. It is **not mainnet ready**, a completed large molecular simulation, an accepted alchemical C4 model, or scientific production approval.

The fixed pools are 96 input banks, 64 pipeline working-state banks and 64 Hamiltonian output banks. Their catalog/router addresses count among the 32 core contracts. Streams, namespaces, retained snapshots, cell indexes, traversals and runs do not create additional contracts. Repeated bank runtime code provides actual storage capacity; implementation uniqueness is not implied by address uniqueness.

| Core role | Addresses |
| --- | ---: |
| FloatMath, ScalarMath, ElementaryMath | 3 |
| CounterRandom and LangevinBAOABKernel | 2 |
| ExperimentRegistry and OrthorhombicGeometry | 2 |
| Harmonic bond/angle, periodic torsion, ordinary LJ, softcore LJ | 5 |
| Ewald real-space, reciprocal and corrections | 3 |
| BankedInputCatalog and AlchemicalTopologyCatalog | 2 |
| MolecularSimulationPipeline and its BankedWorkingState router | 2 |
| AlchemicalHamiltonianEvaluator and its BankedWorkingState router | 2 |
| ReducedPotentialCollector, TimeSeriesDiagnostics, MBAR estimator | 3 |
| SamplingDiagnostics and UncertaintyAndResults | 2 |
| DistanceConstraintKernel, FullModelConstraintCatalog, FullModelConstraintSolver | 3 |
| PeriodicCellIndex and OrderedNeighborPairs | 2 |
| Raw standalone C4PairKernel | 1 |
| **Core total** | **32** |

The pipeline's owner-only `bindSpatial(index,pairs)` forwards to the Hamiltonian's one-time binder. `campaignCount` freezes that choice before the first campaign is registered, including when no window has started. Each campaign commitment binds the Hamiltonian's spatial policy ID, module addresses and captured runtime hashes. The optional acceleration and guarded fallback behavior are described in [SPATIAL_HAMILTONIAN.md](SPATIAL_HAMILTONIAN.md).

[complete_256_validation.json](../reports/complete_256_validation.json) preserves the original complete local run unchanged. It passed in 302 seconds with no skips. That run checked:

- All 256 addresses are distinct and every bank's recorded runtime hash matches its deployed code; factory nonces remain 97/65/65 after molecular work.
- Wrong owner/modules, direct EOA binding of the Hamiltonian, rebinding, and binding after campaign creation but before any run are rejected. An independent ABI calculation reproduces the exact spatial-bound campaign commitment.
- Three complex/solvent repeat pairs are preregistered before any trajectory or selected sample series exists. One campaign subsequently completes its two windows and eight authenticated cross-state samples.
- A separate two-atom constrained campaign performs a real SHAKE/RATTLE step, records a sample through three spatial Hamiltonian evaluations, retains its initial checkpoint, and records a nonzero constraint transcript.
- The two completed windows satisfy the declared chronology rule, with estimated `g` values about 1.50384 and 1.50081. Registered thinning, selected sample collection, MBAR convergence and overlap/ESS diagnostics complete. Identical endpoint parameters produce zero estimated free-energy difference in this wiring fixture.
- Raw C4 evaluates a nonzero known case (`r=2`, `C4=8`: energy `-0.5`, force on A `[1,0,0]`). The production alchemical Hamiltonian does not call this primitive.

The other five preregistered campaigns are not reported as completed repeats. This run does not claim a completed three-repeat uncertainty estimate. The constrained sample check and the two-state analysis campaign are separate small fixtures, rather than a claim that the prepared full system has completed either path.

The exact local deployment inventory is [deployment-runtime-input.json](../evidence/256-contract-creation/deployment-runtime-input.json). It includes creation data, constructor arguments, actual deployed runtime and its hash, and receipt gas for each core contract, plus all bank addresses/hashes and provisioning receipts. The deployment inventory was deliberately written with pending-integration status before the long test; the separate completed validation report binds its exact hash. Local receipt totals were:

| Measured local work | Gas |
| --- | ---: |
| Deploy 32 core contracts | 73,300,040 |
| Provision 224 fixed storage banks | 110,698,124 |
| **Core deployment plus bank provisioning** | **183,998,164** |
| Pipeline advances in the recorded constrained/sample/analysis-window fixture | 289,874,647 |

The last row excludes deployment, input writes, topology/constraint validation, campaign setup and downstream analysis transactions. These totals are measured local work, not a whole prepared-model or campaign quote. The local Shanghai Ganache chain explicitly relaxes the contract-size limit: pipeline and Hamiltonian deployed runtimes are respectively 40,945 and 34,449 bytes. Target-chain creation/execution acceptance and fees require separate evidence.

Replay from the repository root with `node --test test/complete-256.test.mjs`. Fresh replay outputs go under `reports/complete-256/`; the historical report and original runner/fixture/compiler input under `test/fixtures/complete-256/` remain unchanged. [complete_256_packaging.json](../reports/complete_256_packaging.json) separately binds the portable package and records its compact deployment-only verification. The canonical fixture retains its existing option defaults; `full256:true` enables the banked, analysis, constraint, spatial and raw C4 modules together.

Full prepared-model energy/force comparisons, accepted force-field and magnesium/C4 policies, a validated initial constraint manifold, electrostatic convergence, physical ensemble checks and realistic campaign cost/throughput remain required. No mainnet transaction was sent by this fixture.
