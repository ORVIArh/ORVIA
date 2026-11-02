# Unaccepted staged C4 policy candidate

This is an isolated mathematical/reference candidate for the frozen **ADPPI**
complex33 and matched solvent inputs. It neither substitutes for the selected
original vanadate model nor accepts any force-field, C4, quantum, sampling or
periodic correction gate. No Solidity implementation, trajectory, wallet,
testnet, mainnet call or transaction is part of this work.

The source-specific tests pass, but this is not a published or scientifically
validated alchemical C4 protocol. The useful result is a concrete path that
preserves the source-defined endpoint component potentials and removes the
*introduced* Mg/C41 attractive singularity. Strict global stability of the full
native point-charge model cannot be promised while preserving those endpoints.

## 1. Findings that determine the design

The actual native Mg has 52,479 nonexcluded positive-C4 partners; every such pair
has a positive native repulsive A12 coefficient. The 80,451 zero-A12 Mg pairs
(80,346 water HW and 105 HO sites) all have C4 zero. There is no native C4-only
zero-repulsion counterexample in these inputs.

There is an **introduced interior** counterexample in the current linear-charge
path. B-only union C41 has `qB=-0.09312270459821208 e`, `qA=0`, and a disappearing
LJ core. At lambda 0.5 its interaction with Mg(+2) contains

`U_real(r) = -12.93804558/r + O(1) kJ/mol`.

The current softcore LJ limit is finite, approximately 23.11944 kJ/mol. A bounded
softcore C4 term cannot cancel the negative `1/r`. Native pair (12042,12132) maps
to hybrid (12042,12133). Both endpoint exception streams omit this pair, and Mg
appears in no bonded term or constraint. The exact collision-path certificate
keeps every other separation positive. Finite-mode reciprocal terms stay bounded;
self, background and class-tail terms are constant along that fixed-charge path.
See `endpoint-stability/mg-c41-collision-path.json`.

There is a separate **inherited endpoint** example: free Cl12275 can approach
fixed THR/HG1(HO)298. This unexcluded pair has A12=B6=C4=0 and opposite charges,
so its energy tends to `-56.33610508/r`. This is a mathematical point-charge
domain problem, not an observed trajectory collapse or a C4-specific defect.
Excluding only the single point r=0 does not bound the negative near-zero
potential. An unrestricted canonical-partition/global-boundedness theorem is
therefore incompatible with exact native endpoints. Any positive collision
domain, hard wall or force regularization must be an explicit additional model
choice, with its effect assessed; it cannot be called unchanged native physics.

