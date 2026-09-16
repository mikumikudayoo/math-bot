import json
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.ensemble import ExtraTreesRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split
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
categories = [r["category"] for r in rows]

y = np.array(
    [[r[f] for f in FIELDS] for r in rows],
    dtype=np.float32,
)

print(f"loaded {len(rows)} examples")
print("loading MiniLM...")

encoder = SentenceTransformer(
    "sentence-transformers/all-MiniLM-L6-v2",
    backend="onnx",
    model_kwargs={
        "file_name": "onnx/model_qint8_arm64.onnx",
        "provider": "CPUExecutionProvider",
    },
)

print("embedding...")
X = encoder.encode(
    prompts,
    normalize_embeddings=True,
    show_progress_bar=False,
)

X_train, X_test, y_train, y_test = train_test_split(
    X,
    y,
    test_size=0.25,
    random_state=42,
    stratify=categories,
)

models = {
    "ridge": Ridge(alpha=2.0),

    "knn": KNeighborsRegressor(
        n_neighbors=7,
        weights="distance",
        metric="cosine",
    ),

    "extra_trees": ExtraTreesRegressor(
        n_estimators=300,
        min_samples_leaf=2,
        random_state=42,
        n_jobs=-1,
    ),
}

challenge = [
    "yo what's up",
    "what is 37 times 14?",
    "prove that there cannot be a largest prime",
    "explain why leaves are green",
    "what's the weather tomorrow in Quezon City?",
    "look up reliable sources for this statement",
    "who originally developed this obscure game?",
    "why does this TypeScript function recurse forever?",
    "what exactly are they talking about here?",
    "compare these two mathematical arguments",
]

challenge_X = encoder.encode(
    challenge,
    normalize_embeddings=True,
    show_progress_bar=False,
)

for name, model in models.items():
    print("\n" + "=" * 70)
    print(name)

    model.fit(X_train, y_train)

    pred = np.clip(model.predict(X_test), 0, 1)

    print("\nvalidation MAE")
    for i, field in enumerate(FIELDS):
        mae = mean_absolute_error(y_test[:, i], pred[:, i])
        print(f"{field:18s} {mae:.3f}")

    print(
        f"{'overall':18s} "
        f"{mean_absolute_error(y_test, pred):.3f}"
    )

    cp = np.clip(model.predict(challenge_X), 0, 1)

    print("\nchallenge prompts")

    for prompt, values in zip(challenge, cp):
        print(f"\n{prompt}")
        for field, value in zip(FIELDS, values):
            print(f"  {field:18s} {value:.3f}")
