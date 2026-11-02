#!/usr/bin/env python3
"""Benchmark an explicit OpenMM System and coordinates, without creating a force field.

Example (hardware benchmark only):
  python benchmark_system.py --system system.xml --positions positions.json \
    --platform CUDA --precision mixed --mode forces --output benchmark.json

positions.json is an Nx3 array in nm, or {"positions_nm": Nx3,
"box_vectors_nm": 3x3}. The legacy {"box_nm": [Lx,Ly,Lz]} is accepted.
An optional box must match the XML box; it never silently changes the System.
Forces mode resubmits the same positions, evaluates energy/forces and checks
finiteness every time. It reports evaluations/s, NOT trajectory ns/day.
Integration is opt-in and is not scientific or ensemble validation.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform as host_platform
import shutil
import statistics
import subprocess
import sys
import time
from datetime import datetime, timezone


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with temp.open("wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def write_json(path: Path, value: dict) -> None:
    atomic_bytes(path, (json.dumps(value, indent=2, allow_nan=False) + "\n").encode())


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--system", type=Path, required=True, help="Explicit OpenMM System XML")
    p.add_argument("--positions", type=Path, required=True, help="Coordinates in nm; see module docstring")
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--platform", choices=("CUDA", "Reference"), default="CUDA")
    p.add_argument("--precision", choices=("mixed", "double"), default="mixed")
    p.add_argument("--mode", choices=("forces", "integrate"), default="forces")
    p.add_argument("--warmup", "--warmup-steps", type=int, default=5)
    p.add_argument("--steps", "--steps-per-repeat", type=int, default=20, help="Force evaluations or MD steps per repeat")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--dt-fs", type=float, default=1.0)
    p.add_argument("--integrator", choices=("verlet", "langevin-middle"), default="verlet")
    p.add_argument("--temperature-k", type=float, default=300.0)
    p.add_argument("--friction-per-ps", type=float, default=1.0)
    p.add_argument("--velocity-temperature-k", type=float, default=0.0, help="0 initializes zero velocities; otherwise explicit thermal initialization")
    p.add_argument("--seed", type=int, default=20261102)
    p.add_argument("--device-index", type=int, default=0)
    p.add_argument("--max-wall-seconds", type=float, default=120.0, help="Checked between operations; not a preemptive GPU timeout")
    p.add_argument("--checkpoint-out", type=Path)
    p.add_argument("--checkpoint-in", type=Path)
    args = p.parse_args()
    if not (0 <= args.warmup <= 10000 and 1 <= args.steps <= 10000 and 1 <= args.repeats <= 20
            and args.warmup + args.steps * args.repeats <= 100000):
        p.error("Require warmup 0..10000, steps 1..10000, repeats 1..20 and at most 100000 operations")
    for name in ("dt_fs", "temperature_k", "friction_per_ps", "velocity_temperature_k", "max_wall_seconds"):
        if not math.isfinite(getattr(args, name)):
            p.error(f"{name} must be finite")
    if args.dt_fs <= 0 or args.temperature_k <= 0 or args.friction_per_ps < 0 or args.velocity_temperature_k < 0 or args.max_wall_seconds <= 0:
        p.error("Invalid positive/nonnegative integration or time-budget parameter")
    if not 1 <= args.seed <= 2147483647 or not 0 <= args.device_index <= 255:
        p.error("Seed must be 1..2147483647 and device index 0..255")
    outputs = [x.resolve() for x in (args.output, args.checkpoint_out) if x is not None]
    inputs = [x.resolve() for x in (args.system, args.positions, args.checkpoint_in) if x is not None]
    if len(set(outputs)) != len(outputs) or any(x in inputs for x in outputs):
        p.error("Output paths must be distinct and must not overwrite input files")
    return args


def gpu_inventory() -> dict:
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return {"available": False, "reason": "nvidia-smi not installed; OpenMM context properties remain authoritative"}
    query = "index,uuid,name,memory.total,driver_version,compute_cap"
    try:
        result = subprocess.run([executable, f"--query-gpu={query}", "--format=csv,noheader,nounits"],
                                capture_output=True, text=True, timeout=10, check=False)
        if result.returncode != 0:
            return {"available": False, "reason": "nvidia-smi query failed", "returncode": result.returncode}
        rows = list(csv.reader(io.StringIO(result.stdout)))
        keys = query.split(",")
        if any(len(row) != len(keys) for row in rows):
            return {"available": False, "reason": "Unexpected nvidia-smi result format"}
        return {"available": True, "devices": [dict(zip(keys, (v.strip() for v in row))) for row in rows]}
    except (OSError, subprocess.TimeoutExpired):
        return {"available": False, "reason": "nvidia-smi query unavailable or timed out"}


def main() -> int:
    args = parse_args()
    started = time.perf_counter()
    output = args.output.resolve()
    report = {
        "schema": "orvia.explicit-openmm-hardware-benchmark.v1",
        "status": "in_progress", "passed": False,
        "production_ready": False, "scientific_acceptance": False,
        "scope": "Hardware/performance and finite-value check for a supplied System; no force-field construction or physical acceptance",
        "started_at_utc": datetime.now(timezone.utc).isoformat(),
        "script_sha256": sha256(Path(__file__).read_bytes()),
        "mode": args.mode, "requested_platform": args.platform, "requested_precision": args.precision,
        "reference_test_mode": args.platform == "Reference", "implicit_cpu_fallback": False,
        "hardware_execution_verified": False, "actual_platform": None, "actual_properties": {},
        "host": {"python": sys.version, "system": host_platform.system(), "machine": host_platform.machine()},
        "settings": {k: getattr(args, k) for k in ("warmup", "steps", "repeats", "dt_fs", "integrator", "temperature_k", "friction_per_ps", "velocity_temperature_k", "seed", "device_index", "max_wall_seconds")},
        "timing_policy": {
            "budget": "Checked between operations/repeats; an in-flight GPU call cannot be preempted by this script",
            "forces": "Includes resubmitting identical coordinates, energy+force evaluation/readback, and finite checks; no trajectory advanced",
            "integrate": "Includes integrator.step and final energy synchronization; force/position/velocity validation and checkpoints excluded from integration time",
            "total": "Includes imports, inputs, context setup, warmup, all measured work, validation and checkpoint writes up to final report serialization",
        },
        "repeats": [], "ns_per_day": None, "force_evaluations_per_second": None,
    }
    write_json(output, report)
    context = integrator = None
    try:
        import numpy as np
        import openmm
        from openmm import unit
        report["openmm_version"] = getattr(openmm.version, "full_version", openmm.__version__)
        report["available_platforms"] = [openmm.Platform.getPlatform(i).getName() for i in range(openmm.Platform.getNumPlatforms())]
        xml_bytes = args.system.read_bytes()
        position_bytes = args.positions.read_bytes()
        raw = json.loads(position_bytes)
        coords = raw.get("positions_nm") if isinstance(raw, dict) else raw
        positions = np.asarray(coords, dtype=float)
        if positions.ndim != 2 or positions.shape[1:] != (3,) or len(positions) == 0 or not np.isfinite(positions).all():
            raise ValueError("positions must be a nonempty finite Nx3 array in nm")
        system = openmm.XmlSerializer.deserialize(xml_bytes.decode("utf-8"))
        if not isinstance(system, openmm.System) or system.getNumParticles() != len(positions):
            raise ValueError("System particle count does not match positions")
        box = np.asarray([[v.value_in_unit(unit.nanometer) for v in vector] for vector in system.getDefaultPeriodicBoxVectors()], dtype=float)
        if isinstance(raw, dict):
            boxes = []
            for key in ("box_vectors_nm", "box_nm"):
                if key not in raw:
                    continue
                candidate = np.asarray(raw[key], dtype=float)
                if candidate.shape == (3,):
                    candidate = np.diag(candidate)
                if candidate.shape != (3, 3) or not np.isfinite(candidate).all():
                    raise ValueError(f"{key} must be three lengths or a finite3x3 matrix in nm")
                boxes.append(candidate)
            if any(not np.allclose(candidate, box, rtol=0, atol=1e-9) for candidate in boxes):
                raise ValueError("Input box differs from System XML box (tolerance1e-9nm); refusing silent model change")
        report["inputs"] = {
            "system": {"path": str(args.system.resolve()), "sha256": sha256(xml_bytes)},
            "positions": {"path": str(args.positions.resolve()), "sha256": sha256(position_bytes)},
            "particles": system.getNumParticles(), "constraints": system.getNumConstraints(),
            "periodic": bool(system.usesPeriodicBoundaryConditions()), "box_vectors_nm": box.tolist(),
            "forces": [{"class": system.getForce(i).__class__.__name__, "group": system.getForce(i).getForceGroup()} for i in range(system.getNumForces())],
        }
        # An explicit name lookup must succeed. There is no default/CPU fallback.
        platform = openmm.Platform.getPlatformByName(args.platform)
        names = list(platform.getPropertyNames())
        props = {}
        if args.platform == "CUDA":
            if "Precision" not in names or "DeviceIndex" not in names:
                raise RuntimeError("CUDA platform lacks explicit precision/device properties")
            props = {"Precision": args.precision, "DeviceIndex": str(args.device_index)}
        if args.integrator == "verlet":
            integrator = openmm.VerletIntegrator(args.dt_fs * unit.femtosecond)
        else:
            integrator = openmm.LangevinMiddleIntegrator(args.temperature_k * unit.kelvin, args.friction_per_ps / unit.picosecond, args.dt_fs * unit.femtosecond)
            integrator.setRandomNumberSeed(args.seed)
        integrator_xml = openmm.XmlSerializer.serialize(integrator).encode()
        report["integrator_sha256"] = sha256(integrator_xml)
        context_started = time.perf_counter()
        context = openmm.Context(system, integrator, platform, props)
        if context.getPlatform().getName() != args.platform:
            raise RuntimeError("Created context does not use requested platform")
        actual_props = {name: platform.getPropertyValue(context, name) for name in names}
        if args.platform == "CUDA" and (actual_props.get("Precision") != args.precision or not actual_props.get("DeviceName")):
            raise RuntimeError("CUDA context precision/device identity could not be verified")
        report["actual_platform"] = context.getPlatform().getName()
        report["actual_properties"] = actual_props
        report["precision_applied"] = args.platform == "CUDA"
        report["platform"] = {"name": context.getPlatform().getName(), "properties": actual_props, "gpu_inventory": gpu_inventory() if args.platform == "CUDA" else {"available": False, "reason": "Explicit Reference test mode"}, "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES")}
        report["context_setup_seconds"] = time.perf_counter() - context_started
        config = {"system_sha256": sha256(xml_bytes), "positions_sha256": sha256(position_bytes), "integrator_sha256": sha256(integrator_xml), "platform": args.platform, "precision": actual_props.get("Precision"), "openmm_version": report["openmm_version"], "mode": args.mode, "initial_velocity_temperature_k": args.velocity_temperature_k, "seed": args.seed}
        completed_before = 0
        if args.checkpoint_in is not None:
            checkpoint = args.checkpoint_in.read_bytes()
            meta = json.loads(Path(str(args.checkpoint_in) + ".json").read_text())
            if meta.get("configuration") != config or meta.get("checkpoint_sha256") != sha256(checkpoint):
                raise ValueError("Checkpoint hash/configuration mismatch")
            context.loadCheckpoint(checkpoint)
            completed_before = int(meta["completed_operations"])
            if completed_before < 0:
                raise ValueError("Invalid checkpoint operation count")
            report["resumed_checkpoint"] = {"sha256": sha256(checkpoint), "completed_operations": completed_before}
        else:
            context.setPositions(positions * unit.nanometer)
            if args.velocity_temperature_k:
                context.setVelocitiesToTemperature(args.velocity_temperature_k * unit.kelvin, args.seed)
            else:
                context.setVelocities(np.zeros_like(positions) * unit.nanometer / unit.picosecond)
        fixed_positions = positions * unit.nanometer

        def budget() -> None:
            if time.perf_counter() - started > args.max_wall_seconds:
                raise TimeoutError("Wall-time budget exceeded between operations")

        def validate(state, include_kinematics=False) -> dict:
            potential = float(state.getPotentialEnergy().value_in_unit(unit.kilojoule_per_mole))
            forces = np.asarray(state.getForces(asNumpy=True).value_in_unit(unit.kilojoule_per_mole / unit.nanometer))
            if not math.isfinite(potential) or forces.shape != positions.shape or not np.isfinite(forces).all():
                raise FloatingPointError("Nonfinite potential energy or forces")
            values = {"potential_kj_per_mol": potential, "maximum_abs_force_kj_per_mol_nm": float(np.max(np.abs(forces))), "all_finite": True}
            if include_kinematics:
                kinetic = float(state.getKineticEnergy().value_in_unit(unit.kilojoule_per_mole))
                pos = np.asarray(state.getPositions(asNumpy=True).value_in_unit(unit.nanometer))
                vel = np.asarray(state.getVelocities(asNumpy=True).value_in_unit(unit.nanometer / unit.picosecond))
                if not math.isfinite(kinetic) or not np.isfinite(pos).all() or not np.isfinite(vel).all():
                    raise FloatingPointError("Nonfinite kinetic energy, positions or velocities")
                values["kinetic_kj_per_mol"] = kinetic
            values["simulation_time_ps"] = float(state.getTime().value_in_unit(unit.picosecond))
            return values

        def force_operation() -> dict:
            # Force a genuine re-evaluation, while retaining the same coordinates.
            context.setPositions(fixed_positions)
            return validate(context.getState(getEnergy=True, getForces=True))

        report["initial_state"] = validate(context.getState(getEnergy=True, getForces=True, getPositions=True, getVelocities=True), True)
        report["hardware_execution_verified"] = args.platform == "CUDA"
        report["extra_initial_validation_evaluations"] = 1
        budget()
        warm_started = time.perf_counter()
        if args.mode == "forces":
            for _ in range(args.warmup):
                budget()
                force_operation()
        elif args.warmup:
            integrator.step(args.warmup)
            validate(context.getState(getEnergy=True, getForces=True, getPositions=True, getVelocities=True), True)
        report["warmup_elapsed_seconds"] = time.perf_counter() - warm_started
        measured_elapsed = 0.0
        completed = args.warmup
        for repeat in range(args.repeats):
            budget()
            tick = time.perf_counter()
            if args.mode == "forces":
                for _ in range(args.steps):
                    budget()
                    last = force_operation()
            else:
                integrator.step(args.steps)
                # Include a final energy synchronization so asynchronous GPU work
                # cannot escape the timed region.
                context.getState(getEnergy=True)
            elapsed = time.perf_counter() - tick
            if args.mode == "integrate":
                last = validate(context.getState(getEnergy=True, getForces=True, getPositions=True, getVelocities=True), True)
            measured_elapsed += elapsed
            completed += args.steps
            row = {"repeat": repeat, "operations": args.steps, "elapsed_seconds": elapsed, "finite_state": last}
            if args.mode == "forces":
                row["force_evaluations_per_second"] = args.steps / elapsed
                row["ns_per_day"] = None
            else:
                row["simulated_ns"] = args.steps * args.dt_fs / 1e6
                row["ns_per_day"] = row["simulated_ns"] / elapsed * 86400
            report["repeats"].append(row)
            report["completed_operations_this_run"] = completed
            report["measured_operations"] = args.steps * (repeat + 1)
            if args.checkpoint_out is not None:
                checkpoint = context.createCheckpoint()
                meta = {"schema": "orvia.openmm-benchmark-checkpoint.v1", "configuration": config, "completed_operations": completed_before + completed, "checkpoint_sha256": sha256(checkpoint), "portable_across_hardware": False}
                atomic_bytes(args.checkpoint_out, checkpoint)
                write_json(Path(str(args.checkpoint_out) + ".json"), meta)
                report["checkpoint"] = {"path": str(args.checkpoint_out.resolve()), **meta}
            report["total_elapsed_seconds"] = time.perf_counter() - started
            write_json(output, report)
            budget()
        count = args.steps * args.repeats
        report["measured_elapsed_seconds"] = measured_elapsed
        report["integration_elapsed_seconds"] = measured_elapsed if args.mode == "integrate" else None
        report["force_evaluation_elapsed_seconds"] = measured_elapsed if args.mode == "forces" else None
        report["total_elapsed_seconds"] = time.perf_counter() - started
        report["measured_operations"] = count
        report["completed_operations_this_run"] = completed
        if args.mode == "forces":
            report["force_evaluations_per_second"] = count / measured_elapsed
            report["force_rate_stddev"] = statistics.pstdev(x["force_evaluations_per_second"] for x in report["repeats"])
            report["simulated_ns"] = 0.0
        else:
            report["simulated_ns"] = count * args.dt_fs / 1e6
            report["ns_per_day"] = report["simulated_ns"] / measured_elapsed * 86400
            report["end_to_end_measured_ns_per_day"] = report["simulated_ns"] / report["total_elapsed_seconds"] * 86400
        # Ensure supplied inputs were not changed during a long benchmark.
        if sha256(args.system.read_bytes()) != config["system_sha256"] or sha256(args.positions.read_bytes()) != config["positions_sha256"]:
            raise RuntimeError("Input files changed during benchmark")
        report["passed"] = True
        report["status"] = "passed_reference_test_only" if args.platform == "Reference" else "passed_cuda_hardware_benchmark_only"
    except (Exception, KeyboardInterrupt) as error:
        report["status"] = "failed"
        report["error"] = {"type": type(error).__name__, "message": str(error)[:2000]}
        report["total_elapsed_seconds"] = time.perf_counter() - started
    finally:
        if context is not None:
            del context
        if integrator is not None:
            del integrator
        write_json(output, report)
    print(json.dumps({"status": report["status"], "passed": report["passed"], "output": str(output), "platform": args.platform, "mode": args.mode, "ns_per_day": report["ns_per_day"], "force_evaluations_per_second": report["force_evaluations_per_second"], "production_ready": False}))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
