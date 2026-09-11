#!/usr/bin/env python3
"""Verify (or refresh) src/data/itErdSpendData.ts against its source workbooks.

The module's reference tables are static extracts from four spreadsheets. In 2026 a
recalibrated workbook landed without the extract being re-run, and the module shipped
IT spend figures 2-4x too high for six weeks. This script makes that drift detectable:

    python3 scripts/it-erd-spend-data.py            # report drift, exit 1 if any
    python3 scripts/it-erd-spend-data.py --write    # rewrite the TS constants in place

Source workbooks (override the folder with --source-dir):
  Automated IT ERD Spend Calculator.xlsx  -> IT/ERD base %, countries, ERD split,
                                             emerging-tech base %
  IT Spend.xlsx                           -> 117-item Level-3 taxonomy + allocations
  IT_Spend_L3_Exclusion_List.xlsx         -> Level-3 exclusions by industry x tier
  EmergingTech_Exclusion_List.xlsx        -> emerging-tech exclusions by industry x tier
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import openpyxl

DEFAULT_SOURCE_DIR = Path.home() / "Desktop" / "IT Spend Folder"
DATA_FILE = Path(__file__).resolve().parent.parent / "src" / "data" / "itErdSpendData.ts"
CALCULATOR = "Automated IT ERD Spend Calculator.xlsx"
L3_FILE = "IT Spend.xlsx"
L3_EXCLUSIONS = "IT_Spend_L3_Exclusion_List.xlsx"
ET_EXCLUSIONS = "EmergingTech_Exclusion_List.xlsx"


def rows_of(path: Path, sheet: str) -> list[tuple]:
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        return list(workbook[sheet].values)
    finally:
        workbook.close()


def extract(source_dir: Path) -> dict[str, object]:
    """Every constant this script owns, keyed by its TS export name."""
    calculator = source_dir / CALCULATOR
    industry_base = rows_of(calculator, "Industry_Base")
    # Two side-by-side tables: IT in columns A:J, ERD in columns N:W.
    it_base = {r[0]: [round(float(r[i]), 6) for i in range(1, 10)] for r in industry_base[1:] if r[0]}
    erd_base = {r[13]: [round(float(r[i]), 6) for i in range(14, 23)] for r in industry_base[1:] if len(r) > 13 and r[13]}

    countries = {r[0]: r[1] for r in rows_of(calculator, "Countries")[1:] if r[0] and r[1]}

    split_rows = rows_of(calculator, "ERD Spend Split")
    split_header = split_rows[0]
    erd_split = {
        r[0]: {split_header[i]: round(float(r[i]), 6) for i in range(1, 15)}
        for r in split_rows[1:]
        if r[0]
    }

    tech_rows = rows_of(calculator, "EmergTech_Adj")
    tech_header = tech_rows[0]
    tech_base = {
        r[0]: {tech_header[i]: round(float(r[i]), 6) for i in range(1, 9)}
        for r in tech_rows[1:]
        if r[0]
    }

    # Level-3 taxonomy + per-industry allocation: one column per industry, L1/L2 only
    # populated on the first row of each group, trailing "TOTAL" row skipped.
    l3_rows = rows_of(source_dir / L3_FILE, "IT Spend L3 by Industry")
    industries = [h for h in l3_rows[2][3:] if h]
    taxonomy: list[dict[str, str]] = []
    allocations: dict[str, dict[str, float]] = {industry: {} for industry in industries}
    level1 = level2 = None
    for row in l3_rows[3:]:
        if row[0] == "TOTAL":
            continue
        level1 = row[0] or level1
        level2 = row[1] or level2
        level3 = row[2]
        if not level3:
            continue
        taxonomy.append({"level1": level1, "level2": level2, "level3": level3})
        for offset, industry in enumerate(industries):
            value = row[3 + offset]
            # The workbook states whole percents; the module stores fractions.
            allocations[industry][level3] = round(float(value or 0) / 100, 10)

    def exclusion_matrix(path: Path, category_col: int, industry_col: int, first_tier_col: int):
        matrix: dict[str, dict[str, list[int]]] = {}
        for row in rows_of(path, "Tier Binary Detail"):
            category, industry = row[category_col], row[industry_col]
            if not category or not industry or str(row[first_tier_col]) not in ("0", "1"):
                continue
            matrix.setdefault(str(category), {})[str(industry)] = [
                int(row[i]) for i in range(first_tier_col, first_tier_col + 7)
            ]
        return matrix

    return {
        "IT_BASE_PCT_BY_YEAR": it_base,
        "ERD_BASE_PCT_BY_YEAR": erd_base,
        "COUNTRY_TO_REGION": countries,
        "ERD_CATEGORY_SPLIT": erd_split,
        "EMERGING_TECH_BASE_PCT": tech_base,
        "IT_LEVEL3_TAXONOMY": taxonomy,
        "IT_LEVEL3_PCT": allocations,
        "IT_LEVEL3_EXCLUSION": exclusion_matrix(source_dir / L3_EXCLUSIONS, 2, 3, 4),
        "EMERGING_TECH_EXCLUSION": exclusion_matrix(source_dir / ET_EXCLUSIONS, 0, 1, 2),
    }


def literal_span(source: str, name: str) -> tuple[int, int]:
    """Character span of the JSON literal assigned to `export const <name>`."""
    match = re.search(r"export const " + re.escape(name) + r"(\s*:[^=]*)?=\s*", source)
    if not match:
        raise SystemExit(f"{name} not found in {DATA_FILE}")
    start = match.end()
    depth = 0
    i = start
    while True:
        if source[i] in "[{":
            depth += 1
        elif source[i] in "]}":
            depth -= 1
            if depth == 0:
                break
        i += 1
    end = i + 1
    while source[end] in " ;":
        end += 1
    return start, end


def shipped(source: str, name: str):
    start, end = literal_span(source, name)
    return json.loads(source[start:end].rstrip("; "))


def approx_equal(a, b, tolerance: float = 1e-9) -> bool:
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(approx_equal(a[k], b[k], tolerance) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(approx_equal(x, y, tolerance) for x, y in zip(a, b))
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tolerance
    return a == b


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-dir", type=Path, default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--write", action="store_true", help="rewrite the TS constants from the workbooks")
    args = parser.parse_args()

    if not args.source_dir.is_dir():
        print(f"source folder not found: {args.source_dir}", file=sys.stderr)
        return 2

    expected = extract(args.source_dir)
    source = DATA_FILE.read_text(encoding="utf-8")

    drifted = []
    for name, value in expected.items():
        if not approx_equal(shipped(source, name), value):
            drifted.append(name)

    if args.write:
        for name in drifted:
            start, end = literal_span(source, name)
            source = source[:start] + json.dumps(expected[name], ensure_ascii=False) + ";" + source[end:]
        DATA_FILE.write_text(source, encoding="utf-8")
        print(f"refreshed {len(drifted)} table(s): {', '.join(drifted) or 'none — already current'}")
        return 0

    if drifted:
        print("stale reference tables (re-run with --write):", ", ".join(drifted))
        return 1
    print(f"all {len(expected)} reference tables match their source workbooks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
