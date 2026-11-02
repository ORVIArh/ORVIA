#!/usr/bin/env bash
# Public, credential-free launch wrapper. It does not create or stop a Pod.
set -Eeuo pipefail
umask 077

PINNED_COMMIT=dd01848fd9d6b83ec8471b2453f6eabf2d61236e
BUNDLE_SHA=71a7559f4fe841882104923d9c953d2031a2e9d4f4268a811a9d4dc0b48954e9
BUNDLE_URL="https://raw.githubusercontent.com/ORVIArh/ORVIA/${PINNED_COMMIT}/evidence/calldata-vs-storage/orvia-runpod-benchmark.tar.gz"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_ROOT="/workspace/orvia-gpu-${RUN_ID}"
ARCHIVE="/workspace/orvia-results-${RUN_ID}.tar.gz"
START_SECONDS=$(date +%s)
STAGE=initialization
BENCHMARK_EXIT=not_started
PYTHON_BIN=
mkdir -p "$RUN_ROOT/logs" "$RUN_ROOT/environment" "$RUN_ROOT/results"

finish() {
  local exit_code=$?
  trap - EXIT INT TERM
  set +e
  local elapsed=$(( $(date +%s) - START_SECONDS ))
  printf '{"wrapper_exit_code":%s,"stage":"%s","benchmark_exit":"%s","elapsed_seconds":%s,"pinned_commit":"%s","bundle_sha256":"%s","pod_stopped":false}\n' \
    "$exit_code" "$STAGE" "$BENCHMARK_EXIT" "$elapsed" "$PINNED_COMMIT" "$BUNDLE_SHA" > "$RUN_ROOT/run-status.json"
  # Always preserve partial reports and logs, including strict-tolerance exit 2.
  if timeout --signal=INT --kill-after=10s 60s tar -C "$RUN_ROOT" -czf "$ARCHIVE" logs environment results run-status.json; then
    sha256sum "$ARCHIVE" > "${ARCHIVE}.sha256"
    printf '\nRESULT_ARCHIVE=%s\n' "$ARCHIVE"
    cat "${ARCHIVE}.sha256"
  else
    printf '\nARCHIVE_FAILED; retrieve directory directly: %s\n' "$RUN_ROOT" >&2
  fi
  printf '\nPOD IS STILL RUNNING. Retrieve and verify results, then terminate the Pod in Runpod.\n'
  exit "$exit_code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

limited() {
  local requested=$1
  shift
  # Leave 60 seconds inside the 30-minute workflow allowance for archiving.
  local left=$(( 1740 - ($(date +%s) - START_SECONDS) ))
  if (( left <= 0 )); then
    printf 'Workflow time allowance exhausted before %s\n' "$STAGE" >&2
    return 124
  fi
  if (( requested > left )); then requested=$left; fi
  timeout --signal=INT --kill-after=15s "${requested}s" "$@"
}

STAGE=prerequisites
for tool in curl tar sha256sum timeout nvidia-smi; do
  command -v "$tool" >/dev/null || { printf 'Required command missing: %s\n' "$tool" >&2; exit 3; }
done
for candidate in python3.12 python3.13 python3.14 python3; do
  if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; raise SystemExit(0 if (3,12) <= sys.version_info[:2] <= (3,14) else 1)' 2>/dev/null; then
    PYTHON_BIN=$(command -v "$candidate")
    break
  fi
done
if [[ -z "$PYTHON_BIN" ]]; then
  printf 'Pinned NumPy 2.5.4 requires Python >=3.12. No compatible Python 3.12-3.14 was found; refusing package downgrade.\n' >&2
  exit 4
fi
"$PYTHON_BIN" --version > "$RUN_ROOT/environment/python.txt" 2>&1
limited 20 nvidia-smi --query-gpu=name,uuid,memory.total,driver_version --format=csv > "$RUN_ROOT/environment/nvidia-smi.csv" 2> "$RUN_ROOT/logs/nvidia-smi.stderr.log"
if ! grep -q 'A100' "$RUN_ROOT/environment/nvidia-smi.csv"; then
  printf 'The visible hardware is not the requested A100; refusing the benchmark.\n' >&2
  exit 5
fi

STAGE=download
limited 120 curl --fail --location --retry 2 --connect-timeout 20 --max-time 110 --proto '=https' --proto-redir '=https' \
  "$BUNDLE_URL" -o "$RUN_ROOT/bundle.tar.gz.part" 2> "$RUN_ROOT/logs/download.stderr.log"
printf '%s  %s\n' "$BUNDLE_SHA" "$RUN_ROOT/bundle.tar.gz.part" | sha256sum --check --strict > "$RUN_ROOT/logs/bundle-verification.log"
mv "$RUN_ROOT/bundle.tar.gz.part" "$RUN_ROOT/bundle.tar.gz"
limited 30 tar --no-same-owner -xzf "$RUN_ROOT/bundle.tar.gz" -C "$RUN_ROOT"
BUNDLE_ROOT="$RUN_ROOT/orvia-benchmark"
cp "$BUNDLE_ROOT/manifest.json" "$RUN_ROOT/environment/bundle-manifest.json"
cp "$BUNDLE_ROOT/scripts/requirements-cuda.txt" "$RUN_ROOT/environment/requirements-cuda.txt"

STAGE=environment
limited 60 "$PYTHON_BIN" -m venv "$RUN_ROOT/venv" > "$RUN_ROOT/logs/venv.stdout.log" 2> "$RUN_ROOT/logs/venv.stderr.log"
VENV_PYTHON="$RUN_ROOT/venv/bin/python"
# --isolated avoids inherited pip index credentials/configuration in logs.
limited 420 "$VENV_PYTHON" -m pip --isolated install --disable-pip-version-check --no-input --only-binary=:all: \
  --index-url https://pypi.org/simple --retries 1 --timeout 30 -r "$BUNDLE_ROOT/scripts/requirements-cuda.txt" \
  > "$RUN_ROOT/logs/install.stdout.log" 2> "$RUN_ROOT/logs/install.stderr.log"
"$VENV_PYTHON" -m pip freeze --all > "$RUN_ROOT/environment/pip-freeze.txt"

STAGE=cuda_preflight
limited 30 "$VENV_PYTHON" -c 'import json,openmm,numpy; p=[openmm.Platform.getPlatform(i).getName() for i in range(openmm.Platform.getNumPlatforms())]; print(json.dumps({"openmm":openmm.__version__,"numpy":numpy.__version__,"platforms":p})); assert "CUDA" in p, "CUDA plugin absent; no CPU fallback"' \
  > "$RUN_ROOT/environment/openmm-platforms.json" 2> "$RUN_ROOT/logs/cuda-preflight.stderr.log"

STAGE=benchmark
# The runner owns child process groups and kills them on timeout/interrupt.
# INT (not TERM) lets its Python cleanup stop any active child before archiving.
set +e
limited 1230 "$VENV_PYTHON" "$BUNDLE_ROOT/scripts/run_benchmark.py" \
  --bundle-root "$BUNDLE_ROOT" --output-dir "$RUN_ROOT/results" --platform CUDA \
  --precisions mixed,double --device-index 0 --timeout-seconds 1200 --step-timeout-seconds 240 \
  > "$RUN_ROOT/logs/runner.stdout.log" 2> "$RUN_ROOT/logs/runner.stderr.log"
BENCHMARK_EXIT=$?
set -e
STAGE=finished
exit "$BENCHMARK_EXIT"
