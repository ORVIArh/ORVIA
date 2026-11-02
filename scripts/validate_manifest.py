#!/usr/bin/env python3
"""Validate the ORVIA design manifest; readiness is a separate, stricter gate.

This checks a declared architecture, not scientific correctness or deployability.
Use --require-ready to reject the intentionally incomplete current design.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import sys

EXPECTED_COUNTS = {
    "control": 4, "compute": 24, "input_storage": 16,
    "working_storage": 16, "analysis": 4,
}
STATUSES = {"planned", "implemented", "compiled", "validated", "deployed"}
SHA256 = re.compile(r"^[0-9a-f]{64}$")
HASH32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def validate(manifest: dict, root: Path, require_ready: bool = False) -> list[str]:
    errors: list[str] = []
    def check(condition: bool, message: str) -> None:
        if not condition:
            errors.append(message)

    check(manifest.get("schema_version") == 1, "unsupported schema_version")
    check(manifest.get("scope") == "stage_1_direct_advancement", "stage 1 must use direct advancement")
    target = manifest.get("target", {})
    check(target.get("chain_id") == 4663, "target must be Robinhood Chain mainnet 4663")
    req = manifest.get("requirements", {})
    check(req.get("minimum_production_contracts") == 50, "minimum production count must remain 50")
    check(req.get("planned_production_instances") == 64, "planned production count must remain 64")
    check(req.get("swap_integration") == "deferred", "swap integration belongs to a later stage")
    check(req.get("production_scientific_execution") == "entirely_onchain_from_registered_inputs", "scientific execution policy changed")

    # Keep experimental source types separate from the 64 planned instances,
    # and reject stale or inflated implementation counts.
    experimental = manifest.get("experimental_build", {})
    components = experimental.get("components", [])
    check(isinstance(components, list) and all(isinstance(x, str) for x in components),
          "experimental components must be a list of names")
    if isinstance(components, list) and all(isinstance(x, str) for x in components):
        check(len(components) == len(set(components)), "duplicate experimental component")
        check(experimental.get("deployable_component_count") == len(components),
              "experimental component count differs from listed types")
        report_path = root / "reports/compiled_sizes.json"
        if report_path.is_file():
            report = json.loads(report_path.read_text())
            measured = {c["name"] for c in report["contracts"]
                        if c["runtimeBytes"] > 0 and not c.get("testOnly")
                        and c["name"] != "ABDKMathQuad"}
            check(set(components) == measured,
                  "experimental component names differ from compiled deployable product types")
    candidates = manifest.get("experimental_source_candidates", [])
    for candidate in candidates:
        source = candidate.get("path", "")
        source_path = (root / source).resolve()
        check(source_path.is_relative_to(root.resolve()) and source_path.is_file(),
              f"missing or invalid experimental source: {source}")

    slots = manifest.get("slots", [])
    if not isinstance(slots, list) or any(not isinstance(s, dict) for s in slots):
        return errors + ["slots must be a list of objects"]
    ids = [s.get("id") for s in slots]
    names = [s.get("name") for s in slots]
    check(len(slots) == 64, "expected exactly 64 deployment slots")
    check(all(isinstance(i, str) and i for i in ids), "every slot needs a nonempty string id")
    if not all(isinstance(i, str) for i in ids):
        return errors
    check(len(set(ids)) == len(ids), "duplicate slot id")
    check(all(isinstance(n, str) and n for n in names), "every slot needs a name")
    if all(isinstance(n, str) for n in names):
        check(len(set(names)) == len(names), "duplicate slot name")
    counts = dict(Counter(s.get("category") for s in slots))
    check(counts == EXPECTED_COUNTS, f"category counts do not match: {counts}")
    check(manifest.get("category_counts") == EXPECTED_COUNTS, "declared category_counts differ")
    by_id = {s["id"]: s for s in slots}
    deployment_addresses: list[str] = []

    for s in slots:
        sid = s["id"]
        check(s.get("instance_count") == 1, f"{sid}: a slot must count exactly one deployment instance")
        check(bool(s.get("purpose")), f"{sid}: missing scientific or operational purpose")
        check(s.get("execution_location") == "robinhood_evm", f"{sid}: execution must stay on Robinhood EVM")
        status = s.get("production_status")
        check(status in STATUSES, f"{sid}: invalid production_status")
        for field in ("deployment_dependencies", "configuration_dependencies"):
            deps = s.get(field)
            if not isinstance(deps, list) or not all(isinstance(d, str) for d in deps):
                errors.append(f"{sid}: invalid {field}")
                continue
            check(len(deps) == len(set(deps)), f"{sid}: duplicate {field}")
            check(sid not in deps, f"{sid}: self-dependency in {field}")
            for dep in deps:
                check(dep in by_id, f"{sid}: unknown dependency {dep}")
        code = s.get("code") or {}
        for key, pattern in (("source_bundle_sha256", SHA256), ("runtime_code_keccak256", HASH32)):
            value = code.get(key)
            if value is not None:
                check(isinstance(value, str) and bool(pattern.fullmatch(value)), f"{sid}: malformed {key}")
        for key, limit_key in (("runtime_size_bytes", "planning_runtime_limit_bytes"), ("initcode_size_bytes", "planning_initcode_limit_bytes")):
            value = code.get(key)
            if value is not None:
                valid = isinstance(value, int) and not isinstance(value, bool) and value > 0
                check(valid, f"{sid}: invalid {key}")
                if valid:
                    check(value <= target.get(limit_key, 0), f"{sid}: {key} exceeds declared planning budget")
        if status in {"compiled", "validated", "deployed"}:
            for key in ("source", "compiler_version", "source_bundle_file", "source_bundle_sha256", "runtime_code_keccak256", "runtime_size_bytes", "initcode_size_bytes"):
                check(code.get(key) is not None, f"{sid}: {status} needs measured code.{key}")
            bundle = code.get("source_bundle_file")
            if isinstance(bundle, str):
                bundle_path = (root / bundle).resolve()
                check(bundle_path.is_relative_to(root.resolve()), f"{sid}: source bundle escapes project root")
                if bundle_path.is_relative_to(root.resolve()) and bundle_path.is_file():
                    actual = hashlib.sha256(bundle_path.read_bytes()).hexdigest()
                    check(actual == code.get("source_bundle_sha256"), f"{sid}: source bundle SHA-256 mismatch")
                else:
                    errors.append(f"{sid}: source bundle missing")

        deployment = s.get("deployment") or {}
        check(deployment.get("chain_id") == 4663, f"{sid}: deployment chain must be 4663")
        address = deployment.get("address")
        if address is not None:
            valid = isinstance(address, str) and bool(ADDRESS.fullmatch(address)) and int(address, 16) != 0
            check(valid, f"{sid}: malformed or zero deployment address")
            if valid:
                deployment_addresses.append(address.lower())
            check(status == "deployed", f"{sid}: address present but status is not deployed")
        tx_hash = deployment.get("transaction_hash")
        if tx_hash is not None:
            check(isinstance(tx_hash, str) and bool(HASH32.fullmatch(tx_hash)), f"{sid}: malformed transaction hash")
        if status == "deployed":
            check(address is not None, f"{sid}: deployed status needs address")
            check(tx_hash is not None, f"{sid}: deployed status needs transaction hash")
            check(isinstance(deployment.get("block_number"), int) and deployment["block_number"] > 0, f"{sid}: deployed status needs block_number")

        if s.get("category") in {"input_storage", "working_storage"}:
            data = s.get("data") or {}
            digest = data.get("content_sha256")
            if digest is not None:
                check(isinstance(digest, str) and bool(SHA256.fullmatch(digest)), f"{sid}: malformed content_sha256")
            size = data.get("size_bytes")
            if size is not None:
                check(isinstance(size, int) and not isinstance(size, bool) and size >= 0, f"{sid}: invalid data.size_bytes")
            if data.get("sealed"):
                check(digest is not None and size is not None and data.get("schema_version") is not None, f"{sid}: sealed page needs schema, size and content digest")
            if s["category"] == "working_storage":
                check("C03" in s.get("deployment_dependencies", []), f"{sid}: working page must be bound to coordinator")
            if require_ready and s["category"] == "input_storage":
                check(data.get("sealed") is True, f"{sid}: production-ready input must be sealed")
                check(isinstance(size, int) and size > 0, f"{sid}: production input partition is empty or unmeasured")
        if require_ready:
            check(status in {"validated", "deployed"}, f"{sid}: not validated for production")

    check(len(deployment_addresses) == len(set(deployment_addresses)), "distinct deployment slots reuse the same address")
    visiting: set[str] = set()
    visited: set[str] = set()
    def visit(sid: str) -> None:
        if sid in visiting:
            errors.append(f"deployment dependency cycle at {sid}")
            return
        if sid in visited:
            return
        visiting.add(sid)
        deps = by_id[sid].get("deployment_dependencies", [])
        if isinstance(deps, list):
            for dep in deps:
                if isinstance(dep, str) and dep in by_id:
                    visit(dep)
        visiting.remove(sid)
        visited.add(sid)
    for sid in by_id:
        visit(sid)

    if require_ready:
        check(req.get("compiled_production_system") is True, "complete production system has not been compiled")
        check(req.get("scientifically_validated") is True, "scientific validation is incomplete")
        check(not manifest.get("scientific_blockers"), "unresolved scientific blockers remain")
    return errors


def self_test(manifest: dict, root: Path) -> list[str]:
    """Mutation checks verify that broken manifests are actually rejected."""
    failures = []
    if validate(manifest, root):
        return ["baseline manifest is invalid"]
    cases = []
    bad = deepcopy(manifest); bad["slots"][1]["id"] = bad["slots"][0]["id"]; cases.append(("duplicate id", bad))
    bad = deepcopy(manifest); bad["slots"].pop(); cases.append(("missing instance", bad))
    bad = deepcopy(manifest); bad["slots"][0]["deployment_dependencies"] = ["unknown"]; cases.append(("unknown dependency", bad))
    bad = deepcopy(manifest); bad["slots"][0]["deployment_dependencies"] = ["C02"]; cases.append(("dependency cycle", bad))
    bad = deepcopy(manifest); bad["slots"][0]["code"]["source_bundle_sha256"] = "not-a-hash"; cases.append(("bad hash", bad))
    bad = deepcopy(manifest); bad["slots"][0]["code"]["runtime_size_bytes"] = 100_000; cases.append(("oversize runtime", bad))
    bad = deepcopy(manifest); bad["slots"][0]["production_status"] = "compiled"; cases.append(("unsupported compiled claim", bad))
    bad = deepcopy(manifest); bad["target"]["chain_id"] = 8453; cases.append(("wrong chain", bad))
    bad = deepcopy(manifest); bad["slots"][0]["execution_location"] = "offchain"; cases.append(("offchain module", bad))
    bad = deepcopy(manifest); bad["slots"][28]["data"]["sealed"] = True; cases.append(("unmeasured sealed input", bad))
    bad = deepcopy(manifest); bad["experimental_build"]["deployable_component_count"] += 1; cases.append(("inflated experimental count", bad))
    if (root / "reports/compiled_sizes.json").is_file():
        bad = deepcopy(manifest); bad["experimental_build"]["components"][0] = "UncompiledPlaceholder"; cases.append(("uncompiled experimental name", bad))
    for name, bad in cases:
        if not validate(bad, root):
            failures.append(f"mutation was not rejected: {name}")
    if not validate(manifest, root, require_ready=True):
        failures.append("unfinished manifest incorrectly passes production-ready gate")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", nargs="?", type=Path, default=Path(__file__).resolve().parents[1] / "data/contract_manifest.json")
    parser.add_argument("--require-ready", action="store_true", help="Require complete measured/validated code and sealed inputs; current draft must fail")
    parser.add_argument("--self-test", action="store_true", help="Run adversarial manifest mutation checks")
    args = parser.parse_args()
    try:
        manifest = json.loads(args.manifest.read_text())
        if not isinstance(manifest, dict):
            raise ValueError("manifest must be a JSON object")
        root = Path(__file__).resolve().parents[1]
        errors = validate(manifest, root, args.require_ready)
        if args.self_test:
            errors += self_test(manifest, root)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        return 1
    print(json.dumps({
        "ok": not errors,
        "mode": "production_ready" if args.require_ready else "architecture_design",
        "planned_contract_instances": len(manifest.get("slots", [])),
        "deployed_contract_instances": sum(s.get("production_status") == "deployed" for s in manifest.get("slots", [])),
        "category_counts": dict(Counter(s.get("category") for s in manifest.get("slots", []))),
        "self_test": "passed" if args.self_test and not errors else ("failed" if args.self_test else "not_run"),
        "errors": errors,
        "notice": "A valid design manifest does not establish code completeness, scientific validity or successful deployment.",
    }, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
