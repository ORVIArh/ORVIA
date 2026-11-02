# ORVIA-001: state-specific cardiac-myosin relative binding free energy

**Status: DRAFT — SCIENTIFIC RUN BLOCKED PENDING INPUT AND METHOD VALIDATION.**

This document specifies the intended scientific calculation and the conditions required before it can be registered for execution. It does not certify that a complete molecular engine, prepared system or validated prediction currently exists.

## Objective and scope

Estimate how changing the oxadiazole 5-substituent from methyl in compound 17 to ethyl in aficamten changes binding to a precisely declared cardiac-myosin state.

Define A = compound 17 and B = aficamten:

\[
\Delta\Delta G_{\mathrm{bind}} = \Delta G_{\mathrm{bind}}(B)-\Delta G_{\mathrm{bind}}(A)
= \Delta G^{A\rightarrow B}_{\mathrm{complex}}-\Delta G^{A\rightarrow B}_{\mathrm{solvent}}.
\]

A negative value favours B under the model and conditions used. This is an estimate of a state-specific binding free-energy difference, not a prediction of clinical efficacy, a complete cardiac contraction cycle, or protein folding from sequence.

The therapeutic research context is cardiac-myosin inhibition for obstructive hypertrophic cardiomyopathy. The first result would validate and characterise an instrument using a published chemical series; it would not constitute discovery of a new medicine.

## Candidate inputs and current evidence

The candidate receptor source is PDB 9F6C. Its version 2.0 mmCIF and PDB files are included with SHA-256 hashes in `data/inputs_audit.json`. It is a **Bos taurus** motor-domain construct in a pre-powerstroke state, crystallised with aficamten, Mg, ADP and vanadate. The asymmetric unit contains two protein copies, but the authors define separate monomeric biological assemblies. The [v0.3 preparation audit](PREPARATION_v0_3.md) selects assembly 1 / chain A as a provisional candidate because it contains more observed residues, while retaining assembly 2 for sensitivity review. The final prepared model remains unresolved.

Aficamten's CCD component is `6I6`; its downloaded descriptor record is included. The source structure has no hydrogen atom rows. Both protein chains have unresolved residues, and each has modified lysines at positions 129 and 549. These are preparation decisions, not details to discard silently.

The candidate compound pair comes from Chuang et al. 2021. The authors' supplementary CSV now supplies verified machine-readable identities for both compounds; an independent graph check confirms the methyl-to-ethyl edit, R stereochemistry and aficamten's match to CCD 6I6. See [the v0.2 identity audit](INPUT_DECISIONS_v0_2.md) and `data/pair_identity_audit.json`.

The functional cardiac-myofibril IC50 values differ between primary records: article Table 5 gives 4.4 micromolar for 17 and 1.4 micromolar for aficamten, while the author CSV gives 4.2 and 1.3 micromolar. Both records are retained as assay context, without assuming a reason for the difference. A matched experimental Kd pair or validated state-specific affinity difference has not been established. Simulation microstates, the alchemical atom map and compound 17's bound pose remain unresolved.

## Execution boundary

Production calculation is intended to execute entirely in Robinhood Chain's EVM. External scientific inputs are the explicitly registered structures, chemical identities, force-field parameters and experimental observations, with their provenance retained.

All production minimisation, equilibration, force/energy evaluation, integration, stochastic sampling, alchemical transformations, reduced-potential collection, statistical estimation, diagnostics and result calculation must be performed by registered on-chain code. Source-file auditing and independent reference calculations during development must never be passed off as on-chain production results.

Every preparation-derived value must be either (a) an explicitly declared and frozen external model input, or (b) produced by a declared on-chain preparation algorithm. Uploaded model inputs do not establish that all upstream experimental measurement or preparation occurred on-chain. In particular, an off-chain molecular-dynamics result or a hash of one cannot stand in for production execution.

The first execution interface is permissionless bounded advancement after authorised experiment registration. Pool/swap triggers are a later integration stage. The user-approved architecture target is 64 deployed components, with actual responsibilities and size limits specified by the engineering lane; the scientific protocol does not treat contract count as evidence of scientific scale.

## Input freeze requirements

Before registration, a manifest must include:

| Item | Required declaration | Current status |
|---|---|---|
| Receptor | Source version/hash, species, construct and selected biological assembly | Source pinned; assembly 1 candidate selected, prepared model unresolved |
| Molecular state | Motor conformation, nucleotide/cofactor identities, protonation | Unresolved |
| Missing structure | Modelling procedure, terminal caps, selected alternate conformations | Provisional whole-residue altloc mask recorded; missing residues and incomplete TRP130 still need repair |
| Ligands | Exact identity, stereochemistry, atom mapping, protonation and starting poses | Published pair identities/stereochemistry verified; simulation microstates, mapping and compound 17 pose unresolved |
| Force fields | Exact versions, units, exceptions, charge assignments and provenance | Unresolved |
| Special parameters | Validated magnesium/ADP/vanadate and modified-residue treatment | Unresolved |
| Environment | Water model, box vectors, ionic strength, counterions, temperature and pressure | Unresolved |
| Method | Integration/constraint scheme, timestep, nonbonded/PME settings, alchemical Hamiltonians | Unresolved |
| Sampling | Lambda schedule, replicas/repeats, seeds, equilibration/production lengths, extension rules | Unresolved |
| Estimation | Estimator, decorrelation procedure, uncertainty and diagnostic definitions | Unresolved |
| Software | Module addresses, code hashes, arithmetic semantics and frozen input references | Engineering work in progress |

