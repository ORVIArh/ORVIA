#!/usr/bin/env python3
"""Attribute native GPU parameter rounding and test the endpoint binary64 path.

The immutable native System is always the Reference oracle. No tolerance,
force-field parameter, input coordinate, or scientific model is changed.
Reference mode tests representation equivalence only, never GPU execution.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time

from precision_system import endpoint_system
from validate_endpoints import TOLERANCES, EXPECTED_ATOMS, gpu_inventory


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compare(np, ref, other):
    re, rf = ref
    te, tf = other
    diff = tf - rf
    row = {
        "energy_absolute_kJ_mol": abs(te - re),
        "force_max_absolute_kJ_mol_nm": float(np.max(np.abs(diff))),
        "force_relative_L2": float(np.linalg.norm(diff) / max(np.linalg.norm(rf), 1e-12)),
        "reference_energy_kJ_mol": re,
        "target_energy_kJ_mol": te,
        "reference_force_L2": float(np.linalg.norm(rf)),
        "force_difference_L2": float(np.linalg.norm(diff)),
    }
    if not all(math.isfinite(v) for v in row.values()):
        raise FloatingPointError("Non-finite numerical comparison")
    row["passed"] = all(row[k] <= v for k, v in TOLERANCES.items()
                        if not k.startswith("trajectory"))
    return row


def check_endpoint(mm, np, unit, path, endpoint, args):
    started = time.perf_counter()
    row = {"endpoint": endpoint, "passed": False, "hardware_execution_verified": False}
    contexts, integrators = {}, {}
    try:
        xml = (path / "system.xml").read_bytes()
        params = (path / "parameters.json").read_bytes()
        row["input_sha256"] = {"system.xml": sha(xml), "parameters.json": sha(params)}
        source = mm.XmlSerializer.deserialize(xml.decode())
        positions = np.asarray(json.loads(params)["positions_nm"], dtype=float)
        row["atoms"] = source.getNumParticles()
        if row["atoms"] != EXPECTED_ATOMS[endpoint] or positions.shape != (row["atoms"], 3):
            raise ValueError("Unexpected endpoint identity or coordinate shape")
        if not np.isfinite(positions).all():
            raise FloatingPointError("Non-finite input coordinates")
        repaired = endpoint_system(mm, unit, source)
        surrogate = endpoint_system(mm, unit, source, emulate_gpu_rounding=True)
        row["repaired_system_sha256"] = sha(mm.XmlSerializer.serialize(repaired).encode())
        row["rounding_surrogate_system_sha256"] = sha(mm.XmlSerializer.serialize(surrogate).encode())
        systems = {"reference": source, "native": mm.XmlSerializer.deserialize(xml.decode()),
                   "repaired": repaired, "rounding_surrogate": surrogate}
        row["platforms"] = {}
        for name, system in systems.items():
            platform = args.platform if name in {"native", "repaired"} else "Reference"
            properties = {"Precision": args.precision, "DeviceIndex": args.device_index} if platform in {"CUDA", "OpenCL"} else {}
            integrators[name] = mm.VerletIntegrator(0.0002)
            contexts[name] = mm.Context(system, integrators[name], mm.Platform.getPlatformByName(platform), properties)
            p = contexts[name].getPlatform()
            row["platforms"][name] = {"name": p.getName(), "properties": {
                k: p.getPropertyValue(contexts[name], k) for k in p.getPropertyNames()}}
            if p.getName() != platform:
                raise RuntimeError("Implicit platform fallback")
            if properties and row["platforms"][name]["properties"].get("Precision") != args.precision:
                raise RuntimeError("Requested precision not used")

        def observe(name, group=-1):
            s = contexts[name].getState(getEnergy=True, getForces=True, groups=group)
            energy = float(s.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole))
            forces = np.asarray(s.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole / unit.nanometer))
            if not math.isfinite(energy) or not np.isfinite(forces).all():
                raise FloatingPointError("Non-finite energy or force")
            return energy, forces

        def group_comparisons():
            groups = sorted({f.getForceGroup() for f in source.getForces()})
            return {str(g): {name: compare(np, observe("reference", 1 << g), observe(name, 1 << g))
                            for name in ("native", "repaired", "rounding_surrogate")}
                    for g in groups}

        rng = np.random.default_rng(9917)
        row["scenarios"] = []
        for i in range(9):
            sample = positions if i == 0 else positions + rng.normal(0, 0.002, positions.shape)
            for c in contexts.values():
                c.setPositions(sample)
            ref = observe("reference")
            result = {name: compare(np, ref, observe(name)) for name in ("native", "repaired", "rounding_surrogate")}
            result["scenario"] = "original" if i == 0 else "perturbation_" + str(i)
            row["scenarios"].append(result)
            if i == 0:
                row["hardware_execution_verified"] = args.platform == "CUDA"
                row["original_force_groups"] = group_comparisons()

        # Keep the native Reference trajectory as the oracle for both paths.
        for name in ("reference", "native", "repaired"):
            contexts[name].setPositions(positions)
            contexts[name].setVelocities(np.zeros(positions.shape))
            integrators[name].step(20)
        trajectory_positions = {name: np.asarray(contexts[name].getState(getPositions=True)
            .getPositions(asNumpy=True).value_in_unit(unit.nanometer)) for name in ("reference", "native", "repaired")}
        row["deterministic_short_trajectory"] = {"steps": 20, "dt_ps": 0.0002, "initial_velocities": "zero"}
        for name in ("native", "repaired"):
            if not np.isfinite(trajectory_positions[name]).all():
                raise FloatingPointError("Non-finite trajectory coordinates")
            rms = float(np.sqrt(np.mean((trajectory_positions[name] - trajectory_positions["reference"])**2)))
            result = compare(np, observe("reference"), observe(name))
            result["position_RMS_difference_nm"] = rms
            result["passed"] = result["passed"] and rms <= TOLERANCES["trajectory_position_RMS_nm"]
            row["deterministic_short_trajectory"][name] = result

        # At BOTH target minima compare all paths at exactly the same positions.
        row["minimized_fixtures"] = {}
        for minimized_by in ("native", "repaired", "rounding_surrogate"):
            contexts[minimized_by].setPositions(positions)
            mm.LocalEnergyMinimizer.minimize(contexts[minimized_by], 1.0, 1000)
            p = np.asarray(contexts[minimized_by].getState(getPositions=True).getPositions(asNumpy=True)
                           .value_in_unit(unit.nanometer))
            if not np.isfinite(p).all():
                raise FloatingPointError("Non-finite minimized coordinates")
            for c in contexts.values():
                c.setPositions(p)
            ref = observe("reference")
            row["minimized_fixtures"][minimized_by] = {
                "positions_nm": p.tolist(),
                "comparisons": {name: compare(np, ref, observe(name)) for name in ("native", "repaired", "rounding_surrogate")},
                "force_groups": group_comparisons(),
            }
        repaired_checks = [s["repaired"]["passed"] for s in row["scenarios"]]
        repaired_checks += [row["deterministic_short_trajectory"]["repaired"]["passed"]]
        repaired_checks += [v["comparisons"]["repaired"]["passed"] for v in row["minimized_fixtures"].values()]
        row["passed"] = all(repaired_checks)
        row["status"] = "passed_repaired_path" if row["passed"] else "failed_strict_tolerance"
    except Exception as exc:
        row["status"] = "execution_error"
        row["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
    finally:
        contexts.clear()
        integrators.clear()
        row["elapsed_seconds"] = time.perf_counter() - started
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--platform", choices=("CUDA", "OpenCL", "Reference"), default="CUDA")
    parser.add_argument("--precision", choices=("double", "mixed", "single"), default="double")
    parser.add_argument("--device-index", default="0")
    parser.add_argument("--prior-cuda-report", type=Path)
    args = parser.parse_args()
    report = {
        "schema": "orvia.endpoint-precision-repair.v1", "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "requested_platform": args.platform, "requested_precision": args.precision,
        "tolerances_predeclared": dict(TOLERANCES), "perturbation_seed": 9917,
        "scope": "41/44-atom endpoint diagnostic; native immutable Reference oracle. Not a full-model/PME implementation.",
        "repaired_hamiltonian_parameter_change": False, "tolerance_change": False,
        "rounding_surrogate_intentionally_quantizes_parameters": True,
        "minimization": {"force_tolerance_kJ_mol_nm": 1.0, "maximum_iterations": 1000,
                         "convergence_claim": False},
        "production_ready": False,
        "scientific_acceptance": False, "hardware_execution_verified": False, "strict_cuda_acceptance": False,
        "source_sha256": {name: sha((Path(__file__).parent / name).read_bytes()) for name in
                          ("precision_diagnostics.py", "precision_system.py", "validate_endpoints.py")},
        "upstream_source_commit": "b399af4", "endpoints": [], "status": "execution_error",
    }
    try:
        import numpy as np
        import openmm as mm
        from openmm import unit
        report["openmm_version"] = mm.version.full_version
        report["numpy_version"] = np.__version__
        report["gpu_inventory"] = gpu_inventory() if args.platform == "CUDA" else {"queried": False}
        for name in EXPECTED_ATOMS:
            report["endpoints"].append(check_endpoint(mm, np, unit, args.endpoint_root / name, name, args))
        passed = all(e["passed"] for e in report["endpoints"])
        report["hardware_execution_verified"] = all(e["hardware_execution_verified"] for e in report["endpoints"])
        report["strict_cuda_acceptance"] = passed and report["hardware_execution_verified"]
        report["status"] = ("passed_cuda_endpoint_repair" if report["strict_cuda_acceptance"] else
                            "passed_reference_equivalence_only" if passed and args.platform == "Reference" else
                            "passed_opencl_endpoint_repair_only" if passed else "failed")
        if args.prior_cuda_report:
            prior_bytes = args.prior_cuda_report.read_bytes()
            prior = json.loads(prior_bytes)
            report["prior_cuda_report_sha256"] = sha(prior_bytes)
            agreement = []
            for endpoint in report["endpoints"]:
                prior_e = next(e for e in prior["endpoint_checks"] if e["endpoint"] == endpoint["endpoint"])
                if prior_e["input_sha256"] != endpoint["input_sha256"]:
                    raise ValueError("Prior CUDA report used different endpoint inputs")
                prior_c = next(c for c in prior_e["configurations"] if c["requested_precision"] == "double")
                for old, new in zip(prior_c["scenarios"], endpoint["scenarios"], strict=True):
                    if old["scenario"] != new["scenario"]:
                        raise ValueError("Prior CUDA scenario mismatch")
                    agreement.append({"endpoint": endpoint["endpoint"], "scenario": old["scenario"],
                        "absolute_difference_between_error_metrics": {k: abs(old[k] - new["rounding_surrogate"][k])
                            for k in TOLERANCES if not k.startswith("trajectory")}})
            report["rounding_surrogate_agreement_with_prior_cuda"] = agreement
        report["passed"] = passed
    except Exception as exc:
        report["status"] = "execution_error"
        report["passed"] = False
        report["strict_cuda_acceptance"] = False
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"status": report["status"], "output": str(args.output),
                      "strict_cuda_acceptance": report["strict_cuda_acceptance"]}))
    return 0 if report.get("passed") else 2


if __name__ == "__main__":
    raise SystemExit(main())
