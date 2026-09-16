import json
import re
from collections import defaultdict
from pathlib import Path
from time import perf_counter

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.neighbors import KNeighborsRegressor

TRAIN = Path("data/router-gold-v2.jsonl")
EVAL = Path("tests/fixtures/router-holdout-v2.jsonl")

FIELDS = [
    "reasoning",
    "freshness",
    "externalKnowledge",
    "ambiguity",
    "verificationNeed",
    "calculation",
]

train = [
    json.loads(line)
    for line in TRAIN.read_text().splitlines()
    if line.strip()
]

eval_rows = [
    json.loads(line)
    for line in EVAL.read_text().splitlines()
    if line.strip()
]

train_prompts = [r["prompt"] for r in train]

targets = np.array(
    [[r[f] for f in FIELDS] for r in train],
    dtype=np.float32,
)


def clamp(x):
    return max(0.0, min(1.0, float(x)))


def high(x, start=.55, full=.85):
    x = clamp(x)
    if x <= start:
        return 0.0
    if x >= full:
        return 1.0
    return (x - start) / (full - start)


def elevated(x, start=.4, full=.8):
    x = clamp(x)
    if x <= start:
        return 0.0
    if x >= full:
        return 1.0
    return (x - start) / (full - start)


def medium(x):
    x = clamp(x)
    return max(0.0, 1 - abs(x - .5) / .35)


def routing_clauses(prompt):
    normalized = " ".join(prompt.split()).strip()

    if not normalized:
        return []

    parts = re.split(
        r"(?:[.!?;]+\s+|\s+(?:and|but|also|then)\s+|,\s+(?:and|but|then)\s+)",
        normalized,
        flags=re.I,
    )

    clauses = [
        part.strip()
        for part in parts
        if len(part.strip()) >= 3
    ]

    return clauses if len(clauses) > 1 else [normalized]


def aggregate_signals(signal_rows):
    if len(signal_rows) == 0:
        return np.zeros(len(FIELDS), dtype=np.float32)

    return np.max(
        np.asarray(signal_rows, dtype=np.float32),
        axis=0,
    )


def fast_route(prompt):
    p = prompt.strip()

    # Explicit negative web instructions win.
    no_web = (
        re.search(
            r"\b(?:do not|don't|dont|without)\s+(?:search(?:ing)?|look(?:ing)?\s+(?:it\s+)?up|using\s+(?:the\s+)?web|brows(?:e|ing)|checking?\s+online)\b",
            p,
            re.I,
        )
        or re.search(
            r"\b(?:no|without)\s+(?:web|internet|online\s+search)\b",
            p,
            re.I,
        )
    )

    if no_web:
        return {
            "kind": "override",
            "knowledge": "internal",
        }

    # Positive web instructions force only the knowledge dimension.
    if re.search(
        r"\b(?:search(?: the web)?|look up|lookup|fact[- ]?check|verify|sources?|citations?|find (?:a |me |reliable )?source|check online)\b",
        p,
        re.I,
    ):
        return {
            "kind": "override",
            "knowledge": "web_required",
        }

    if re.fullmatch(r"[\d\s()+*/.^%=-]+", p):
        return {
            "kind": "final",
            "route": {
                "reasoning": "fast",
                "knowledge": "internal",
                "tool": "calculate",
            },
        }

    if re.fullmatch(
        r"(?:who are you|what are you|what(?:'s| is) your (?:name|dream)|who (?:made|created) you|tell me about yourself)[?.!]*",
        p,
        re.I,
    ):
        return {
            "kind": "final",
            "route": {
                "reasoning": "fast",
                "knowledge": "internal",
                "tool": "none",
            },
        }

    if re.fullmatch(
        r"(?:hi|hello|hey|thanks|thank you|good morning|good afternoon|good evening|good night)[!?. ]*",
        p,
        re.I,
    ):
        return {
            "kind": "final",
            "route": {
                "reasoning": "fast",
                "knowledge": "internal",
                "tool": "none",
            },
        }

    return {"kind": "semantic"}