These findings motivate coordinated electrostatic/core treatment. Published
softcore work studies simultaneous versus staged transformations and identifies
particle-collapse risks when attraction and repulsion are softened inconsistently.
The formulas below are our proposed extension, not a claim that those papers
validated this C4 force field. [Steinbrecher et al.](https://pubmed.ncbi.nlm.nih.gov/21953558/),
[Tsai et al.](https://pubmed.ncbi.nlm.nih.gov/36622640/)

## 2. Explicit activity and three phases

Use immutable source metadata, **not zero charge or epsilon**, to identify:

- A-only H25;
- B-only C41 and H42–H44;
- the 40 common ligand atoms and unchanged environment;
- the sole, unchanged Mg.

Let `S(x)=6x^5-15x^4+10x^3`, clamped to [0,1]. The proposed path is:

| Phase | Core/C4 activity | Atomic charges |
|---|---|---|
| Discharge, lambda 0 to 1/3 | A unique fully physical; B unique off | A unique qA times `1-S(3lambda)`; common at A; B unique zero |
| Core transform, 1/3 to 2/3 | `t=S(3lambda-1)`, aA=1-t, aB=t | Both unique groups exactly zero; common `(1-t)qA+t qB` |
| Recharge, 2/3 to 1 | B unique fully physical; A unique off | B unique qB times `S(3lambda-2)`; common at B; A unique zero |

Every charged unique atom therefore has its full physical core. For pairs with
a positive physical repulsive coefficient, the softened-core stage has exactly
zero unique-atom charge and desired exception product. This removes the specific
new softcore-plus-Coulomb singularity. It does not prohibit all collisions or
repair inherited native zero-LJ point-charge attractions.

For an implementation, register **phase plus local progress**, or exact encoded
phase boundaries and clamped controls. Binary128 cannot represent 1/3 exactly;
do not let rounded global-lambda arithmetic leak a tiny charge into a soft stage.
Controls and ordering must be authenticated per state and included in the
protocol/campaign/evaluation provenance. The phase table is a path definition,
not an accepted choice of window count, timesteps, repeats or equilibration.

All terms must use the **same gated charge vector**: real-space pairs, every
reciprocal structure factor and force term, self energy, total-charge background,
and exception corrections. Changing only the normal-pair Coulomb call is wrong.
For an exception, derive endpoint scale factors from source desired products and
physical endpoint charges, using explicit presence metadata for absent sites.
Then use the scaled *current* charge product, with endpoint-source branches to
retain exact input words. Excluded pairs remain zero. Source ratios for a truly
zero physical charge need explicit native scale metadata, not a guessed 0/0.
The reference checks all 239 local exception records at 13 states.

Common ligand LJ parameters remain unchanged and positive at both endpoints.
For an unchanged environment site, the common-site charge product is a convex
interpolation of its endpoint products. Thus a common/environment zero-LJ
attraction cannot first appear unless at least one native endpoint already has
that attraction. Common/common charge products can vary quadratically, but both
of those ligand sites retain their unchanged physical repulsive cores. This
argument is not a global native-ensemble stability proof.

## 3. Shared radial softening with a C4-aware contact cap

For a physical endpoint pair define

`A=4 epsilon sigma^12`, `B=4 epsilon sigma^6`, `C=C4 >= 0`.

The native uncut pair function is `A/r^12-B/r^6-C/r^4`. For an actual unique-site
pair of activity a, propose

```text
kappa = C/(4 epsilon sigma^4)
D     = sigma^6/(1+kappa)
rho   = r^6 + alpha D (1-a)^2,  alpha=0.5 candidate
U     = a [A/rho^2 - B/rho - C/rho^(2/3)].
```

An inactive term returns exactly zero before division. At a=1 and r>0 this is
exactly the native mathematical pair potential; a physical active collision
remains outside the evaluation domain. At 0<a<1, overlap energy is finite and
its Cartesian force is zero. Unchanged common C4/LJ pairs retain the physical
function and are not unnecessarily softened. Zero-epsilon/C4-zero pairs skip
the van der Waals term. Positive C4 with zero A12 fails the candidate's native
admission check; it is not hidden by a new endpoint regulator.

The same rho must govern LJ and C4. Softening LJ while leaving `-C/r^4` bare
introduces an even stronger attractive singularity. Merely interpolating C4
coefficients is insufficient. The physical 12-6-4 model is an added inverse-fourth
attraction; it is not supplied with its own independent repulsive core.
[Li and Merz](https://pubs.acs.org/doi/10.1021/ct400751u)

Even a common *sigma-based* soft coordinate needs care here. Let
`V(rho)=A/rho^2-B/rho-C/rho^(2/3)`. Its sole positive stationary point satisfies

`6 B rho + 4 C rho^(4/3) = 12 A`.

The left side increases strictly. For `D=sigma^6/(1+kappa)`, D<=sigma^6 and

`[6 B D + 4 C D^(4/3)]/(12 A) <= (6+4kappa)/[12(1+kappa)] <= 1/2`.

Hence D is strictly below the native minimum's rho. With alpha=0.5, the shifted
coordinate cannot push that minimum to r=0; its radius stays above
`r_native_min*(1/2)^(1/6)`. The actual Mg–hc and Mg–c3 values have kappa about
9.269 and 6.282. At activity 0.001 a naive `alpha sigma^6` shift produces an
overlap minimum for all five actual unique-site pairs; the capped shift does not.
In fact, D is at most half the native minimum rho, giving the stronger bound
`r_min >= r_native_min*(3/4)^(1/6)`. Also, for y=delta/sigma^6,
`V(delta)*delta^2/A = 1-y-kappa*y^(4/3) >= 1/2`, so soft overlap energy is
positive and r=0 is a flat local maximum. These are core-region arguments. A declared LJ switching function must be applied
with its force derivative, and its cutoff behavior checked separately.

The analytic derivatives used for reference are

```text
V_rho = -2A/rho^3 + B/rho^2 + (2/3)C/rho^(5/3)
dU/dr = 6 a r^5 V_rho
dU/da = V - 2 a alpha D (1-a) V_rho.
```

Alpha and the smaller soft length can affect overlap and statistical efficiency.
Neither radial algebra nor a derivative test establishes sufficient window
overlap or an efficient sampling schedule. No alpha fit or sampling acceptance
has been performed.

## 4. Softened C4 tail with physical activity counts

The native importer convention is fixed-box, unswitched C4 with a hard periodic
cutoff and a finite-N class average. Its self-class count is Ni(Ni+1)/2, and
exclusions are not subtracted from that average. A sole Mg therefore retains a
nonzero self-class tail even though no direct self-pair exists.
[Pinned implementation](https://github.com/openmm/openmm/blob/b399af4725573963b46d6c1083fdcf7a37615857/openmmapi/src/CustomNonbondedForceImpl.cpp#L179)

Using the retained union particle count would contaminate native physical
endpoints with inactive-ghost normalization. Instead define

`N_eff = N_common + aA + 4 aB`.

This gives complex physical counts 132,932 at A and 132,935 at B; the solvent
counts are 151,502 and 151,505. It is an explicit C4 correction convention, not
a change to the number of integrated particles or a charge-derived activity.
At inactive endpoints, real and tail C4 terms have no ghost-coordinate dependence,
allowing the existing singly anchored ghost bond-tree factorization argument;
its cancellation still requires identical leg boxes, masses and tree policy.

For one softened unique-site term, let delta=alpha D(1-a)^2 and

```text
J(z) = integral_0^1 (1+z t^6)^(-2/3) dt
     = hypergeometric_2F1(2/3,1/6;7/6;-z)
I(delta,rc) = -C/rc * J(delta/rc^6).
```

This follows directly from integrating `-C r^2/(r^6+delta)^(2/3)` from rc to
infinity with t=rc/r. Use the exact soft tail, not `-aC/rc` at all intermediate
states. Sum the immutable common/Mg-self tails plus each unique term `a I`.
Unique sites sharing an atom type can have different softness, so do not replace
them by one class-average delta.

For this one-Mg source-specific domain,

`E_tail = (4 pi/V) [N_eff/(N_eff+1)] T`,

where T is that signed radial-integral sum. Its lambda derivative includes

`(4 pi/V) [N_eff' T/(N_eff+1)^2 + N_eff T'/(N_eff+1)]`.

Omitting the first term is wrong. The correction has zero Cartesian force for
a fixed box; a variable-cell/virial policy has not been developed here. At both
endpoints, active softness is zero, absent terms vanish and this recovers the
native physical-count C4 operator, including the Mg self-class convention.
Numerical endpoint equivalence is to the mathematical operator, not bitwise
OpenMM float quadrature or GPU arithmetic.

A bounded implementation can avoid an unbounded numerical integral. For
`0<=z<=1/16`, use 25 terms of

`J(z)=sum_n (-1)^n (2/3)_n z^n/[n!(6n+1)]`.

It is alternating with shrinking terms. The first omitted term bounds the error;
the same argument bounds the differentiated series. Uniform bounds are below
1e-30 for J and 1e-28 for J'. Reference tests compare these with independent
110-digit quadrature and the hypergeometric function. Actual source z values are
much smaller. Future binary128 truncation/operation error still needs its own
on-chain tests and bounds; the arbitrary-precision result is not that evidence.

The native hard cutoff has a finite C4 energy jump. Keeping exact native endpoint
functions and simultaneously requiring a globally C2 radial cutoff is impossible.
LRC is a constant and does not remove that jump. A shifted/switched C4 endpoint
would be a separately declared physical-model change, not an unnoticed fix.

## 5. Charge accounting and unresolved periodic physics

No charge renormalization or counterion substitution is proposed. Source sums are:

| Leg | Q_A/e | Q_B/e | Maximum sampled charge magnitude /e |
|---|---:|---:|---:|
| Complex | -1.822448315e-6 | -1.827222685e-6 | 0.07741757842 |
| Solvent | 2.304868268e-9 | -2.469501617e-9 | 0.07741575366 |

The intermediate values are material changes from the nearly neutral endpoints.
Every Ewald term must use gated charges, including the uniform-background Q^2
term. Matched boxes do not prove cancellation of all charge/finite-size errors.
The chosen finite reciprocal sum, convergence, boundary convention and any
physical correction need a separate preregistered validation. This candidate
does not claim an accepted RBFE charging protocol or automatically apply a
correction from a different electrostatic model.
[Rocklin et al.](https://pubmed.ncbi.nlm.nih.gov/24320250/)

## 6. Evidence and next implementation boundary

`policy-preregistration.json` was written before these candidate curves.
`candidate-validation.json` passes 3,546 checks, including 80 component endpoint
identities, 2,725 derivative points and 3,107 local exception/state checks.
`source-cutoff-validation.json` separately passes 254 checks: actual native
type/matrix and HC diagonal identities, independent whole-class tail endpoint
goldens, and an explicit C4 hard-cutoff caller with LJ-only switching. Five small
OpenMM Reference contexts compare 240 queries and 1,440 force components. The LJ
switch is diagnostic; this does not validate a selected full-native LJ convention.

The native source/collision audits, actual pair curves, softened tail checks,
net-charge curves and staged Mg/C41 witness remain alongside it. The initial
root-finding implementation failure is retained; switching to guaranteed
bisection changed no candidate function, tolerance or physical criterion.

An implementation must bind explicit activity and phase metadata, all source
words, derived D policy, charge/exception rules, cutoff/tail convention and
physical-count convention. D and tail values must be derived from authenticated
inputs on chain, never accepted as EOA-supplied energies. A packed activity map
or bounded sparse source identity can fit existing input banks; no additional
catalog contract is implied by this design.

Before admission, required work includes endpoint/native numerical-policy tests,
all gated Ewald/exception stages, complete candidate energy/force reference
comparisons, continuation/RNG/sample provenance checks, actual gas measurements,
window overlap and sampling convergence, an explicit native collision-domain
choice, periodic-charge treatment, and acceptance of the selected original
physical system and force-field parameters. The ADPPI preparation's failed
quality/model gates remain false. This mathematical candidate clears none of them.
