import json
from pathlib import Path

SRC = Path("data/router-gold-expanded.jsonl")
OUT = Path("data/router-gold-v2.jsonl")

def row(prompt, r, f, e, a, v, c, category):
    return {
        "prompt": prompt,
        "category": category,
        "reasoning": r,
        "freshness": f,
        "externalKnowledge": e,
        "ambiguity": a,
        "verificationNeed": v,
        "calculation": c,
    }

extra = [
    # reasoning-heavy critique / proof work
    row("identify the flaw in this proof", .72, 0, .03, .15, 0, .05, "reasoning_v2"),
    row("explain why this mathematical argument fails", .70, 0, .03, .18, 0, .05, "reasoning_v2"),
    row("find a counterexample to this statement", .76, 0, .03, .15, 0, .05, "reasoning_v2"),
    row("show why this claim is false by constructing an example", .74, 0, .03, .18, 0, .05, "reasoning_v2"),
    row("analyze whether this proof is logically valid", .72, 0, .05, .20, .05, .03, "reasoning_v2"),

    # architecture / systems reasoning
    row("design retries that cannot process the same task twice", .74, 0, .05, .20, 0, .03, "reasoning_v2"),
    row("how should I prevent duplicate processing after a crash?", .72, 0, .06, .22, 0, .03, "reasoning_v2"),
    row("reason about failure recovery in this queue system", .70, 0, .05, .22, 0, .03, "reasoning_v2"),
    row("design idempotency for this job worker", .72, 0, .05, .18, 0, .02, "reasoning_v2"),

    # vague context should imply interpretation work
    row("why would they do that?", .45, .05, .05, .88, .03, 0, "ambiguity_v2"),
    row("what are they referring to?", .42, .03, .05, .92, .03, 0, "ambiguity_v2"),
    row("what does that part refer to?", .42, .02, .03, .90, .02, 0, "ambiguity_v2"),
    row("why did they say that?", .45, .05, .05, .88, .03, 0, "ambiguity_v2"),
    row("which thing do they mean here?", .42, .02, .04, .93, .02, 0, "ambiguity_v2"),

    # mixed reasoning + explicit verification
    row("verify this lemma and explain why it is true", .68, .20, .82, .15, .95, .03, "mixed_v2"),
    row("check whether this theorem is stated correctly and explain it", .68, .20, .82, .15, .95, .03, "mixed_v2"),
    row("look up the newest Python release and explain the main change", .58, .92, .95, .10, .88, .02, "mixed_v2"),
    row("find the newest Node.js version and summarize what changed", .58, .92, .95, .10, .88, .02, "mixed_v2"),
    row("search for this result and explain the proof", .72, .35, .88, .12, .95, .03, "mixed_v2"),

    # lexical traps: these words do NOT imply fresh info
    row("what does the word latest mean?", .12, 0, .05, .05, 0, 0, "lexical_v2"),
    row("define the word current", .12, 0, .05, .05, 0, 0, "lexical_v2"),
    row("what does recent mean in this sentence?", .15, 0, .05, .12, 0, 0, "lexical_v2"),
    row("explain the meaning of news as a word", .12, 0, .05, .05, 0, 0, "lexical_v2"),
    row("what does today mean grammatically?", .15, 0, .05, .08, 0, 0, "lexical_v2"),
]

rows = [
    json.loads(line)
    for line in SRC.read_text().splitlines()
    if line.strip()
]

seen = {r["prompt"].strip().casefold() for r in rows}

for r in extra:
    key = r["prompt"].strip().casefold()
    if key not in seen:
        rows.append(r)
        seen.add(key)

with OUT.open("w") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

print(f"old: {len(rows) - len(extra)}")
print(f"new examples requested: {len(extra)}")
print(f"final: {len(rows)}")
print(f"saved: {OUT}")
