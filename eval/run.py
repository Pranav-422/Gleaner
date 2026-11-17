"""Accuracy check: run the real pipeline on reels with known answers and print the numbers.

    cd backend
    uv run python ../eval/run.py

Reads eval/testset.json (copy testset.example.json and fill it in). Extracted text is cached in
eval/cache/, so a second run costs only Gemini calls and Instagram is not fetched again.
"""

import hashlib
import json
import re
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))

from app import llm, pipeline  # noqa: E402


def norm(value) -> str:
    return re.sub(r"[^a-z0-9]", "", json.dumps(value, ensure_ascii=False).casefold())


def extracted_text(url: str) -> str:
    cache = HERE / "cache" / (hashlib.sha256(url.encode()).hexdigest()[:16] + ".txt")
    if not cache.exists():
        cache.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="gleaner-eval-") as tmp:
            cache.write_text(pipeline.extract(url, Path(tmp)).text, encoding="utf-8")
    return cache.read_text(encoding="utf-8")


def classify(text: str):
    for _ in range(3):
        try:
            return llm.classify(text)
        except llm.RateLimited:
            print("  rate limited, waiting 60 s")
            time.sleep(60)
    raise SystemExit("Still rate limited after 3 tries. Run again later.")


def main() -> None:
    testset = json.loads((HERE / "testset.json").read_text(encoding="utf-8"))
    folder_hits, field_hits, field_total, tokens_in, tokens_out, failed = 0, {}, {}, 0, 0, 0

    for case in testset:
        try:
            text = extracted_text(case["url"])
            result, tokens = classify(text) if text else (None, {"in": 0, "out": 0})
        except Exception as exc:  # a reel that cannot be fetched counts as a miss, not a crash
            print(f"FAIL  {case['url']}  {type(exc).__name__}: {str(exc)[:120]}")
            failed += 1
            continue
        got = result.model_dump(mode="json") if result else {}
        folder_ok = got.get("folder") == case["folder"]
        folder_hits += folder_ok
        tokens_in += tokens["in"] or 0
        tokens_out += tokens["out"] or 0
        misses = []
        for field, expected in case.get("fields", {}).items():
            # A field is right when the expected value appears inside what the pipeline produced.
            hit = norm(expected) in norm(got.get(field))
            field_hits[field] = field_hits.get(field, 0) + hit
            field_total[field] = field_total.get(field, 0) + 1
            if not hit:
                misses.append(f"{field}: wanted {expected!r}, got {got.get(field)!r}")
        print(f"{'ok  ' if folder_ok and not misses else 'MISS'}  {case['url']}  folder={got.get('folder')}")
        for miss in misses:
            print(f"        {miss}")

    total = len(testset)
    done = total - failed
    print(f"\nReels: {total}   fetched and read: {done}   failed: {failed}")
    print(f"Folder accuracy: {folder_hits}/{total} = {folder_hits / total:.0%}")
    for field in sorted(field_total):
        print(f"  {field:<18} {field_hits[field]}/{field_total[field]} = {field_hits[field] / field_total[field]:.0%}")
    if done:
        print(f"Tokens per reel: {tokens_in / done:.0f} in, {tokens_out / done:.0f} out")


if __name__ == "__main__":
    main()
