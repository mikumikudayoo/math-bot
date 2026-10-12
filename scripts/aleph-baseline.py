import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOLDOUT = ROOT / "training/aleph/holdout.jsonl"
OUTPUT = ROOT / "data/benchmarks"
URL = "http://127.0.0.1:8082/v1/chat/completions"
MODEL = "lmstudio-community/Phi-4-mini-instruct-GGUF:Q4_K_M"

OUTPUT.mkdir(parents=True, exist_ok=True)

examples = [
    json.loads(line)
    for line in HOLDOUT.read_text(encoding="utf-8").splitlines()
    if line.strip()
]

if len(examples) != 10:
    raise RuntimeError(f"Expected 10 holdout examples, found {len(examples)}")

results = []

for example in examples:
    messages = example["messages"]

    if messages[-1]["role"] != "assistant":
        raise RuntimeError(f"Missing expected answer: {example['id']}")

    # Never send the expected answer to the model.
    prompt_messages = messages[:-1]

    payload = {
        "model": MODEL,
        "messages": prompt_messages,
        "temperature": 0,
        "max_tokens": 512,
    }

    request = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    print(f"Testing {example['id']}...", flush=True)
    start = time.monotonic()

    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            body = json.load(response)

        answer = body["choices"][0]["message"]["content"]
        error = None

    except Exception as exc:
        answer = None
        error = str(exc)

    results.append({
        "id": example["id"],
        "semanticGroup": example["semanticGroup"],
        "expected": messages[-1]["content"],
        "answer": answer,
        "error": error,
        "seconds": round(time.monotonic() - start, 2),
    })

    print(f"  done in {results[-1]['seconds']}s", flush=True)

timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
path = OUTPUT / f"aleph-baseline-{timestamp}.json"

path.write_text(
    json.dumps({
        "model": MODEL,
        "dataset": "aleph-v1-holdout",
        "temperature": 0,
        "max_tokens": 512,
        "results": results,
    }, indent=2, ensure_ascii=False),
    encoding="utf-8",
)

print(f"\nSaved baseline to {path}")
print(f"Successful: {sum(r['error'] is None for r in results)}/{len(results)}")
