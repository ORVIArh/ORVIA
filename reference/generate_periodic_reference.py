#!/usr/bin/env python3
"""Independent high-precision orthorhombic dynamics oracle.

Force values are negative derivatives of the scalar Hamiltonian, not copies of
Solidity force expressions. This is a small declared cutoff-model fixture, not
an approved cardiac protein force field or an Ewald electrostatics calculation.
"""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path

import mpmath as mp

from generate_bond_vectors import binary128_nearest
from generate_dynamics_reference import cross, dot, norm

PRECISION = 90
MPMATH_VERSION = "1.3.0"
INPUT = {
    "positions": [["7.75", "0", "0"], ["0.75", "0", "0"],
                  ["1.25", "1", "0.125"], ["2.75", "1.25", "1.125"]],
    "particles": [["12", "16.015625", "-0.0078125", "0"],
                  ["14", "16", "0.0078125", "-0.015625"],
                  ["16", "15.9921875", "0", "0.0078125"],
                  ["12", "16.0078125", "-0.015625", "0.015625"]],
    "bonds": [[0, 1, "2", "1"], [1, 2, "3", "1"], [2, 3, "2", "1"]],
    "angles": [[0, 1, 2, "0.5", "1.5"], [1, 2, 3, "0.75", "1.75"]],
    "torsions": [[0, 1, 2, 3, 2, "0.25", "0.5"]],
    "pairs": [],
    "nonbonded": [["0.5", "0.125", "0.5"], ["0.75", "0.25", "-0.5"],
                  ["0.625", "0.5", "0.25"], ["0.875", "0.125", "-0.25"]],
    "exceptions": [[0, 1, 1, "0", "0", "0"], [1, 2, 2, "0.5", "0.0625", "-0.125"]],
    "box": ["8", "8", "8"],
    "switchDistance": "2",
    "cutoff": "3",
    "prefactor": "1",
    "dt": "0.0078125",
    "steps": 3,
}


def displacement(a, b, box):
    """Nearest b-a image; exact half-box ties keep the original remainder sign.

    High-precision oracle uses truncation directly, independent from binary128
    implementation detail. Derivatives are evaluated away from half-box ties.
    """
    result = []
    for left, right, length in zip(a, b, box):
        length = mp.mpf(length)
        delta = right - left
        quotient = delta / length
        integer = mp.floor(quotient) if quotient >= 0 else mp.ceil(quotient)
        remainder = delta - integer * length
        if remainder > length / 2:
            remainder -= length
        elif remainder < -length / 2:
            remainder += length
        result.append(remainder)
    return result


def unique_displacement(a, b, box):
    """The bonded/direct-exception force domain excludes ambiguous half-box images."""
    result = displacement(a, b, box)
    if any(abs(value) == mp.mpf(length)/2 for value,length in zip(result,box)):
        raise ValueError("Bonded or direct-exception image is ambiguous at half-box separation")
    return result


def pair_energy(distance, sigma, epsilon, charge_product, source=INPUT, *, exception=False):
    """Return LJ and Coulomb scalar energies at a positive separation."""
    r, sigma, epsilon, charge_product = map(mp.mpf, (distance, sigma, epsilon, charge_product))
    rs, rc, prefactor = map(mp.mpf, (source["switchDistance"], source["cutoff"], source["prefactor"]))
    if r <= 0:
        raise ValueError("Non-excluded zero separation is outside the model")
    if not exception and r >= rc:
        return mp.mpf(0), mp.mpf(0)
    ratio = sigma / r
    lj = 4 * epsilon * (ratio**12 - ratio**6)
    if exception:
        return lj, prefactor * charge_product / r
    if r > rs:
        x = (r - rs) / (rc - rs)
        lj *= 1 - 10*x**3 + 15*x**4 - 6*x**5
    coulomb = prefactor * charge_product * (1/r + r*r/(2*rc**3) - 3/(2*rc))
    return lj, coulomb


