# Stochastic constrained integration checks

The additional synthetic three-atom test exercises nonzero tangential bond forces, nonzero friction and counter-addressed thermostat draws through two constrained steps. An independent 110-digit reference differentiates the scalar bond potential and solves the projected kick, drift and thermostat operations. It conditions on the on-chain random draws; it does not independently validate the random generator or the sampled ensemble.

`test/constrained-molecular-extra.test.mjs` checks that continuation reproduces the next uninterrupted step bit for bit, preserves the inherited constraint transcript and checkpoint, rejects further advancement of the handed-off parent, and binds the child's extended transcript into the recorded sample. It also rejects preregistration mismatches in position tolerance, velocity tolerance, sweep count, constrained versus unconstrained method, and the per-leg constraint-model policy, as well as registration after a window starts.

The current portable report, `reports/constrained_molecular_extra_validation.json`, captures every compiled source hash and checks those hashes again at completion. It includes the promoted spatial-capable Hamiltonian source but leaves its spatial extension unbound in this particular test. This is separate from a complete spatial-and-constrained integration test. The earlier isolated pass is recorded by hash as historical provenance; it is not substituted for the portable run.

Use `ORVIA_RESEARCH_PYTHON` to select a Python interpreter with `mpmath`. No scientific production acceptance, full-model trajectory or mainnet deployment is established by these checks.
