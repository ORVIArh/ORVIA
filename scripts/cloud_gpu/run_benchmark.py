#!/usr/bin/env python3
"""Run bounded, local-to-this-machine CUDA checks from a prepared input bundle.

No cloud resources are created or stopped. Runtime limits bound child processes,
not provider billing. This runner does not estimate a full scientific campaign.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


NATIVE_ATOMS = {"complex33": 132935, "solvent33": 151505}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def read_report(path: Path):
    def reject_constant(value):
        raise ValueError("Non-finite JSON constant: " + value)
    return json.loads(path.read_text(), parse_constant=reject_constant)


def verify_bundle(bundle: Path, required: list[Path]) -> dict:
    """Verify the complete declared manifest and all files this runner executes."""
    manifest_path = bundle / "manifest.json"
    manifest = read_report(manifest_path)
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, dict) or not files:
        raise ValueError("manifest.json must contain a nonempty files mapping")
    for path in required:
        relative = path.relative_to(bundle).as_posix()
        if relative not in files:
            raise ValueError("Required file is not declared by manifest: " + relative)
    verified = {}
    for relative, expected in files.items():
        if not isinstance(relative, str) or not relative:
            raise ValueError("Invalid manifest filename")
        path = Path(relative)
        if path.is_absolute() or any(part in {"..", "."} for part in path.parts):
            raise ValueError("Unsafe manifest filename: " + relative)
        full = bundle / path
        if not full.resolve().is_relative_to(bundle):
            raise ValueError("Manifest file escapes bundle: " + relative)
        cursor = bundle
        for part in path.parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise ValueError("Symlink is not accepted in bundle: " + relative)
        if not isinstance(expected, dict) or type(expected.get("bytes")) is not int:
            raise ValueError("Missing manifest byte count: " + relative)
        expected_hash = expected.get("sha256")
        if (not isinstance(expected_hash, str) or len(expected_hash) != 64
                or any(c not in "0123456789abcdef" for c in expected_hash)):
            raise ValueError("Invalid manifest SHA-256: " + relative)
        if not full.is_file() or full.stat().st_size != expected["bytes"]:
            raise ValueError("Manifest byte count mismatch: " + relative)
        actual_hash = digest(full)
        if actual_hash != expected_hash:
            raise ValueError("Manifest SHA-256 mismatch: " + relative)
        verified[relative] = actual_hash
    if verified["scripts/run_benchmark.py"] != digest(Path(__file__)):
        raise ValueError("Executing runner differs from the manifest-bound runner")
    return {"manifest_sha256": digest(manifest_path), "verified_files": len(verified),
            "sha256": verified}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--platform", choices=("CUDA", "Reference"), default="CUDA")
    parser.add_argument("--precisions", default="mixed,double")
    parser.add_argument("--device-index", default="0")
    parser.add_argument("--timeout-seconds", type=float, default=1800)
    parser.add_argument("--step-timeout-seconds", type=float, default=300)
    args = parser.parse_args()
    args.precisions = args.precisions.split(",")
    if (not args.precisions or len(set(args.precisions)) != len(args.precisions)
            or any(p not in {"mixed", "double"} for p in args.precisions)):
        parser.error("--precisions must contain unique mixed,double values")
    if not 0 < args.timeout_seconds <= 1800:
        parser.error("--timeout-seconds must be in (0, 1800]")
    if not 0 < args.step_timeout_seconds <= 300:
        parser.error("--step-timeout-seconds must be in (0, 300]")
    args.bundle_root = args.bundle_root.resolve()
    args.output_dir = args.output_dir.resolve()
    return args


def stop_child(process: subprocess.Popen) -> None:
    """Stop only this runner's child process/group; never a cloud instance."""
    if process.poll() is None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
    process.wait()


