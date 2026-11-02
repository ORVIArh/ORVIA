# Bounded distance-constraint projection

`DistanceConstraintKernel` supplies one mass-weighted position or velocity correction. `ConstraintSolver` iterates coupled constraints in deterministic order across bounded transactions. These are reusable components; neither is wired into the existing dynamics coordinators in this checkpoint. Passing their tests does not establish a complete constrained molecular trajectory or thermostat.

## Input and execution API

Deploy `ConstraintSolver(writer, math, kernel)` after the writer contract exists. All three dependencies must have deployed code; the kernel must use the supplied arithmetic contract. Their runtime hashes are pinned. The supplied implementations have no upgrades; a runtime hash by itself would not freeze the storage-backed behavior of an arbitrary proxy.

Only the immutable writer may create and upload a problem:

```text
createProblem(id, sourceCommitment, mode, atomCount, constraintCount,
              tolerance, maxIterations)
appendAtoms(id, AtomInput[])
appendConstraints(id, Constraint[])
sealProblem(id)

AtomInput = (bytes16[3] anchor, bytes16[3] current, bytes16 mass)
Constraint = (uint32 a, uint32 b, bytes16 distance)
```

`id` and `sourceCommitment` are nonzero bytes32 values. An ID is created once and cannot be reset. The source commitment identifies the consuming engine's frozen source state/protocol; it does not replace the actual uploaded numerical inputs. Uploads are append-only batches of 1–8 records. All atoms must precede all constraints. Bounds are 2–65,536 atoms, 1–262,144 constraints, and 1–4,096 iterations, with the constraint count also limited by the number of unordered atom pairs. These are storage/work guards, not measured production capacity.

All numbers use binary128-format bytes16. Masses and tolerance must be finite and positive; all vector entries must be finite. Constraints use canonical `a < b < atomCount` and strictly increasing `a*atomCount+b`, rejecting duplicates or reordered inputs. The declared order fixes the iterative projection sequence.

| Mode | Anchor | Current | Constraint distance | Tolerance |
|---|---|---|---|---|
| 0, Position | Old coordinates | Unconstrained trial coordinates | Positive target distance | Relative squared-distance residual |
| 1, Velocity | Fixed constrained coordinates | Unconstrained velocities | Exactly canonical positive zero | Bond-projected velocity residual, inverse-time units |

Velocity mode does not verify that its anchor positions satisfy a separate distance-target problem. The consuming engine must establish that relationship. Position mode requires a consistent set of old-coordinate bond directions. This implementation uses direct differences of consistently unwrapped whole-molecule coordinates. It has no periodic-image selection, periodic box input or image-consistency solver; independently wrapped atoms must not be submitted as though these were supported periodic constraints.

After sealing, anyone may call `advance(id, workLimit)` with a limit of 1–8. Callers cannot select constraints, supply correction vectors, edit masses/tolerances or claim convergence.

## Numerical projection

Let `u = r_old,B − r_old,A`, `d = r_trial,B − r_trial,A`, target length `l`, and mass sum `M = mA + mB`. Position mode finds the local root `x` of `|d − x*u|² = l²`. The kernel uses the cancellation-resistant expression:

```text
defect = d·d − l²
x = defect / (u·d + sqrt((u·d)² − (u·u)*defect))
correction_A =  (mB/M) * x * u
correction_B = −(mA/M) * x * u
```

It rejects zero old separation, nonpositive `u·d`, negative discriminant and exceptional arithmetic. This explicitly restricts the continuous local projection; it does not resolve a bond orientation flip or jump to a distant geometric root. The reported residual is `abs(d·d − l²)/l²` before correction.

Velocity mode uses fixed displacement `d` and relative velocity `w = vB − vA`. It sets `x = (d·w)/(d·d)` and uses the same mass-weighted corrections along `d`. The residual is `abs(x)`, with inverse-time units. These corrections conserve mass-weighted position sum in position mode and linear momentum in velocity mode, subject to the declared finite arithmetic.

Every correction updates the current values used by subsequent constraints in the same pass. A constraint already within tolerance is left unchanged, but the kernel still validates its local geometry. A successful correction does not establish global convergence because a later shared-atom constraint can invalidate an earlier one.

## Separate checking pass