def pair_records(positions, source=INPUT):
    exceptions = {(row[0], row[1]): row for row in source["exceptions"]}
    records = []
    for a in range(len(positions)):
        for b in range(a + 1, len(positions)):
            override = exceptions.get((a, b))
            if override and override[2] == 1:
                records.append({"atoms": [a, b], "kind": "excluded", "distance": None,
                                "lennard_jones": mp.mpf(0), "coulomb": mp.mpf(0)})
                continue
            vector = (unique_displacement if override else displacement)(positions[a], positions[b], source["box"])
            distance = norm(vector)
            if override:
                sigma, epsilon, charge_product = map(mp.mpf, override[3:])
                kind = "exception"
            else:
                si, ei, qi = map(mp.mpf, source["nonbonded"][a])
                sj, ej, qj = map(mp.mpf, source["nonbonded"][b])
                sigma, epsilon, charge_product = (si+sj)/2, mp.sqrt(ei*ej), qi*qj
                if distance >= mp.mpf(source["cutoff"]):
                    kind = "outside_cutoff"
                elif distance > mp.mpf(source["switchDistance"]):
                    kind = "switching"
                else:
                    kind = "inside_switch"
            lj, coulomb = pair_energy(distance, sigma, epsilon, charge_product, source,
                                      exception=override is not None)
            records.append({"atoms": [a, b], "kind": kind, "distance": distance,
                            "lennard_jones": lj, "coulomb": coulomb})
    return records


def energy_terms(positions, source=INPUT):
    terms = {name: mp.mpf(0) for name in ("bonds", "angles", "torsions", "lennard_jones", "coulomb")}
    box = source["box"]
    for a, b, k, r0 in source["bonds"]:
        extension = norm(unique_displacement(positions[a], positions[b], box)) - mp.mpf(r0)
        terms["bonds"] += mp.mpf(k) * extension**2 / 2
    for a, b, c, k, theta0 in source["angles"]:
        u = unique_displacement(positions[b], positions[a], box)
        v = unique_displacement(positions[b], positions[c], box)
        theta = mp.acos(dot(u, v) / (norm(u) * norm(v)))
        terms["angles"] += mp.mpf(k) * (theta - mp.mpf(theta0))**2 / 2
    for a, b, c, d, periodicity, k, phase in source["torsions"]:
        b1 = unique_displacement(positions[a], positions[b], box)
        b2 = unique_displacement(positions[b], positions[c], box)
        b3 = unique_displacement(positions[c], positions[d], box)
        n1, n2 = cross(b1, b2), cross(b2, b3)
        phi = mp.atan2(dot(b2, cross(n1, n2)) / norm(b2), dot(n1, n2))
        terms["torsions"] += mp.mpf(k) * (1 + mp.cos(periodicity*phi - mp.mpf(phase)))
    for pair in pair_records(positions, source):
        for term in ("lennard_jones", "coulomb"):
            terms[term] += pair[term]
    return terms


def potential(positions, source=INPUT):
    return mp.fsum(energy_terms(positions, source).values())


def forces(positions, source=INPUT):
    result = []
    for atom, position in enumerate(positions):
        row = []
        for axis, coordinate in enumerate(position):
            def energy_at(value):
                perturbed = [list(p) for p in positions]
                perturbed[atom][axis] = value
                return potential(perturbed, source)
            row.append(-mp.diff(energy_at, coordinate))
        result.append(row)
    return result


def initial_state(source=INPUT):
    x = [[mp.mpf(value) for value in row] for row in source["positions"]]
    v = [[mp.mpf(value) for value in row[1:]] for row in source["particles"]]
    masses = [mp.mpf(row[0]) for row in source["particles"]]
    return x, v, masses


def observables(x, v, masses, source=INPUT):
    kinetic = mp.fsum(masses[i]*dot(v[i], v[i])/2 for i in range(len(x)))
    potential_energy = potential(x, source)
    total_mass = mp.fsum(masses)
    return {"potential_energy": potential_energy, "kinetic_energy": kinetic,
            "total_energy": potential_energy + kinetic,
            "linear_momentum": [mp.fsum(masses[i]*v[i][axis] for i in range(len(x))) for axis in range(3)],
            "center_of_mass": [mp.fsum(masses[i]*x[i][axis] for i in range(len(x)))/total_mass for axis in range(3)]}


