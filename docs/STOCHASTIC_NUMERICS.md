# Scalar functions and deterministic Langevin components

These components provide bounded scalar functions, reproducible scientific random streams, and BAOAB Langevin updates. They are implementation building blocks. Primitive tests do not establish a correctly sampled protein ensemble, force-field validity, or a binding free energy.

## ScalarMath

Construction is `ScalarMath(math)`, where `math` is the registered `FloatMath`. The public `numericalMath` getter exposes that dependency. Inputs and outputs are binary128-format `bytes16`.

| Function | Supported input | Method |
|---|---|---|
| `ln(x)` | Positive finite x | Stable atanh series for 0.5 ≤ x ≤ 1.5; pinned ABDK natural logarithm elsewhere |
| `exp(x)` | −256 ≤ x ≤ 256 | Pinned ABDK exponential |
| `log1p(x)` | Finite x > −1 | Atanh series for abs(x) ≤ 0.5; ln(1+x) elsewhere |
| `expm1(x)` | −256 ≤ x ≤ 256 | 64-term exponential series for abs(x) ≤ 0.5; exp(x)−1 elsewhere |
| `erf(x)` | −16 ≤ x ≤ 16 | Positive-term small-argument series and complementary tail |
| `erfc(x)` | −16 ≤ x ≤ 16 | Small-argument complement; 128-level backward continued fraction for abs(x) ≥ 2 |

Unsupported inputs revert. There is no clipping of an Ewald argument or an estimator energy difference to these domains. Callers must register parameters and tile sums whose required arguments are supported. The helper also exposes `INV_SQRT_PI`, `MAX_EXP_ARGUMENT` and `MAX_ERF_ARGUMENT`.

For `log1p`, set `t=x/(2+x)` and sum `2*(t+t^3/3+...+t^127/127)`. The same series handles `ln(x)` near one after subtracting one, avoiding the relative-accuracy loss observed in the vendored logarithm at values immediately adjacent to one. For `expm1`, sum the first 64 nonconstant terms of the exponential series. These functions retain small nonzero thermostat variance factors that a direct subtraction from one would erase.

For 0 ≤ x ≤ 2, erf uses

```text
erf(x) = (2/sqrt(pi)) exp(-x²) x
         [1 + 2x²/3 + (2x²)²/(3*5) + ...]
```

with 64 terms. The non-alternating series avoids cancellation between large signed terms. The erfc tail uses the continued fraction equivalent to [NIST DLMF 7.9.2](https://dlmf.nist.gov/7.9): `b_n=x²+1/2+2n`, `a_n=n(n−1/2)`, evaluated backward for 128 levels. At x=2, the independently evaluated high-precision truncation discrepancy is about 1.2e−37 relative; this is a truncation check at that argument, not a bound on all floating-point errors. Multiplication by `exp(-x²)/sqrt(pi)` retains the nonzero erfc tail through x=16. Negative arguments use the standard parity/complement identities. Small-x erf is evaluated directly, rather than subtracting erfc from one.

The bounded loops inline the same pinned ABDK arithmetic used by `FloatMath`, avoiding hundreds of external calls per special function. Domain checks and final nonfinite checks remain explicit. Upstream arithmetic rounding is retained; no complete IEEE-754 conformance or propagated trajectory error bound is claimed. Extremely small representable values can still encounter representational underflow.

## CounterRandom

Construction is `CounterRandom(math, scalar, elementary)`. It validates the scalar and elementary modules' arithmetic dependency and exposes all three addresses.

```text
word(seed, streamId, replica, step, draw, lane) -> bytes32
uniform(seed, streamId, replica, step, draw) -> bytes16
normalPair(seed, streamId, replica, step, draw) -> (bytes16, bytes16)
```

`seed` and `streamId` are bytes32; replica is uint32; step and draw are uint64; lane is uint8. The hash is exactly

```text
keccak256(abi.encode(
  keccak256("ORVIA.CounterRandom.v1"), seed, streamId,
  uint32(replica), uint64(step), uint64(draw), uint8(lane)
))
```

The upper 112 hash bits form integer b. A uniform variate is `(2*b+1)/2^113`, an exactly representable midpoint strictly between zero and one. `uniform` uses lane 0. `normalPair` uses lanes 0 and 1, with `radius=sqrt(-2*ln(u))` and angle `2*pi*v`; it returns radius times cosine and sine, respectively. These are finite-resolution approximations to standard normals, with the finite tail implied by the midpoint grid. They are not a claim of continuous or cryptographically secret randomness.

No block hash, timestamp, sender, contract address or mutable counter enters the draw. Re-requesting the same tuple returns the same values; transaction partition cannot consume or reorder a stream. Scientific protocols must declare independent seed/stream/replica combinations and counter assignment. Reusing a tuple intentionally reuses its draw.

The use of registered counters follows the need for independent reproducible streams in stochastic simulation described by [OpenMM's random-number discussion](https://docs.openmm.org/latest/userguide/theory/05_other_features.html). It does not claim bitwise identity with an OpenMM generator.

## LangevinBAOABKernel

Construction is `LangevinBAOABKernel(math, scalar)`. Methods are:

```text
coefficients(mass, dt, friction, kT) -> (decay, noiseScale)
begin(position[3], velocity[3], force[3], mass, dt, friction, kT, normal[3])
  -> (nextPosition[3], thermalVelocity[3])
finish(thermalVelocity[3], newForce[3], mass, dt) -> nextVelocity[3]
```

`kT` is thermal energy in the potential-energy unit, not temperature in Kelvin. Mass, timestep and kT must be positive finite; friction is finite and nonnegative. `friction*dt` must remain at most 256. Vectors and normals must be finite. The coefficient computation uses `decay=exp(-friction*dt)` and `noiseScale=sqrt((kT/mass)*(1-decay²))`. For small friction*time it obtains the variance factor from `-expm1(-2*friction*dt)` to retain a tiny nonzero value; otherwise it uses `(1-decay)*(1+decay)`.

The actual splitting is

```text
vB = v + dt*F_old/(2m)
xA = x + dt*vB/2
vO = decay*vB + noiseScale*normal
xNext = xA + dt*vO/2
vNext = vO + dt*F_new/(2m)
```

`begin` combines the two position increments as `x + dt*(vB+vO)/2` in its declared arithmetic order. `finish` must run only after a complete next-position force pass. Zero friction reduces the update to velocity Verlet. These are on-step BAOAB velocities, not the half-step velocities exposed by LFMiddle; the relationship is documented by [OpenMM's LangevinMiddleIntegrator](https://docs.openmm.org/latest/api-python/generated/openmm.openmm.LangevinMiddleIntegrator.html).

Constraints, pressure control and force calculation are not implemented by this primitive. The separate `LangevinDynamicsCoordinator` binds deterministic normals to integration counters and enforces the complete-force barrier.

## Validation

`test/scalar-random.test.mjs` uses independently decoded EVM values and `reference/scalar_random_reference.py` at 110 decimal digits. It checks scalar branches and tails, adjacent-to-one logarithms, independent hash-domain and midpoint encodings, normal transforms, one-atom BAOAB splitting, zero friction and very small friction, and rejection of unsupported domains and dependency mismatches. The normal sample mean/variance check is a small deterministic sanity test, not a general random-generator quality certification or ensemble test. Actual tolerances and observed errors are recorded in `reports/scalar_random_validation.json`.
