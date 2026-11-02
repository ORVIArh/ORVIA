# Velocity Verlet and independent trajectory reference

`VelocityVerletKernel` performs the two arithmetic parts of an unconstrained velocity-Verlet step for one atom. It calls the immutable `FloatMath` implementation; all returned positions and velocities are calculated in the EVM. It requires finite operands, strictly positive mass and strictly positive timestep. Intermediate nonfinite arithmetic is rejected by `FloatMath`.

The calling coordinator must first finish the complete force evaluation at the current coordinates. It then calls:

```solidity
drift(position, velocity, currentForce, mass, dt)
    -> (nextPosition, halfVelocity)
```

with the equations

\[
v_{n+1/2}=v_n+\frac{\Delta t}{2m}F(x_n),\qquad
x_{n+1}=x_n+\Delta t\,v_{n+1/2}.
\]

After every next coordinate is staged and the complete force at those coordinates is available, it calls:

```solidity
kick(halfVelocity, nextForce, mass, dt) -> nextVelocity
```

\[
v_{n+1}=v_{n+1/2}+\frac{\Delta t}{2m}F(x_{n+1}).
\]

The kernel enforces numerical operand domains, not the coordinator's stage ordering. It does not impose constraints, periodic wrapping, a thermostat, a barostat or a scientifically selected timestep. Unit consistency is required; the reference uses nm, ps, Da and kJ/mol, for which the numeric force/mass conversion is consistent with nm/ps².

## Independent reference fixture

`reference/generate_dynamics_reference.py` defines a four-atom, nonperiodic validation system. All initial inputs are exactly representable dyadic values. It contains three harmonic bonds, two harmonic angles, one periodic torsion and one pair with both direct Lennard–Jones and Coulomb energy. Every energy family contributes a nonzero total at the initial state. These are declared engineering-fixture parameters, not fitted drug or force-field parameters.

The generator uses **mpmath 1.3.0 at 90 decimal digits**. It differentiates the complete independent scalar potential with `mpmath.diff` for each Cartesian coordinate. It does not reuse the analytical Solidity force expressions or import their implementation. Forces are the negative energy gradient.

The torsion convention is explicitly:

\[
b_1=x_b-x_a,\quad b_2=x_c-x_b,\quad b_3=x_d-x_c,
\quad n_1=b_1\times b_2,\quad n_2=b_2\times b_3,
\]
\[
\phi=\operatorname{atan2}\!\left(\hat b_2\cdot(n_1\times n_2),n_1\cdot n_2\right),
\quad U_{\rm torsion}=k[1+\cos(n\phi-\delta)].
\]

Eight steps at `dt = 1/128 ps` produce nine saved checkpoints, including the initial state. The JSON contains binary128-encoded inputs and high-precision decimal positions, velocities, forces, potential/kinetic/total energies, linear momentum and center of mass. It also records the separate energy families for inspection. Expected values are compared numerically, not assumed to have the exact same final bits as another arithmetic implementation.

The short-trajectory comparison criterion is absolute `1e-25` plus relative `1e-24`. This is a component-test tolerance; it is not an accepted production molecular-simulation error budget. Bitwise equality under different transaction partitions is a separate execution invariant tested by the EVM harness.

## Reproduce and validate

Install the pinned research requirements in a development Python environment, then run:

```bash
python reference/generate_dynamics_reference.py
python -m unittest discover -s reference -p 'test_dynamics_reference.py'
```

The independent-oracle checks cover exact input encoding, nonzero coverage of all energy terms, explicit finite-difference agreement, zero total internal force/torque, momentum/center-of-mass evolution, time reversal, timestep refinement and reproducibility of the committed JSON.

For this fixture, halving the timestep while keeping the elapsed time fixed reduces the endpoint total-energy error to approximately one quarter. That confirms the expected second-order behavior for this smooth, short test. It does not establish long-run stability, ensemble correctness, general force-field correctness or binding-free-energy accuracy. Separate contract tests must establish actual EVM agreement with these references.

No source protein, solvent, cofactor or clinical interpretation is part of this validation trajectory. The on-chain research protocol still requires complete system preparation and the remaining simulation and estimation algorithms.
