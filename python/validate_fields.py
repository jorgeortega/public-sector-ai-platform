"""The permit desk's one Python step: check the fields the model extracted.

Reads the fields as JSON (the first argument, or stdin) and prints {"problems": [...]} on stdout.
Standard library only, so it runs anywhere python3 does, including
trigger.dev's Python build extension. src/permit/validate.ts holds the same
rules in TypeScript, for machines without python3; test/engine.test.ts keeps
the two equal.
"""

import json
import re
import sys

ZONE = re.compile(r"^[A-Z]{1,3}-\d{1,2}$")
RANGES = {
    "staff": (0, 500),
    "signSquareMetres": (0, 20),
    "outdoorSeats": (0, 200),
    "largestEventGuests": (0, 5000),
}


def problems(fields: dict) -> list[str]:
    found = []
    if not isinstance(fields.get("business"), str) or not fields["business"].strip():
        found.append("business: missing")
    zone = fields.get("zone")
    if not isinstance(zone, str) or not ZONE.match(zone):
        found.append(f"zone: {zone!r} is not a zone code")
    for name, (low, high) in RANGES.items():
        if name not in fields or fields[name] is None:
            continue
        value = fields[name]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            found.append(f"{name}: not a number")
        elif not low <= value <= high:
            found.append(f"{name}: {value} is outside {low} to {high}")
    return found


if __name__ == "__main__":
    # The fields come as the first argument (trigger.dev's runScript passes
    # arguments, not stdin), or on stdin.
    raw = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read()
    print(json.dumps({"problems": problems(json.loads(raw))}))