No exact prepared atom count, total simulation duration, simulation gas or completion time can yet be inferred from the crystal file. Sampling duration must be justified for this system using the registered method and diagnostics.

## Required calculation

1. **Construct two declared systems.** One contains the selected complete motor-domain model, ligand, chosen cofactors, explicit solvent and ions. The other contains the corresponding ligand in explicit solvent/ions under the registered thermodynamic conditions. Missing-coordinate modelling and any omissions require explicit scientific justification.
2. **Define A→B consistently.** Use a specified hybrid/dual topology, atom mapping and soft-core treatment. Specify how bonded, electrostatic and van der Waals interactions change with lambda and how any restraints/corrections enter the thermodynamic cycle. The published chemical graphs are both neutral and differ by CH2; separately verify the selected simulation microstates and parameterized endpoint charges.
3. **Minimise and equilibrate each system.** Record energies, constraint residuals and relevant thermodynamic observables. Pre-register treatment of failures and initialisation. Do not count equilibration as production without justification.
4. **Sample the intermediate states.** Use the registered ensemble and sampler, including replica exchange if selected. Execute all molecular operations on-chain. Register independent repeat seeds and retention of every attempted repeat.
5. **Estimate both leg free energies.** Collect the reduced potentials required by the specified estimator. Evaluate numerical stability, correlations, effective sample sizes, state overlap and sampling consistency. Quantify uncertainty using the registered method.
6. **Form the difference and uncertainty.** Combine complex and solvent estimates with the declared sign convention and account for any dependence between them. Report insufficient overlap or unconverged sampling explicitly.
7. **Publish the complete run record.** Preserve protocol identity, source data identity, seeds, progress, failures, corrections, convergence status, estimator outputs and gas/work accounting. A finite sample is not a proof of thermodynamic convergence.

## Transaction-boundary invariants

- The current molecular coordinates remain fixed during a force-evaluation stage. Accumulators and the next-state buffer are distinct from the current state.
- The integration cursor advances only after every required contribution for the relevant stage is complete. Periodic boundaries, neighbour-list rebuilds, constraints and reciprocal-space operations have declared ordering.
- A failed transaction commits no partial state. Retrying it must not change the registered operation order or consume additional scientific random draws.
- Stochastic draws derive from a registered deterministic generator and experiment/repeat/state/step/draw identifiers. Transaction sender, timestamp, block hash, gas budget and swap timing do not determine the scientific random stream.
- The numerical sum order is fixed or otherwise reproducibly specified. Partitioning the same work into different transaction batch sizes must reproduce the same ORVIA state under its own arithmetic rules.
- Protocol and module versions are immutable for a registered experiment. A corrected implementation receives a new protocol version; it does not silently continue an old experiment with changed mathematics.
- Any performance optimisation preserves the specified Hamiltonian, ensemble and estimator to registered tolerances. A smaller batch is an execution choice; a shorter scientific protocol is a scientific change.

## Validation and acceptance

Validation is staged; passing a numerical fixture does not clear the molecular protocol.

**Arithmetic and kernel checks:** independently generated reference values; signed/exceptional/domain cases; energies and analytic force checks against finite differences; periodic-boundary, long-range and alchemical endpoint tests. Numerical tolerances and units must be registered before evaluating the final molecular benchmark.

**Execution checks:** identical results for interrupted/resumed versus uninterrupted ORVIA execution, different permitted batch sizes, retry after reverts, access control and experiment/version separation. The production engine must reject incomplete inputs and unsupported parameters.

**Molecular checks:** agreement of relevant energies/forces with an independent established implementation for identical inputs; stability, constraint satisfaction and ensemble observables. Chaotic trajectories need not remain pointwise identical to a different arithmetic implementation. Differences require quantitative investigation rather than a blanket claim of bitwise OpenMM equivalence.

**Free-energy checks:** alchemical endpoint correctness, sufficient overlap and effective sampling, repeat agreement, estimator stability and uncertainty coverage where suitable evidence exists. The method must report failure or unresolved uncertainty instead of always emitting a confident result.

**Biological checks:** matched affinity measurements or a separately validated mechanistic assay model. Functional myofibrillar ATPase IC50 data alone do not prove this state-specific binding prediction. A later prospective campaign must register compounds and predictions before independent physical testing and retain negative outcomes.

## Gate to a scientific run

The source audit currently passes. The scientific run remains blocked until every unresolved input/method item above is resolved, the full engine supports the specified calculation, and scientific plus numerical review accepts the prepared system and protocol. This gate does not prevent development of reusable arithmetic, storage, checkpointing and validation infrastructure.

## Sources

- [PDB 9F6C](https://www.rcsb.org/structure/9F6C), pinned source files in `data/source/`.
- Chuang et al. 2021, [Discovery of Aficamten (CK-274)](https://doi.org/10.1021/acs.jmedchem.1c01290).
- Hartman et al. 2024, [Aficamten mechanism and structure](https://pmc.ncbi.nlm.nih.gov/articles/PMC11358156/).
- [OpenMM theory guide](https://docs.openmm.org/latest/userguide/theory.html), a reference for force/integration specifications, not a declaration that the full OpenMM implementation has been ported.
- [OpenFE TYK2 showcase](https://docs.openfree.energy/en/stable/tutorials/showcase_notebook.html), an example of RBFE workflow organisation; its molecular inputs and sampling settings are not adopted as a myosin protocol.
- [Robinhood Chain differences from Ethereum](https://docs.robinhood.com/chain/differences-from-ethereum/), including the constant `prevrandao` behaviour and chain-specific code-size limits.
