#!/usr/bin/env python3
"""Independent high-precision constrained NVE trajectory validation.

Position constraints use a simultaneous nonlinear multiplier solve, not the
contract's sequential bond projections. Velocity constraints use a dense
mass-weighted linear projection. Forces differentiate scalar energies.
This program validates development fixtures; it never supplies on-chain results.
"""
from __future__ import annotations

from copy import deepcopy
import json
import sys

import mpmath as mp

from scalar_random_reference import quad
from generate_periodic_reference import forces, initial_state, observables

PRECISION = 100
mp.mp.dps = PRECISION
ABSOLUTE_TOLERANCE = mp.mpf("1e-18")
RELATIVE_TOLERANCE = mp.mpf("1e-18")


def decode(value):
    if isinstance(value, str) and value.startswith("0x"):
        return quad(value)
    if isinstance(value, list):
        return [decode(v) for v in value]
    if isinstance(value, dict):
        return {k: decode(v) for k, v in value.items()}
    return value


def vector(a, b):
    return [b[i]-a[i] for i in range(3)]


def dot(a, b):
    return mp.fsum(x*y for x, y in zip(a, b))


def position_projection(old, trial, masses, constraints):
    """Solve all squared-length equations simultaneously along old directions."""
    directions = [vector(old[a], old[b]) for a, b, _ in constraints]

    def candidate(multipliers):
        positions = [row.copy() for row in trial]
        for coefficient, (a, b, _), direction in zip(multipliers, constraints, directions):
            for axis in range(3):
                positions[a][axis] += coefficient*direction[axis]/masses[a]
                positions[b][axis] -= coefficient*direction[axis]/masses[b]
        return positions

    def defects(*multipliers):
        positions = candidate(multipliers)
        return tuple(dot(vector(positions[a], positions[b]), vector(positions[a], positions[b]))-length**2
                     for a, b, length in constraints)

    multipliers = mp.findroot(defects, tuple(mp.mpf(0) for _ in constraints),
                              tol=mp.mpf("1e-80"), maxsteps=100)
    result = candidate(list(multipliers))
    if position_residual(result, constraints) > mp.mpf("1e-70"):
        raise AssertionError("Independent nonlinear root failed its residual check")
    # The fixture is a local continuous step, not an orientation-flipping root.
    if any(dot(old_direction, vector(result[a], result[b])) <= 0
           for old_direction, (a, b, _) in zip(directions, constraints)):
        raise AssertionError("Nonlocal position root")
    return result


def velocity_projection(positions, velocities, masses, constraints):
    """v' = v - M^-1 J^T (J M^-1 J^T)^-1 J v."""
    jacobian = mp.matrix(len(constraints), 3*len(masses))
    for row, (a, b, _) in enumerate(constraints):
        for axis, displacement in enumerate(vector(positions[a], positions[b])):
            jacobian[row, 3*a+axis] = -displacement
            jacobian[row, 3*b+axis] = displacement
    inverse_mass = mp.diag([1/mass for mass in masses for _ in range(3)])
    flat = mp.matrix([value for row in velocities for value in row])
    corrected = flat - inverse_mass*jacobian.T*mp.lu_solve(
        jacobian*inverse_mass*jacobian.T, jacobian*flat)
    result = [[corrected[3*i+axis] for axis in range(3)] for i in range(len(masses))]
    if velocity_residual(positions, result, constraints) > mp.mpf("1e-70"):
        raise AssertionError("Independent velocity projection failed its residual check")
    return result


def position_residual(positions, constraints):
    return max(abs(dot(vector(positions[a], positions[b]), vector(positions[a], positions[b]))-length**2)/length**2
               for a, b, length in constraints)


def velocity_residual(positions, velocities, constraints):
    return max(abs(dot(vector(positions[a], positions[b]), vector(velocities[a], velocities[b]))) /
               dot(vector(positions[a], positions[b]), vector(positions[a], positions[b]))
               for a, b, _ in constraints)


def checkpoint(step, x, v, force, masses, constraints, source):
    record = {"step": step, "positions": deepcopy(x), "velocities": deepcopy(v),
              "forces": deepcopy(force), **observables(x, v, masses, source),
              "position_residual": position_residual(x, constraints),
              "velocity_residual": velocity_residual(x, v, constraints)}
    record["energy"] = record["potential_energy"]
    return record


def simulate(payload):
    source = decode(payload["source"])
    constraints = [(int(a), int(b), mp.mpf(decode(length))) for a, b, length in payload["constraints"]]
    x, v, masses = initial_state(source)
    if not constraints or any(not (0 <= a < b < len(x)) or length <= 0 for a, b, length in constraints):
        raise ValueError("Invalid constraints")
    if len({(a, b) for a, b, _ in constraints}) != len(constraints):
        raise ValueError("Duplicate constraints")
    dt = mp.mpf(source["dt"])
    if dt <= 0 or any(mass <= 0 for mass in masses):
        raise ValueError("Invalid mass or timestep")
    position_tolerance = mp.mpf(decode(payload["positionTolerance"]))
    velocity_tolerance = mp.mpf(decode(payload["velocityTolerance"]))
    if position_tolerance <= 0 or velocity_tolerance <= 0:
        raise ValueError("Invalid projection tolerance")
    if position_residual(x, constraints) > position_tolerance or velocity_residual(x, v, constraints) > velocity_tolerance:
        raise ValueError("Initial state violates declared constraints")
    force = forces(x, source)
    history = [checkpoint(0, x, v, force, masses, constraints, source)]
    for step in range(1, int(source["steps"])+1):
        half = [[v[i][axis]+dt*force[i][axis]/(2*masses[i]) for axis in range(3)] for i in range(len(x))]
        trial = [[x[i][axis]+dt*half[i][axis] for axis in range(3)] for i in range(len(x))]
        new_x = position_projection(x, trial, masses, constraints)
        # Constraint impulse from the drift belongs in the intermediate velocity.
        corrected_half = [[half[i][axis]+(new_x[i][axis]-trial[i][axis])/dt for axis in range(3)]
                          for i in range(len(x))]
        force = forces(new_x, source)
        full = [[corrected_half[i][axis]+dt*force[i][axis]/(2*masses[i]) for axis in range(3)]
                for i in range(len(x))]
        v = velocity_projection(new_x, full, masses, constraints)
        x = new_x
        history.append(checkpoint(step, x, v, force, masses, constraints, source))
    return source, constraints, masses, history


