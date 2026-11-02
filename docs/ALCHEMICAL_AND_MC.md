# Alchemical and Monte Carlo primitives

These are tested numerical components, not a completed alchemical simulation workflow. They do not prepare a hybrid topology, change a dynamics engine's Hamiltonian, generate cross-state samples, move a periodic box, or exchange live replicas by themselves.

## Softcore Lennard-Jones

`SoftcoreLennardJonesKernel(math)` exposes `evaluate(displacement, configuration)`, where displacement is B minus A and configuration is `((sigmaA,epsilonA),(sigmaB,epsilonB),lambda,alpha)`. Inputs use binary128-format words. Sigma and alpha must be positive, epsilon nonnegative, and lambda in [0,1].

The declared Beutler-style distance softening has exponent p=2:

```text
rhoA = r^6 + alpha * sigmaA^6 * lambda^2
rhoB = r^6 + alpha * sigmaB^6 * (1-lambda)^2
UA = 4*epsilonA*((sigmaA^6/rhoA)^2 - sigmaA^6/rhoA)
UB = 4*epsilonB*((sigmaB^6/rhoB)^2 - sigmaB^6/rhoB)
U = (1-lambda)*UA + lambda*UB
```

The result contains energy, the force on A, and dU/dlambda. Forces differentiate the complete softened energy, including the distance transformation. The lambda derivative includes both endpoint-weight and softening derivatives. At lambda zero or one the active endpoint recovers its ordinary LJ potential. Positive-strength active endpoints remain singular at zero distance and reject; intermediate states are finite there. A zero-epsilon endpoint contributes identically zero, with a declared positive sigma retained in the input schema.

The force on B is the negative of the reported force. The primitive has no periodic-image selection, cutoff switch, dispersion correction, alchemical Coulomb treatment or bonded-parameter interpolation. Those conventions must be supplied consistently by an integrated Hamiltonian. The general distance-softening family is documented in the [GROMACS free-energy reference](https://manual.gromacs.org/documentation/2024.1/reference-manual/functions/free-energy-interactions.html); p=2 is the explicit choice here, not a claim of equivalence to every package default.

`test/alchemical-mc.test.mjs` differentiates independently written scalar energies at 100 decimal digits for energy, each force component and dU/dlambda, including coincident intermediate-state atoms. It checks endpoint recovery, endpoint-exchange symmetry, zero-strength behavior and invalid domains. Actual errors are recorded in `reports/softcore_validation.json`.

## Metropolis acceptance

`MonteCarloAcceptance(math,scalar)` validates the scalar module's arithmetic dependency. The caller supplies a finite uniform strictly between zero and one. Production draws must come from a registered counter stream, and production energies must come from completed on-chain force passes. A public call to this stateless primitive alone does not prove either provenance.

`replicaExchange(u,uniform)` accepts four reduced configurational energies ordered as `u_i(x_i),u_i(x_j),u_j(x_i),u_j(x_j)`. It returns the log acceptance ratio and the decision `ln(uniform) < u_i(x_i)+u_j(x_j)-u_i(x_j)-u_j(x_i)`. The operation avoids exponentiating a large negative probability. A live exchange coordinator must freeze both states, calculate all cross energies, and atomically swap assignments; any required momentum transformations remain separate.

`volumeTrial(VolumeTrial)` computes

```text
logAcceptance = -(trialEnergy-oldEnergy + pressure*(trialVolume-oldVolume))/kT
                + scaledEntities*ln(trialVolume/oldVolume)
```

This formula requires a proposal symmetric in volume. A proposal symmetric in log-volume has a different proposal-density ratio and cannot reuse this formula unchanged. `scaledEntities` must match the scaling measure: atom count for independent atomic coordinates, or molecule count for a correctly implemented rigid-molecule center-of-mass proposal. It is not interchangeable with a count of constrained coordinates. Positive volumes/kT, nonnegative pressure, a bounded nonzero count and a valid uniform are required. Pressure times volume must use the same energy units as the input energies.

The acceptance calculation follows the volume-move convention in the [OpenMM theory guide](https://docs.openmm.org/latest/userguide/theory/02_standard_forces.html). It does not implement a barostat's proposal, molecule graph, scaling, trial force evaluation, rejection restoration or ensemble validation. The numerical tests check pressure work, the Jacobian, reverse moves, energy-offset invariance and explicit invalid-domain rejection.

These components remain subject to the finite arithmetic and global propagated-error limitations of the rest of the project. Their tests are not a binding-free-energy or constant-pressure sampling validation.
