# Component review record

## v0.3 review

The angular, integration and dynamics-data implementations received independent code review. Additional EVM spot checks compared 84 angular-force components against high-precision differentiated energies, with maximum observed absolute error approximately 8.08e-32. These spot checks supplement the committed angular reference suite; they are not an error bound for general trajectories.

Review of `DynamicsCoordinator` checked the ordered validation/force stages, skipping of empty optional streams, clearing of inactive forces and energy, positive mass/timestep handling, module/data/run commitments and the final-kick commit barrier. No blocking implementation defect was identified. Integration tests explicitly exercise staged-state isolation, eight-step reference agreement, alternative transaction partitions, a singular trial-state failure, and a batch crossing the final kick when optional interaction streams are empty.

Full-system solvent/periodic physics, production error budgets and RBFE methods remain outside this implementation. Parallel review and fixture tests are not an independent security audit or evidence of cardiac efficacy.

## v0.2 review

The catalog, paged coordinator and working page received a cross-lane read-only review. No blocking implementation defect was identified. The review checked canonical low-bit word decoding, page provenance and commitments, input-validation barriers, fixed accumulation order, sole-writer namespaces, configuration binding and cross-contract transactional rollback.

The paged integration suite additionally reconstructs each page digest, the ordered dataset commitment, immutable configuration and complete run commitment from public operands and local deployed bytecode. Tests compare paged outputs with the original engine, exercise both checkpointed and cross-phase batches, reject malformed schemas and prove that a later failing bond reverses earlier writes in the same transaction.

Singular geometry remains an evaluation-stage error. A failed transaction preserves earlier successful checkpoints and cannot seal or complete the run. Documentation distinguishes this behavior from the preceding coordinate/parameter checks.

Lennard–Jones and Coulomb direct-pair primitives are independently tested against fourteen high-precision Decimal vectors, numerical energy gradients, force signs and mechanical symmetries. These kernels are not connected to a complete molecular force loop.

The complete combined-check outcome is recorded in `validation_summary.json`. This review is engineering validation, not a third-party security audit or validation of the future full scientific model.

## v0.1 review retained

Review date: 2026-11-01. Parallel code review by the implementation agents; this is not an independent security audit.

## Resolved finding

The upstream comparator distinguished the two signed-zero encodings. ORVIA's `FloatMath.compare` now canonicalizes zero operands before comparison, matching the wrapper's numerical-zero semantics. Regression assertions exercise both argument orders, signed comparisons, zero canonicalization and division by either zero sign. The upstream vendored library remains unchanged.

## Added evidence

- Independently reconstruct the protocol manifest, complete operand hash and run commitment from public input and deployed local bytecode.
- Compare a 21-interaction fixture with shared atoms, non-axis geometry and varied force constants across partitions `[16,5]`, 21 single-interaction calls, and `[7,4,10]`.

The final result of these checks is recorded in `validation_summary.json` and `evm_components.log`. Assertions about success should use those completed reports.

## Remaining scope limits

No additional correctness defect was identified in the reviewed core contracts for the supplied immutable implementations. This is not proof of general safety. Code hashes alone would not freeze storage-backed proxy behavior; the shipped modules use no proxies. Extreme-magnitude numerical domain limits and accumulated error budgets remain unresolved for production molecular calculations. Full dynamics and free-energy methods are not implemented by this component.
