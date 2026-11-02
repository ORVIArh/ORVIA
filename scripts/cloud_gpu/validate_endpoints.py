#!/usr/bin/env python3
"""Compare prepared ligand endpoints on CUDA with OpenMM Reference.

This is a bounded external numerical validation, not a full-model simulation,
an on-chain result, or permission to provision cloud hardware. Reference mode
is provided only to exercise the validator locally without claiming GPU work.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import platform as host_platform
import subprocess
import sys
import time


# Identical to validate_local_gpu.py; fixed before either endpoint is evaluated.
TOLERANCES = {
    "energy_absolute_kJ_mol": 0.01,
    "force_max_absolute_kJ_mol_nm": 0.05,
    "force_relative_L2": 5e-5,
    "trajectory_position_RMS_nm": 1e-5,
}
ENERGY_FORCE_KEYS = tuple(k for k in TOLERANCES if not k.startswith("trajectory"))
EXPECTED_ATOMS = {"A": 41, "B": 44}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def gpu_inventory() -> dict:
    """Read-only optional inventory; CUDA context properties identify execution."""
    command = [
        "nvidia-smi",
        "--query-gpu=index,name,uuid,driver_version,memory.total",
        "--format=csv,noheader,nounits",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "reason": type(exc).__name__}
    return {
        "available": result.returncode == 0,
        "returncode": result.returncode,
        "columns": ["index", "name", "uuid", "driver_version", "memory_total_MiB"],
        "csv_rows": result.stdout.strip().splitlines() if result.returncode == 0 else [],
        "note": "Inventory only; indices may be remapped by CUDA visibility settings.",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--platform", choices=("CUDA", "Reference"), default="CUDA")
    parser.add_argument("--precisions", default="mixed,double",
                        help="Comma-separated CUDA modes; ignored in Reference smoke mode.")
    parser.add_argument("--device-index", default="0")
    args = parser.parse_args()
    args.precisions = args.precisions.split(",")
    if (not args.precisions or len(set(args.precisions)) != len(args.precisions)
            or any(p not in {"single", "mixed", "double"} for p in args.precisions)):
        parser.error("--precisions must contain unique single,mixed,double values")
    return args


def validate_configuration(mm, np, unit, system_xml: str, positions, precision, args) -> dict:
    started = time.perf_counter()
    row = {
        "requested_platform": args.platform,
        "requested_precision": precision,
        "reference_platform": "Reference",
        "hardware_execution_verified": False,
        "scenarios": [],
        "passed": False,
    }
    contexts, integrators = [], []
    stage = "create_contexts"

    def observe(context):
        state = context.getState(getEnergy=True, getForces=True)
        energy = float(state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole))
        force = np.asarray(state.getForces(asNumpy=True).value_in_unit(
            unit.kilojoule_per_mole / unit.nanometer), dtype=float)
        if not math.isfinite(energy) or not np.isfinite(force).all():
            raise FloatingPointError("Non-finite energy or force")
        return energy, force

    def metrics(reference, target):
        re, rf = reference
        te, tf = target
        diff = tf - rf
        result = {
            "energy_absolute_kJ_mol": abs(te - re),
            "force_max_absolute_kJ_mol_nm": float(np.max(np.abs(diff))),
            "force_relative_L2": float(np.linalg.norm(diff) / max(np.linalg.norm(rf), 1e-12)),
            "reference_energy_kJ_mol": re,
            "target_energy_kJ_mol": te,
            "reference_force_L2": float(np.linalg.norm(rf)),
        }
        if not all(math.isfinite(v) for v in result.values()):
            raise FloatingPointError("Non-finite comparison metric")
        result["finite"] = True
        result["passed"] = all(result[k] <= TOLERANCES[k] for k in ENERGY_FORCE_KEYS)
        return result

    try:
        target_properties = ({"Precision": precision, "DeviceIndex": args.device_index}
                             if args.platform == "CUDA" else {})
        for name, properties in (("Reference", {}), (args.platform, target_properties)):
            integrator = mm.VerletIntegrator(0.0002 * unit.picoseconds)
            integrators.append(integrator)
            context = mm.Context(mm.XmlSerializer.deserialize(system_xml), integrator,
                                 mm.Platform.getPlatformByName(name), properties)
            contexts.append(context)
        target_platform = contexts[1].getPlatform()
        row["actual_platform"] = target_platform.getName()
        row["actual_properties"] = {
            key: target_platform.getPropertyValue(contexts[1], key)
            for key in target_platform.getPropertyNames()
        }
        if row["actual_platform"] != args.platform:
            raise RuntimeError("Requested platform was not used")
        if args.platform == "CUDA" and row["actual_properties"].get("Precision") != precision:
            raise RuntimeError("Requested CUDA precision was not used")

        stage = "energy_force_scenarios"
        rng = np.random.default_rng(9917)
        for index in range(9):
            sample = positions if index == 0 else positions + rng.normal(0, 0.002, positions.shape)
            for context in contexts:
                context.setPositions(sample * unit.nanometer)
            result = metrics(observe(contexts[0]), observe(contexts[1]))
            row["hardware_execution_verified"] = args.platform == "CUDA"
            result["scenario"] = "original" if index == 0 else f"perturbation_{index}"
            row["scenarios"].append(result)

        stage = "deterministic_short_trajectory"
        for context in contexts:
            context.setPositions(positions * unit.nanometer)
            context.setVelocities(np.zeros(positions.shape) * unit.nanometer / unit.picosecond)
        for integrator in integrators:
            integrator.step(20)
        trajectory_positions = [
            np.asarray(context.getState(getPositions=True).getPositions(asNumpy=True)
                       .value_in_unit(unit.nanometer), dtype=float)
            for context in contexts
        ]
        if not all(np.isfinite(p).all() for p in trajectory_positions):
            raise FloatingPointError("Non-finite trajectory coordinates")
        rms = float(np.sqrt(np.mean((trajectory_positions[1] - trajectory_positions[0]) ** 2)))
        if not math.isfinite(rms):
            raise FloatingPointError("Non-finite trajectory RMS difference")
        final = metrics(observe(contexts[0]), observe(contexts[1]))
        row["deterministic_short_trajectory"] = {
            "steps": 20, "dt_ps": 0.0002, "initial_velocities": "zero",
            "position_RMS_difference_nm": rms, "final_comparison": final,
            "finite": True,
            "passed": rms <= TOLERANCES["trajectory_position_RMS_nm"] and final["passed"],
        }

        stage = "target_minimized_fixture"
        contexts[1].setPositions(positions * unit.nanometer)
        mm.LocalEnergyMinimizer.minimize(
            contexts[1], 1.0 * unit.kilojoule_per_mole / unit.nanometer, 1000)
        minimized = contexts[1].getState(getPositions=True).getPositions(asNumpy=True)
        if not np.isfinite(np.asarray(minimized.value_in_unit(unit.nanometer))).all():
            raise FloatingPointError("Non-finite minimized coordinates")
        contexts[0].setPositions(minimized)
        row["target_minimized_fixture"] = metrics(observe(contexts[0]), observe(contexts[1]))
        row["target_minimized_fixture"].update({
            "maximum_iterations": 1000, "force_tolerance_kJ_mol_nm": 1.0,
            "scope": "Compare both engines at target-minimized coordinates; no convergence claim.",
        })
        row["passed"] = (all(r["passed"] for r in row["scenarios"])
                         and row["deterministic_short_trajectory"]["passed"]
                         and row["target_minimized_fixture"]["passed"])
        row["status"] = "passed" if row["passed"] else "failed_strict_tolerance"
    except Exception as exc:
        row["status"] = "failed_nonfinite" if isinstance(exc, FloatingPointError) else "execution_error"
        row["error"] = {"stage": stage, "type": type(exc).__name__, "message": str(exc)[:2000]}
    finally:
        contexts.clear()
        integrators.clear()
        row["elapsed_seconds"] = time.perf_counter() - started
    return row


def main() -> int:
    args = parse_args()
    report = {
        "schema_version": "orvia.cuda-endpoint-validation.v1",
        "started_at_utc": utc_now(),
        "scope": "External 41/44-atom ligand-endpoint numerical checks only; no full cardiac model, on-chain calculation, or scientific sampling acceptance.",
        "validator_sha256": sha256(Path(__file__).read_bytes()),
        "requested_platform": args.platform,
        "requested_precisions": args.precisions,
        "tolerances_predeclared": dict(TOLERANCES),
        "perturbation_seed": 9917,
        "perturbation_standard_deviation_nm": 0.002,
        "python_version": host_platform.python_version(),
        "openmm_version": None,
        "available_platforms": [],
        "endpoint_checks": [],
        "hardware_execution_verified": False,
        "numerical_checks_passed": False,
        "strict_numerical_acceptance": False,
        "reference_smoke_passed": False,
        "production_ready": False,
        "public_transactions_sent": 0,
        "status": "execution_error",
    }
    started = time.perf_counter()
    try:
        import numpy as np
        import openmm as mm
        from openmm import unit

        report["openmm_version"] = mm.version.full_version
        report["numpy_version"] = np.__version__
        report["available_platforms"] = [mm.Platform.getPlatform(i).getName()
                                         for i in range(mm.Platform.getNumPlatforms())]
        report["nvidia_smi_inventory"] = (gpu_inventory() if args.platform == "CUDA"
                                         else {"queried": False, "reason": "Reference smoke mode"})
        for endpoint, expected_atoms in EXPECTED_ATOMS.items():
            row = {"endpoint": endpoint, "expected_atoms": expected_atoms, "passed": False,
                   "input_sha256": {}, "configurations": []}
            try:
                path = args.endpoint_root / endpoint
                files = {name: (path / name).read_bytes() for name in ("system.xml", "parameters.json")}
                row["input_sha256"] = {name: sha256(data) for name, data in files.items()}
                params = json.loads(files["parameters.json"])
                positions = np.asarray(params["positions_nm"], dtype=float)
                row["atoms"] = params["atom_count"]
                if row["atoms"] != expected_atoms or positions.shape != (expected_atoms, 3):
                    raise ValueError("Endpoint atom count or coordinate shape is incorrect")
                if not np.isfinite(positions).all():
                    raise FloatingPointError("Non-finite input coordinates")
                xml = files["system.xml"].decode("utf-8")
                if mm.XmlSerializer.deserialize(xml).getNumParticles() != expected_atoms:
                    raise ValueError("OpenMM system particle count does not match endpoint")
                for precision in args.precisions if args.platform == "CUDA" else [None]:
                    row["configurations"].append(validate_configuration(
                        mm, np, unit, xml, positions, precision, args))
                row["passed"] = all(c["passed"] for c in row["configurations"])
            except Exception as exc:
                row["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
            report["endpoint_checks"].append(row)
        report["numerical_checks_passed"] = (len(report["endpoint_checks"]) == 2
                                             and all(e["passed"] for e in report["endpoint_checks"]))
        configurations = [c for e in report["endpoint_checks"] for c in e["configurations"]]
        report["hardware_execution_verified"] = (
            args.platform == "CUDA" and len(configurations) == 2 * len(args.precisions)
            and all(c["hardware_execution_verified"] for c in configurations))
        report["strict_numerical_acceptance"] = (
            report["numerical_checks_passed"] and report["hardware_execution_verified"])
        report["reference_smoke_passed"] = args.platform == "Reference" and report["numerical_checks_passed"]
        if report["strict_numerical_acceptance"]:
            report["status"] = "passed_cuda_strict_tolerances"
        elif report["reference_smoke_passed"]:
            report["status"] = "passed_reference_smoke_only"
        elif any("error" in e or any("error" in c for c in e["configurations"])
                 for e in report["endpoint_checks"]):
            report["status"] = "execution_error"
        else:
            report["status"] = "failed_strict_tolerance"
    except Exception as exc:
        report["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
    report["completed_at_utc"] = utc_now()
    report["elapsed_seconds"] = time.perf_counter() - started
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"status": report["status"], "report": str(args.output),
                      "hardware_execution_verified": report["hardware_execution_verified"],
                      "strict_numerical_acceptance": report["strict_numerical_acceptance"],
                      "production_ready": False}, indent=2))
    return 0 if report["strict_numerical_acceptance"] or report["reference_smoke_passed"] else 2


if __name__ == "__main__":
    sys.exit(main())
