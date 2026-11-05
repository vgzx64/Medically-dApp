#!/usr/bin/env python3
"""Summarise the Slither JSON reports of the fixed and vulnerable contracts.

Usage:  python tools/slither_summary.py artifacts/logs/slither-fixed.json artifacts/logs/slither-vuln.json
"""
import json
import sys
from collections import Counter

SEVERITY_ORDER = {"High": 0, "Medium": 1, "Low": 2, "Informational": 3, "Optimization": 4}


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def summarise(path):
    data = load(path)
    detectors = data.get("results", {}).get("detectors", [])
    counts = Counter(d["impact"] for d in detectors)
    print(f"### {path}")
    print(f"    success: {data.get('success')}")
    for impact in sorted(counts, key=lambda i: SEVERITY_ORDER.get(i, 9)):
        print(f"    {impact:<14} {counts[impact]}")
    print("    High/Medium findings:")
    for d in detectors:
        if d["impact"] in ("High", "Medium"):
            first = d["description"].strip().splitlines()[0]
            print(f"      - [{d['impact']}] {d['check']}: {first[:150]}")
    print()
    return counts, {d["check"] for d in detectors if d["impact"] in ("High", "Medium")}


def main():
    argv = sys.argv[1:]

    # --fail-on high,medium turns the summary into a CI gate for the FIXED contract.
    fail_on = set()
    if "--fail-on" in argv:
        index = argv.index("--fail-on")
        if index + 1 >= len(argv):
            print("--fail-on needs a comma separated list, e.g. --fail-on high,medium", file=sys.stderr)
            return 2
        fail_on = {impact.strip().capitalize() for impact in argv[index + 1].split(",") if impact.strip()}
        argv = argv[:index] + argv[index + 2:]

    if not argv:
        print(__doc__)
        return 1

    fixed_counts, fixed_checks = summarise(argv[0])
    vuln_counts, vuln_checks = summarise(argv[1]) if len(argv) > 1 else ({}, set())

    if vuln_checks:
        print("### Comparison fixed -> vulnerable")
        only_vuln = sorted(vuln_checks - fixed_checks)
        only_fixed = sorted(fixed_checks - vuln_checks)
        print(f"    findings only in the VULNERABLE version: {only_vuln or 'none'}")
        print(f"    findings only in the FIXED version:     {only_fixed or 'none'}")
        print(
            "    severity delta: "
            + ", ".join(
                f"{k}: {fixed_counts.get(k, 0)} -> {vuln_counts.get(k, 0)}"
                for k in ("High", "Medium", "Low", "Informational")
            )
        )

    blocking = sorted(set(fixed_counts) & fail_on)
    if blocking:
        print(
            f"FAIL: the fixed contract still has {', '.join(blocking)} findings "
            f"({sum(fixed_counts[impact] for impact in blocking)})"
        )
        return 1
    if fail_on:
        print(f"OK: no {' / '.join(sorted(fail_on))} findings in the fixed contract")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