def simulate(*, dt=None, steps=None, source=INPUT, positions=None, velocities=None):
    x, v, masses = initial_state(source)
    if positions is not None:
        x = [list(row) for row in positions]
    if velocities is not None:
        v = [list(row) for row in velocities]
    dt = mp.mpf(source["dt"] if dt is None else dt)
    steps = source["steps"] if steps is None else steps
    f = forces(x, source)
    history = [{"step": 0, "positions": x, "velocities": v, "forces": f,
                **observables(x, v, masses, source)}]
    for step in range(1, steps + 1):
        half = [[v[i][axis] + dt*f[i][axis]/(2*mass) for axis in range(3)]
                for i, mass in enumerate(masses)]
        x = [[x[i][axis] + dt*half[i][axis] for axis in range(3)] for i in range(len(x))]
        f = forces(x, source)
        v = [[half[i][axis] + dt*f[i][axis]/(2*mass) for axis in range(3)]
             for i, mass in enumerate(masses)]
        history.append({"step": step, "positions": x, "velocities": v, "forces": f,
                        **observables(x, v, masses, source)})
    return history


def decimal(value):
    return mp.nstr(value, n=PRECISION, strip_zeros=False)


def encode_inputs(source=INPUT):
    encoded = deepcopy(source)
    for stream, start in (("positions", 0), ("particles", 0), ("bonds", 2), ("angles", 3),
                          ("torsions", 5), ("pairs", 2), ("nonbonded", 0), ("exceptions", 3)):
        encoded[stream] = [row[:start] + [binary128_nearest(value) for value in row[start:]]
                           for row in source[stream]]
    for name in ("dt", "switchDistance", "cutoff", "prefactor"):
        encoded[name] = binary128_nearest(source[name])
    encoded["box"] = [binary128_nearest(value) for value in source["box"]]
    return encoded


def generate_payload():
    if mp.__version__ != MPMATH_VERSION:
        raise RuntimeError(f"Expected mpmath {MPMATH_VERSION}, found {mp.__version__}")
    with mp.workdps(PRECISION):
        history = simulate()
        checkpoints = []
        for state in history:
            record = {"step": state["step"]}
            for name in ("positions", "velocities", "forces"):
                record[name + "_decimal"] = [[decimal(value) for value in row] for row in state[name]]
            for name in ("potential_energy", "kinetic_energy", "total_energy"):
                record[name + "_decimal"] = decimal(state[name])
            for name in ("linear_momentum", "center_of_mass"):
                record[name + "_decimal"] = [decimal(value) for value in state[name]]
            record["energy_terms_decimal"] = {name: decimal(value) for name, value in energy_terms(state["positions"]).items()}
            checkpoints.append(record)
        initial_pairs = []
        for record in pair_records(history[0]["positions"]):
            initial_pairs.append({key: value if key in ("atoms", "kind") or value is None else decimal(value)
                                  for key, value in record.items()})
        return {
            "schema_version": "orvia.periodic.reference.v0.4",
            "scope": "Four-atom orthorhombic cutoff-model fixture, not a prepared protein, Ewald model or binding-free-energy calculation.",
            "generator": {"library": "mpmath", "version": MPMATH_VERSION, "decimal_digits": PRECISION,
                          "forces": "Negative mpmath.diff derivatives of independent scalar energy equations",
                          "integrator": "Velocity Verlet with unwrapped positions, without constraints or thermostat"},
            "model": {"geometry": "Orthorhombic nearest images; primitive half-box ties retain remainder sign",
                      "force_domain": "Reject exact half-box components in bonded terms and direct exceptions",
                      "normal_pairs": "Lorentz-Berthelot, quintic-switched LJ, conducting-limit reaction field",
                      "exceptions": "Explicit exclusion or direct uncut LJ/Coulomb override with nearest images",
                      "pair_enumeration": "All unordered atom pairs, lexicographic order"},
            "units": {"position": "nm", "time": "ps", "mass": "Da", "energy": "kJ/mol",
                      "force": "kJ/mol/nm", "angle": "radian"},
            "comparison": {"absolute_tolerance": "1e-25", "relative_tolerance": "1e-24",
                           "note": "Short-fixture engineering criterion, not a production error budget."},
            "input_decimal": deepcopy(INPUT), "inputs": encode_inputs(),
            "initial_pair_classification": initial_pairs, "checkpoints": checkpoints,
        }


def main():
    payload = generate_payload()
    path = Path(__file__).with_name("periodic_reference.json")
    path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {len(payload['checkpoints'])} independent periodic trajectory checkpoints to {path}")


if __name__ == "__main__":
    main()
