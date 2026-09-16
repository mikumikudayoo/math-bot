import json
from pathlib import Path
from time import perf_counter

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.neighbors import KNeighborsRegressor

DATA = Path("data/router-gold-expanded.jsonl")

FIELDS = [
    "reasoning",
    "freshness",
    "externalKnowledge",
    "ambiguity",
    "verificationNeed",
    "calculation",
]

rows = [
    json.loads(line)
    for line in DATA.read_text().splitlines()
    if line.strip()
]

prompts = [r["prompt"] for r in rows]
targets = np.array(
    [[r[f] for f in FIELDS] for r in rows],
    dtype=np.float32,
)

print(f"training examples: {len(rows)}")
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

X = encoder.encode(
    prompts,
    normalize_embeddings=True,
    show_progress_bar=False,
)

model = KNeighborsRegressor(
    n_neighbors=7,
    weights="distance",
    metric="cosine",
)
model.fit(X, targets)


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
        high(s["calculation"], .6, .9),
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

    return reasoning, knowledge, tool


CASES = [
    ("yo what's up",
     ("fast", "internal", "none")),

    ("what is 37 times 14?",
     ("fast", "internal", "calculate")),

    ("prove that there cannot be a largest prime",
     ("deep", "internal", "none")),

    ("explain why leaves are green",
     ("fast", "internal", "none")),

    ("what's the weather tomorrow in Quezon City?",
     ("fast", "web_required", "none")),

    ("look up reliable sources for this statement",
     ("fast", "web_required", "none")),

    ("who originally developed this obscure game?",
     ("fast", "web_required", "none")),

    ("why does this TypeScript function recurse forever?",
     ("standard", "internal", "none")),

    ("what exactly are they talking about here?",
     ("standard", "internal", "none")),

    ("compare these two mathematical arguments",
     ("standard", "internal", "none")),

    ("what is your dream?",
     ("fast", "internal", "none")),

    ("who provides Hatsune Miku's voice?",
     ("fast", "web_required", "none")),

    ("what is the current price of gold?",
     ("fast", "web_required", "none")),

    ("prove that sqrt(2) is irrational",
     ("deep", "internal", "none")),

    ("calculate 144 divided by 12",
     ("fast", "internal", "calculate")),
]

print("\n" + "=" * 70)
print("END-TO-END CHALLENGE")

passed = 0
times = []

for prompt, expected in CASES:
    start = perf_counter()

    embedding = encoder.encode(
        [prompt],
        normalize_embeddings=True,
        show_progress_bar=False,
    )

    values = np.clip(model.predict(embedding)[0], 0, 1)
    actual = fuzzy_route(values)

    elapsed = (perf_counter() - start) * 1000
    times.append(elapsed)

    ok = actual == expected
    passed += int(ok)

    print("\n" + ("PASS" if ok else "FAIL"))
    print(prompt)
    print(f"expected: {expected}")
    print(f"actual:   {actual}")
    print(f"time:     {elapsed:.2f} ms")

    if not ok:
        print("signals:")
        for field, value in zip(FIELDS, values):
            print(f"  {field:18s} {value:.3f}")

print("\n" + "=" * 70)
print(f"passed: {passed}/{len(CASES)}")
print(f"average: {np.mean(times):.2f} ms")
print(f"median:  {np.median(times):.2f} ms")
print(f"max:     {np.max(times):.2f} ms")
