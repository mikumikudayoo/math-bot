#!/usr/bin/env python3

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.neighbors import KNeighborsRegressor


HOST = "127.0.0.1"
PORT = 8789

TRAIN = Path("data/router-gold-v2.jsonl")

FIELDS = [
    "reasoning",
    "freshness",
    "externalKnowledge",
    "ambiguity",
    "verificationNeed",
    "calculation",
]


def load_training_data():
    prompts = []
    targets = []

    with TRAIN.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            row = json.loads(line)
            prompts.append(row["prompt"])
            targets.append([float(row[field]) for field in FIELDS])

    return prompts, np.asarray(targets, dtype=np.float32)


print("router sensor: loading MiniLM...", flush=True)

encoder = SentenceTransformer(
    "sentence-transformers/all-MiniLM-L6-v2",
    backend="onnx",
    model_kwargs={
        "file_name": "onnx/model_qint8_arm64.onnx",
        "provider": "CPUExecutionProvider",
    },
)

train_prompts, targets = load_training_data()

print(
    f"router sensor: embedding {len(train_prompts)} training examples...",
    flush=True,
)

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

print("router sensor: KNN ready", flush=True)


def predict(clauses):
    x = encoder.encode(
        clauses,
        normalize_embeddings=True,
        show_progress_bar=False,
    )

    values = np.clip(model.predict(x), 0, 1)

    return [
        {
            field: float(row[index])
            for index, field in enumerate(FIELDS)
        }
        for row in values
    ]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/signals":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))

            if length <= 0 or length > 64 * 1024:
                raise ValueError("invalid request size")

            body = json.loads(
                self.rfile.read(length).decode("utf-8")
            )

            clauses = body.get("clauses")

            if not isinstance(clauses, list):
                raise ValueError("clauses must be an array")

            if not 1 <= len(clauses) <= 16:
                raise ValueError("clauses must contain 1-16 items")

            if not all(
                isinstance(clause, str)
                and 1 <= len(clause) <= 4000
                for clause in clauses
            ):
                raise ValueError(
                    "each clause must be a non-empty string <= 4000 characters"
                )

            result = {
                "signals": predict(clauses),
            }

            payload = json.dumps(
                result,
                separators=(",", ":"),
            ).encode("utf-8")

            self.send_response(200)
            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_header(
                "Content-Length",
                str(len(payload)),
            )
            self.end_headers()
            self.wfile.write(payload)

        except (
            ValueError,
            TypeError,
            KeyError,
            json.JSONDecodeError,
        ) as exc:
            payload = json.dumps(
                {"error": str(exc)},
                separators=(",", ":"),
            ).encode("utf-8")

            self.send_response(400)
            self.send_header(
                "Content-Type",
                "application/json; charset=utf-8",
            )
            self.send_header(
                "Content-Length",
                str(len(payload)),
            )
            self.end_headers()
            self.wfile.write(payload)

    def log_message(self, format, *args):
        return


server = ThreadingHTTPServer((HOST, PORT), Handler)

print(
    f"router sensor: listening on http://{HOST}:{PORT}",
    flush=True,
)

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nrouter sensor: shutting down", flush=True)
finally:
    server.server_close()