def fuzzy_route(values):
    s = dict(zip(FIELDS, map(clamp, values)))

    web = max(
        high(s["freshness"]),
        min(
            elevated(s["externalKnowledge"]),
            elevated(s["verificationNeed"]),
        ),
        min(
            high(s["externalKnowledge"]),
            high(s["ambiguity"]),
        ),
    )

    online = max(
        high(s["reasoning"], .45, .80),
        min(
            medium(s["reasoning"]),
            high(s["ambiguity"]),
        ),
    )

    calculate = min(
        high(s["calculation"], .5, .85),
        1 - high(s["reasoning"]),
    )

    reasoning = (
        "deep" if online >= .8
        else "standard" if online >= .35
        else "fast"
    )

    knowledge = (
        "web_required" if web >= .6
        else "web_if_uncertain" if web >= .25
        else "internal"
    )

    tool = "calculate" if calculate >= .65 else "none"

    return {
        "reasoning": reasoning,
        "knowledge": knowledge,
        "tool": tool,
    }


print(f"training: {len(train)}")
print(f"evaluation: {len(eval_rows)}")
print("loading MiniLM...")

encoder = SentenceTransformer(
    "sentence-transformers/all-MiniLM-L6-v2",
    backend="onnx",
    model_kwargs={
        "file_name": "onnx/model_qint8_arm64.onnx",
        "provider": "CPUExecutionProvider",
    },
)

print("embedding training set...")

train_x = encoder.encode(
    train_prompts,
    normalize_embeddings=True,
    show_progress_bar=False,
)

model = KNeighborsRegressor(
    n_neighbors=7,
    weights="distance",
    metric="cosine",
)
model.fit(train_x, targets)

stats = defaultdict(lambda: [0, 0])

full_pass = 0
dimension_pass = {
    "reasoning": 0,
    "knowledge": 0,
    "tool": 0,
}

times = []
failures = []

print("\n" + "=" * 72)
print("UNSEEN ROUTER EVALUATION")

for row in eval_rows:
    start = perf_counter()

    fast = fast_route(row["prompt"])

    if fast["kind"] == "final":
        actual = fast["route"]
        signals = np.zeros(len(FIELDS), dtype=np.float32)

    else:
        clauses = routing_clauses(row["prompt"])

        x = encoder.encode(
            clauses,
            normalize_embeddings=True,
            show_progress_bar=False,
        )

        clause_signals = np.clip(model.predict(x), 0, 1)
        signals = aggregate_signals(clause_signals)
        actual = fuzzy_route(signals)

        if fast["kind"] == "override":
            actual["knowledge"] = fast["knowledge"]

    elapsed = (perf_counter() - start) * 1000
    times.append(elapsed)

    checks = {
        dim: actual[dim] in row[dim]
        for dim in ("reasoning", "knowledge", "tool")
    }

    for dim, ok in checks.items():
        dimension_pass[dim] += int(ok)

    ok = all(checks.values())

    stats[row["category"]][1] += 1
    stats[row["category"]][0] += int(ok)

    if ok:
        full_pass += 1
    else:
        failures.append({
            "category": row["category"],
            "prompt": row["prompt"],
            "expected": {
                d: row[d]
                for d in ("reasoning", "knowledge", "tool")
            },
            "actual": actual,
            "signals": dict(zip(FIELDS, map(float, signals))),
        })

n = len(eval_rows)

print("\nRESULTS")
print(f"full route: {full_pass}/{n} ({full_pass/n:.1%})")

for dim in ("reasoning", "knowledge", "tool"):
    p = dimension_pass[dim]
    print(f"{dim:10s}: {p}/{n} ({p/n:.1%})")

print("\nCATEGORY RESULTS")

for category in sorted(stats):
    passed, total = stats[category]
    print(
        f"{category:18s} "
        f"{passed:2d}/{total:2d} "
        f"{passed/total:6.1%}"
    )

print("\nLATENCY")
print(f"average: {np.mean(times):.2f} ms")
print(f"median:  {np.median(times):.2f} ms")
print(f"p95:     {np.percentile(times, 95):.2f} ms")
print(f"max:     {np.max(times):.2f} ms")

print("\nFAILURES")

if not failures:
    print("none 🎉")
else:
    for f in failures:
        print("\n" + "-" * 72)
        print(f"[{f['category']}] {f['prompt']}")
        print("expected:", f["expected"])
        print("actual:  ", f["actual"])
        print("signals:")
        for field in FIELDS:
            print(f"  {field:18s} {f['signals'][field]:.3f}")