def serializable(value):
    if isinstance(value, mp.mpf):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [serializable(v) for v in value]
    if isinstance(value, dict):
        return {k:serializable(v) for k,v in value.items()}
    return value


def metrics(history, masses, dt):
    first = history[0]
    return {
        "maximum_position_residual": max(state["position_residual"] for state in history),
        "maximum_velocity_residual": max(state["velocity_residual"] for state in history),
        "maximum_absolute_total_energy_drift": max(abs(state["total_energy"]-first["total_energy"]) for state in history),
        "maximum_momentum_drift": max(abs(state["linear_momentum"][k]-first["linear_momentum"][k])
                                      for state in history for k in range(3)),
        "maximum_ballistic_center_error": max(abs(state["center_of_mass"][k]-first["center_of_mass"][k]-
                                                   state["step"]*dt*first["linear_momentum"][k]/mp.fsum(masses))
                                              for state in history for k in range(3)),
    }


def generate(payload):
    source, _, masses, history = simulate(payload)
    return serializable({
        "scope": "Short three-atom constrained NVE validation fixture; not a cardiac system or sampled ensemble.",
        "reference": "mpmath 1.3.0 at 100 digits; scalar-energy differentiation, simultaneous SHAKE multiplier roots and dense RATTLE tangent projection",
        "input": deepcopy(payload), "checkpoints": history,
        "metrics": metrics(history, masses, mp.mpf(source["dt"])),
    })


def compare(payload):
    source, constraints, masses, expected = simulate(payload["input"])
    actual = payload["actual"]
    if len(actual) != len(expected):
        raise AssertionError("Checkpoint count mismatch")
    reports, actual_history = [], []
    for got, want in zip(actual, expected):
        if got["step"] != want["step"]:
            raise AssertionError("Step mismatch")
        errors = []
        for field in ["positions", "velocities", "forces"]:
            if len(got[field]) != len(masses) or any(len(row) != 3 for row in got[field]):
                raise AssertionError(f"Malformed {field} dimensions")
            for actual_row, reference_row in zip(got[field], want[field]):
                for a, b in zip(actual_row, reference_row):
                    error = abs(quad(a)-b)
                    if error > ABSOLUTE_TOLERANCE + RELATIVE_TOLERANCE*abs(b):
                        raise AssertionError(f"Step {got['step']} {field}: {error}")
                    errors.append(error)
        error = abs(quad(got["energy"])-want["energy"])
        if error > ABSOLUTE_TOLERANCE+RELATIVE_TOLERANCE*abs(want["energy"]):
            raise AssertionError(f"Step {got['step']} potential energy: {error}")
        errors.append(error)
        values = decode(got)
        state = checkpoint(got["step"], values["positions"], values["velocities"], values["forces"],
                           masses, constraints, source)
        for mode, value in [("position", state["position_residual"]), ("velocity", state["velocity_residual"])]:
            tolerance = mp.mpf(decode(payload["input"][mode+"Tolerance"]))
            if value > tolerance*mp.mpf("1.01") + mp.mpf("1e-30"):
                raise AssertionError(f"Step {got['step']} {mode} residual: {value}")
        actual_history.append(state)
        reports.append({"step": got["step"], "scalar_values_checked": len(errors),
                        "maximum_absolute_error": max(errors), "position_residual": state["position_residual"],
                        "velocity_residual": state["velocity_residual"], "passed": True})
    measured = metrics(actual_history, masses, mp.mpf(source["dt"]))
    if measured["maximum_momentum_drift"] > mp.mpf("1e-25") or measured["maximum_ballistic_center_error"] > mp.mpf("1e-25"):
        raise AssertionError("Actual trajectory violated momentum/center invariant")
    return serializable({"scope": "Local coupled constrained NVE engineering validation, not a production force field.",
                         "reference": "100-digit scalar-force nonlinear-root/linear-projection oracle",
                         "absolute_tolerance": str(ABSOLUTE_TOLERANCE), "relative_tolerance": str(RELATIVE_TOLERANCE),
                         "checkpoints": reports, "actual_metrics": measured,
                         "reference_metrics": metrics(expected, masses, mp.mpf(source["dt"])), "passed": True})


if __name__ == "__main__":
    if mp.__version__ != "1.3.0":
        raise RuntimeError(f"Expected mpmath 1.3.0, found {mp.__version__}")
    mp.mp.dps = PRECISION
    payload = json.load(sys.stdin)
    print(json.dumps(compare(payload) if "actual" in payload else generate(payload), indent=2))
