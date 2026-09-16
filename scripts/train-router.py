import json
from pathlib import Path

import joblib
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error
from sklearn.model_selection import train_test_split

DATA = Path("data/router-gold.jsonl")
MODEL_OUT = Path("data/router-head.joblib")

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

prompts = [row["prompt"] for row in rows]
targets = np.array(
    [[row[field] for field in FIELDS] for row in rows],
    dtype=np.float32,
)

print(f"loaded {len(rows)} gold examples")
print("loading MiniLM...")

encoder = SentenceTransformer(
    "sentence-transformers/all-MiniLM-L6-v2",
    backend="onnx",
    model_kwargs={
        "file_name": "onnx/model_qint8_arm64.onnx",
        "provider": "CPUExecutionProvider",
    },
)

print("embedding dataset...")
embeddings = encoder.encode(
    prompts,
    normalize_embeddings=True,
    show_progress_bar=False,
)

X_train, X_test, y_train, y_test = train_test_split(
    embeddings,
    targets,
    test_size=0.25,
    random_state=42,
)

model = Ridge(alpha=5.0)
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

# Retrain on all gold data for the experimental saved head.
model.fit(embeddings, targets)

MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
joblib.dump(
    {
        "fields": FIELDS,
        "model": model,
    },
    MODEL_OUT,
)

print(f"\nsaved {MODEL_OUT}")

tests = [
    "HELLO!~!☆✧･ﾟ: *✧･ﾟ:* Im Emu Otori! Emu...means SMILE!!",
    "what is the product of 3 and 8",
    "What is the Pax Silica situation in the Philippines?",
    "prove that infinitely many primes exist",
    "explain photosynthesis",
]

test_embeddings = encoder.encode(
    tests,
    normalize_embeddings=True,
    show_progress_bar=False,
)

test_pred = np.clip(model.predict(test_embeddings), 0, 1)

print("\nbenchmark prompts")

for prompt, values in zip(tests, test_pred):
    print("\n" + prompt)
    for field, value in zip(FIELDS, values):
        print(f"  {field:18s} {value:.3f}")
