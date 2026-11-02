# Contributing to ORVIA

Help make the implementation, scientific assumptions and evidence easier to reproduce and inspect.

[Project home](README.md) · [Documentation](docs/README.md) · [Current status](STATUS.md) · [Production gaps](docs/PRODUCTION_GAPS.md)

## Find the right starting point

- **Documentation:** clarify a method, correct a link or improve a reproducible example.
- **Engineering:** inspect a contract and its corresponding tests, independent references and implementation guide.
- **Scientific inputs:** start with the [protocol](docs/PROTOCOL_ORVIA_001.md), [source audit](docs/SOURCE_AUDIT.md) and [scientific-readiness review](docs/SCIENTIFIC_READINESS.md).
- **A new method or broader change:** describe the intended behavior, assumptions and evidence in an issue so the assumptions are visible.

Keep each pull request focused. Explain the problem, the resulting behavior, how you checked it and any remaining limits. Distinguish implemented behavior from proposed work.

## Set up the local checks

The v0.5.1 checkpoint was checked with Node.js 24.22.1 and CPython 3.12.14. Use the committed dependency pins:

```bash
npm ci
python3.12 -m venv .venv-research
.venv-research/bin/python -m pip install -r requirements-research.txt
```

Useful commands from the repository root:

| Command | Purpose |
| --- | --- |
| `npm run compile` | Compile Solidity with the pinned compiler settings |
| `npm test` | Run the Node/EVM tests |
| `npm run check:manifest` | Check the architecture manifest |
| `ORVIA_RESEARCH_PYTHON=.venv-research/bin/python npm run check` | Run all nine check groups and regenerate the source-bound validation evidence |
| `node scripts/validation_inventory.mjs --verify` | Check that the complete validation record still matches its inputs, outputs and logs |

The complete check uses an in-process local EVM. It requires no wallet, signing key or mainnet RPC. It writes reports and logs under `reports/` and compiler artifacts under `build/`.

Set `ORVIA_RESEARCH_PYTHON` to the pinned research interpreter for numerical references and `ORVIA_PREPARATION_PYTHON` to the separately pinned OpenMM/Amber preparation interpreter described in [ligand preparation](docs/LIGAND_PREPARATION_v0_1.md). The preparation environment is distinct from the research virtual environment. `ORVIA_TEST_CONCURRENCY=8` runs up to eight EVM test files concurrently; the default is three, and supported values are 1–32. This changes scheduling only: every fixed check and test remains required, and the resolved concurrency is recorded in the validation summary.

## Keep results reproducible

For changes to contracts, tests, references, scripts, scientific data or dependency pins, run the relevant checks while developing, then run the complete check before presenting a new full-suite result. Its input inventory binds those file sets. Changing them after a successful run invalidates that result.

Independent reference calculations should test the scientific or numerical behavior, including error limits and rejected inputs. Preserve provenance for imported data and code. Retain the vendored ABDK license, attribution and pinned-source information.

For documentation-only changes, verify links, examples and factual claims against the owning sources. Do not rewrite a recorded result or imply that an older test run validates newer code.

## Respect the research boundaries

- A numerical component, a short trajectory and a complete molecular experiment are different levels of evidence.
- Alternative coordinators are not automatically one combined sampling pipeline.
- Local gas measurements do not establish Robinhood fees, throughput or full-system feasibility.
- A passing local suite does not establish adequate physical sampling or mainnet readiness.

The [production-gap review](docs/PRODUCTION_GAPS.md) and [mainnet-readiness guide](docs/MAINNET_READINESS.md) describe the remaining acceptance work. The readiness commands are expected to reject this development checkpoint:

```bash
node scripts/deploy.mjs --readiness
python3 scripts/validate_manifest.py --require-ready
```

After a complete successful check, `python3 scripts/package.py` verifies the bound evidence and builds the source-and-validation archive. Keep private environment settings and credentials out of commits and shared reports.