def run_step(name: str, argv: list[str], report_path: Path, args, deadline: float):
    started = time.monotonic()
    remaining = deadline - started
    row = {"name": name, "argv": argv, "started_at_utc": now(),
           "report_file": report_path.name, "exitcode": None, "timed_out": False}
    if remaining <= 0:
        row.update(status="skipped", reason="overall_deadline_exhausted", elapsed_seconds=0)
        return row, None
    limit = min(args.step_timeout_seconds, remaining)
    row["subprocess_timeout_seconds"] = limit
    stdout_path = args.output_dir / f"{name}.stdout.log"
    stderr_path = args.output_dir / f"{name}.stderr.log"
    row.update(stdout_file=stdout_path.name, stderr_file=stderr_path.name)
    try:
        with stdout_path.open("x") as stdout, stderr_path.open("x") as stderr:
            process = subprocess.Popen(argv, cwd=args.bundle_root, stdout=stdout, stderr=stderr,
                                       start_new_session=os.name == "posix")
            try:
                row["exitcode"] = process.wait(timeout=limit)
                row["status"] = "exited"
            except subprocess.TimeoutExpired:
                stop_child(process)
                row.update(exitcode=process.returncode, timed_out=True, status="timed_out")
            except BaseException:
                stop_child(process)
                raise
    except Exception as exc:
        row.update(status="launch_error", error={"type": type(exc).__name__, "message": str(exc)[:2000]})
    row["elapsed_seconds"] = time.monotonic() - started
    report = None
    if report_path.is_file():
        row["report_sha256"] = digest(report_path)
        try:
            report = read_report(report_path)
            if not isinstance(report, dict):
                raise ValueError("Expected a JSON object")
            row["report_status"] = report.get("status")
            row["report_hardware_execution_verified"] = report.get("hardware_execution_verified", False)
        except Exception as exc:
            row["report_error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
            report = None
    return row, report


def endpoint_contexts(report: dict | None, platform: str) -> set[str]:
    """A tolerance failure is not the same as an unavailable CUDA context."""
    available = set()
    if report:
        for endpoint in report.get("endpoint_checks", []):
            for config in endpoint.get("configurations", []):
                if config.get("actual_platform") != platform:
                    continue
                if platform == "Reference":
                    available.add("Reference")
                else:
                    precision = config.get("requested_precision")
                    if config.get("actual_properties", {}).get("Precision") == precision:
                        available.add(precision)
    return available


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    if any(args.output_dir.iterdir()):
        print(json.dumps({"status": "output_directory_not_empty",
                          "message": "Use a new empty output directory to preserve prior evidence."}))
        return 2
    summary_path = args.output_dir / "summary.json"
    start = time.monotonic()
    deadline = start + args.timeout_seconds
    summary = {
        "schema_version": "orvia.cloud-gpu-benchmark-run.v1",
        "scope": "Bounded endpoint validation and full-system force-throughput samples only; no molecular trajectory or complete campaign quote.",
        "started_at_utc": now(), "requested_platform": args.platform,
        "requested_precisions": args.precisions, "bundle_root": str(args.bundle_root),
        "runner_sha256": digest(Path(__file__)),
        "limits": {"overall_seconds": args.timeout_seconds,
                   "per_subprocess_seconds": args.step_timeout_seconds,
                   "force_internal_max_wall_seconds": min(120, args.step_timeout_seconds)},
        "steps": [], "input_and_script_sha256": {}, "status": "running",
        "hardware_execution_verified": False, "endpoint_strict_numerical_acceptance": False,
        "endpoint_numerical_checks_passed": False, "full_force_benchmarks_passed": False,
        "scientific_acceptance": False, "production_ready": False,
        "full_simulation_cost": None, "billing_cost": None,
        "cloud_resources_created": False, "automatic_pod_shutdown": False,
        "billing_notice": "Child-process runtime limits do not stop a Pod or bound provider billing.",
        "public_transactions_sent": 0,
    }
    force_reports = []
    force_rows = []
    provenances = {}
    validation = None
    try:
        scripts = args.bundle_root / "scripts"
        endpoint_root = args.bundle_root / "inputs/endpoints"
        required = [scripts / "run_benchmark.py", scripts / "validate_endpoints.py",
                    scripts / "benchmark_system.py"]
        required += [endpoint_root / e / n for e in ("A", "B") for n in ("system.xml", "parameters.json")]
        required += [args.bundle_root / "inputs/full" / leg / n
                     for leg in ("complex33", "solvent33")
                     for n in ("system.xml", "positions.json", "provenance.json")]
        missing = [str(p.relative_to(args.bundle_root)) for p in required if not p.is_file()]
        if missing:
            raise FileNotFoundError("Missing bundle files: " + ", ".join(missing))
        verified = verify_bundle(args.bundle_root, required)
        summary["manifest_sha256"] = verified["manifest_sha256"]
        summary["manifest_verified_files"] = verified["verified_files"]
        summary["input_and_script_sha256"] = verified["sha256"]
        for leg, expected_atoms in NATIVE_ATOMS.items():
            provenance = read_report(args.bundle_root / "inputs/full" / leg / "provenance.json")
            if not isinstance(provenance, dict) or provenance.get("leg") != leg:
                raise ValueError("Full-input provenance leg does not match directory: " + leg)
            native = provenance.get("schema") == "orvia.native-full-size-fixed-coordinate-force-fixture.v1"
            smoke = (args.platform == "Reference" and provenance.get("test_only") is True
                     and provenance.get("schema") == "orvia.runner-reference-smoke.v1")
            if not native and not smoke:
                raise ValueError("Unsupported full-input provenance: " + leg)
            if native and provenance.get("atoms") != expected_atoms:
                raise ValueError("Native atom count does not match leg: " + leg)
            for name in ("system.xml", "positions.json"):
                relative = f"inputs/full/{leg}/{name}"
                record = provenance.get("outputFiles", {}).get(name, {})
                if (record.get("sha256") != verified["sha256"][relative]
                        or record.get("bytes") != (args.bundle_root / relative).stat().st_size):
                    raise ValueError("Provenance output binding mismatch: " + relative)
            provenances[leg] = provenance
        summary["full_input_identity"] = {
            leg: {key: value for key, value in provenance.items()
                  if key in {"schema", "leg", "atoms", "constraints", "scope", "test_only"}}
            for leg, provenance in provenances.items()}
        summary["uses_synthetic_reference_inputs"] = any(p.get("test_only") is True for p in provenances.values())
        write_json(summary_path, summary)
        output = args.output_dir / "endpoints.json"
        command = [sys.executable, str(scripts / "validate_endpoints.py"),
                   "--endpoint-root", str(endpoint_root), "--output", str(output),
                   "--platform", args.platform, "--precisions", ",".join(args.precisions),
                   "--device-index", args.device_index]
        row, validation = run_step("endpoints", command, output, args, deadline)
        summary["steps"].append(row)
        summary["endpoint_strict_numerical_acceptance"] = bool(
            validation and validation.get("strict_numerical_acceptance"))
        summary["endpoint_numerical_checks_passed"] = bool(
            validation and validation.get("numerical_checks_passed"))
        summary["endpoint_validation_status"] = validation.get("status") if validation else None
        available = endpoint_contexts(validation, args.platform)
        summary["contexts_created_by_endpoint_validator"] = sorted(available)
        write_json(summary_path, summary)

        # Reference is one smoke configuration, not two claimed CUDA precision tests.
        precisions = args.precisions if args.platform == "CUDA" else ["mixed"]
        for leg in ("complex33", "solvent33"):
            root = args.bundle_root / "inputs/full" / leg
            for precision in precisions:
                name = f"forces-{leg}-{precision if args.platform == 'CUDA' else 'reference'}"
                if (precision if args.platform == "CUDA" else "Reference") not in available:
                    row = {"name": name, "status": "skipped", "exitcode": None,
                           "reason": "No matching context was created by endpoint validation",
                           "timed_out": False}
                    report = None
                else:
                    output = args.output_dir / f"{name}.json"
                    command = [sys.executable, str(scripts / "benchmark_system.py"),
                               "--system", str(root / "system.xml"), "--positions", str(root / "positions.json"),
                               "--output", str(output), "--platform", args.platform, "--precision", precision,
                               "--mode", "forces", "--warmup", "5", "--steps", "20", "--repeats", "3",
                               "--device-index", args.device_index,
                               "--max-wall-seconds", str(min(120, args.step_timeout_seconds))]
                    row, report = run_step(name, command, output, args, deadline)
                    if report and report.get("passed") is True:
                        inputs = report.get("inputs", {})
                        identity = (inputs.get("particles") == provenances[leg].get("atoms")
                                    and inputs.get("constraints") == provenances[leg].get("constraints")
                                    and inputs.get("system", {}).get("sha256") == verified["sha256"][f"inputs/full/{leg}/system.xml"]
                                    and inputs.get("positions", {}).get("sha256") == verified["sha256"][f"inputs/full/{leg}/positions.json"])
                        row["input_identity_verified"] = identity
                        if not identity:
                            row["report_identity_error"] = "Benchmark inputs differ from the manifest-bound provenance"
                force_rows.append(row)
                force_reports.append(report)
                summary["steps"].append(row)
                write_json(summary_path, summary)

        force_pass = bool(force_reports) and all(
            row.get("exitcode") == 0 and row.get("input_identity_verified") is True
            and report and report.get("passed") is True
            for row, report in zip(force_rows, force_reports))
        summary["full_force_benchmarks_passed"] = force_pass
        summary["hardware_execution_verified"] = args.platform == "CUDA" and force_pass and all(
            report.get("hardware_execution_verified") is True for report in force_reports)
        if args.platform == "Reference":
            summary["status"] = ("completed_reference_smoke" if force_pass and validation
                                 and validation.get("reference_smoke_passed") else "incomplete")
        elif force_pass and summary["endpoint_strict_numerical_acceptance"]:
            summary["status"] = ("completed_cuda_benchmark" if summary["hardware_execution_verified"]
                                 else "incomplete_hardware_verification")
        elif force_pass:
            summary["status"] = (
                "completed_force_benchmarks_with_endpoint_numerical_failure"
                if validation and validation.get("status") == "failed_strict_tolerance"
                else "completed_force_benchmarks_with_endpoint_validation_failure")
        else:
            summary["status"] = "incomplete"
    except Exception as exc:
        summary["status"] = "execution_error"
        summary["error"] = {"type": type(exc).__name__, "message": str(exc)[:2000]}
    finally:
        summary["completed_at_utc"] = now()
        summary["elapsed_seconds"] = time.monotonic() - start
        summary["overall_deadline_reached"] = time.monotonic() >= deadline
        write_json(summary_path, summary)
    print(json.dumps({"status": summary["status"], "summary": str(summary_path),
                      "hardware_execution_verified": summary["hardware_execution_verified"],
                      "scientific_acceptance": False, "full_simulation_cost": None,
                      "automatic_pod_shutdown": False}, indent=2))
    return 0 if summary["status"] in {"completed_reference_smoke", "completed_cuda_benchmark"} else 2


if __name__ == "__main__":
    sys.exit(main())