| Status | Meaning |
|---:|---|
| 0 Missing | Unknown ID |
| 1 Uploading | Append-only incomplete inputs |
| 2 Correcting | One constraint projection per work unit |
| 3 Checking | One residual per work unit, with current vectors held fixed for the whole pass |
| 4 Converged | Complete checking pass met the tolerance |
| 5 Failed | Maximum complete iterations reached without meeting tolerance |

After a complete correction pass, the solver resets the residual accumulator and checks every constraint against the same fixed, completed state. Only after this checking pass does it increment `iterations` and decide whether to converge, fail or start another correction pass. This avoids the invalid practice of treating each constraint's immediately post-correction residual as a simultaneous global residual.

`problemInfo` returns source/input commitments, mode, status, counts, upload progress, cursor, complete iteration count, limit, tolerance and the checking residual accumulator. During Checking the accumulator is partial; after a completed check it is the complete maximum. `atomAt` and `residualAt` expose diagnostic partial states. `solutionAt` succeeds **only** after Converged. Both terminal states reject further advancement or input changes. Nonconvergence never exposes a successful solution.

Invalid local geometry or arithmetic reverts the transaction, including corrections, cursor movement and pass transitions performed earlier in that transaction. Previously successful transactions remain as partial progress. Different problem IDs have separate state. There is no hidden fallback to an unconstrained timestep or to looser tolerances.

## Commitments

All encodings use Solidity `abi.encode` and Keccak-256. Let `config` be the hash of `(writer, math, kernel, writerCodeHash, mathCodeHash, kernelCodeHash)`.

```text
digest = keccak256(abi.encode(bytes32("ORVIA-CONSTRAINT-INPUT-v1"),
    uint256(chainId), address(solver), bytes32(id), bytes32(sourceCommitment),
    uint8(mode), uint32(atomCount), uint32(constraintCount), bytes16(tolerance),
    uint32(maxIterations), bytes32(config)))
```

Each appended atom folds `(digest, bytes32("ATOM"), uint256(index), AtomInput)`. Each appended constraint then folds `(digest, bytes32("CONSTRAINT"), uint256(index), Constraint)`. Sealing computes:

```text
commitment = keccak256(abi.encode(bytes32("ORVIA-CONSTRAINT-PROBLEM-v1"),
    bytes32(digest), uint32(atomCount), uint32(constraintCount)))
```

The digest covers the original trial vectors, even as current vectors are iteratively corrected. The problem ID, source commitment, mode, tolerance and iteration cap cannot change after creation. The writer boundary is demonstrated with a test-only harness; that harness is not a production input path.

## Required integration work

A consuming integrator must stage unconstrained coordinates, run position projection to convergence, and apply the corresponding displacement/time correction to the appropriate velocity intermediate. It must then compute forces at constrained coordinates, finish the velocity update and apply velocity projection at the correct algorithmic point. A failed or incomplete solver must prevent a timestep commit. Langevin splitting, periodic molecule images, constraints spanning partitions, virial/pressure effects and thermostat degrees of freedom require their own consistent integration and validation. None is established merely by running this stand-alone projection component.

## Validation

`test/constraints.test.mjs` uses a synthetic three-atom geometry with water-like masses 16:1:1 and three coupled distance constraints. Its unit-length right-angle geometry is a numerical fixture, not TIP3P or a physically parameterized water model. The suite verifies:

- Single-constraint corrections against independent high-precision scalar-root and tangent-projection calculations.
- Coupled position solutions against an independently solved three-multiplier nonlinear system.
- Coupled velocity solutions against an independent mass-weighted linear algebra projection.
- Complete checking passes, multiple iterations, final residuals, mass-weighted center preservation and momentum preservation.
- Bitwise equality across transaction partitions, immutable nonconvergence, same-transaction rollback and isolated problems.
- Independent commitment reconstruction, provenance/writer restrictions and malformed-input atomic rejection.

The reference calculation is development validation only; contract callers never submit its output as a production result. Gas reports cover the local stand-alone solver fixture, excluding deployment/uploads and any integrated dynamics costs. Finite binary128-format calculations retain the pinned arithmetic semantics; the tests do not establish a global error bound or general convergence for every molecular geometry.

The method context is documented in the [OpenMM integrator theory](https://docs.openmm.org/latest/userguide/theory/04_integrators.html) and the original RATTLE method, Andersen, *Journal of Computational Physics* 52 (1983), [doi:10.1016/0021-9991(83)90014-1](https://doi.org/10.1016/0021-9991(83)90014-1). The independently declared local-root implementation and stopping rules above are the specific contract behavior.
