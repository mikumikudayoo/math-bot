import json
from pathlib import Path

SOURCE = Path("data/router-gold.jsonl")
OUT = Path("data/router-gold-expanded.jsonl")

FIELDS = [
    "reasoning",
    "freshness",
    "externalKnowledge",
    "ambiguity",
    "verificationNeed",
    "calculation",
]

def sig(r=0, f=0, e=0, a=0, v=0, c=0):
    return dict(
        reasoning=r,
        freshness=f,
        externalKnowledge=e,
        ambiguity=a,
        verificationNeed=v,
        calculation=c,
    )

groups = [
    ("casual", sig(a=.03), [
        "hey!",
        "good afternoon",
        "thanks lol",
        "lmao",
        "how are you?",
        "yo gng",
        "niceee",
        "okok",
        "that's wild",
        "what 😭",
    ]),

    ("assistant_identity", sig(r=.06, a=.03), [
        "what's your name?",
        "who created you?",
        "who made you?",
        "what are you?",
        "what is Aleph-Zero?",
        "tell me who you are",
        "what do you want to become one day?",
        "what's your dream?",
        "are you Aleph-Zero?",
        "who's your owner?",
    ]),

    ("simple_arithmetic", sig(r=.04, c=.98), [
        "what is 12 times 7?",
        "calculate 48 + 93",
        "144 divided by 12",
        "what is 18% of 350?",
        "compute 17 squared",
        "5 + 8 * 3",
        "what is 999 minus 417?",
        "multiply 26 by 14",
        "what is the sum of 81 and 29?",
        "divide 625 by 25",
    ]),

    ("basic_algebra", sig(r=.28, c=.72), [
        "solve 2x + 5 = 17",
        "solve 4x - 9 = 11",
        "find x if 3x = 27",
        "solve x/5 + 2 = 6",
        "factor x^2 + 5x + 6",
        "simplify 3(x + 4) - 2x",
        "solve x^2 = 49",
        "find the roots of x^2 - 9",
        "solve 7 - 2x = 15",
        "expand (x + 3)(x - 2)",
    ]),

    ("hard_math_reasoning", sig(r=.84, e=.04, a=.06, c=.22), [
        "prove that sqrt(2) is irrational",
        "prove there are infinitely many prime numbers",
        "prove the sum of two odd integers is even",
        "show that every integer squared is congruent to 0 or 1 modulo 4",
        "prove the pigeonhole principle",
        "derive the quadratic formula from completing the square",
        "prove that the harmonic series diverges",
        "prove by induction that 1+2+...+n = n(n+1)/2",
        "show that no largest integer exists",
        "prove that the product of two odd integers is odd",
    ]),

    ("competition_math", sig(r=.88, e=.05, a=.10, c=.42), [
        "find the largest integer n satisfying this divisibility condition",
        "how many objects guarantee three disjoint pairs of different types?",
        "solve this olympiad number theory problem",
        "find all integer triples satisfying this equation",
        "prove this combinatorics bound is optimal",
        "find the minimum number that guarantees a repeated remainder",
        "solve this geometry problem without coordinates",
        "find the maximum possible value under these constraints",
        "determine all positive integers satisfying this recurrence",
        "prove this inequality for all positive real numbers",
    ]),

    ("science_explanation", sig(r=.27, e=.22, a=.05), [
        "explain cellular respiration",
        "why do objects fall toward Earth?",
        "what causes tides?",
        "explain natural selection",
        "what is DNA replication?",
        "why does ice float?",
        "explain Newton's third law",
        "why do metals conduct electricity?",
        "what causes seasons?",
        "explain how vaccines train the immune system",
    ]),

    ("writing_language", sig(r=.23, a=.12), [
        "rewrite this to sound more formal",
        "make this paragraph clearer",
        "shorten this sentence without changing its meaning",
        "translate this sentence into French",
        "fix the grammar in this paragraph",
        "make this sound less repetitive",
        "summarize this paragraph in one sentence",
        "turn these notes into a short explanation",
        "rephrase this so a Grade 10 student can understand it",
        "make this response more concise",
    ]),

    ("code_debugging", sig(r=.72, e=.08, a=.20, c=.06), [
        "why is this JavaScript function returning undefined?",
        "debug this infinite loop",
        "why does this recursive function overflow the stack?",
        "find the race condition in this async code",
        "why is my Socket.IO event firing twice?",
        "debug this TypeScript type error",
        "why does this SQL query return duplicate rows?",
        "find the bug in this binary search implementation",
        "why is this promise never resolving?",
        "explain why this code has an off-by-one error",
    ]),

    ("planning_design", sig(r=.68, e=.08, a=.28), [
        "design a retry strategy for a job queue",
        "plan a database migration with rollback support",
        "design a permissions system for a Discord bot",
        "plan how to split this project into modules",
        "design a caching strategy for this API",
        "how should I structure a plugin system?",
        "plan a safe deployment process",
        "design a rate limiter for this service",
        "how should I organize this test suite?",
        "design a queue with priority users and normal users",
    ]),

    ("current_info", sig(r=.14, f=.97, e=.95, a=.06, v=.90), [
        "what's the weather in Manila today?",
        "what is the current USD to PHP exchange rate?",
        "what is the current gold price?",
        "what time does this event start today?",
        "what is the latest version of this software?",
        "is this website currently down?",
        "what is the temperature in Singapore right now?",
        "what's the current price of Bitcoin?",
        "what is today's forecast?",
        "what is the current schedule for this tournament?",
    ]),

    ("current_situation", sig(r=.50, f=.88, e=.95, a=.30, v=.90), [
        "what's going on with Pax Silica right now?",
        "what happened in the news today?",
        "what are the latest developments in this court case?",
        "what changed in this project this week?",
        "what is the current situation with this outage?",
        "what happened with this company recently?",
        "summarize the latest developments in this conflict",
        "what changed in the newest policy update?",
        "what's happening with this game release?",
        "what are people reporting about this issue today?",
    ]),

    ("verification", sig(r=.25, f=.28, e=.86, a=.20, v=.99), [
        "search for sources about this claim",
        "verify whether this statement is true",
        "fact-check this statistic",
        "find a reliable source for this",
        "look this up and cite your sources",
        "can you verify this quote?",
        "check whether this story is accurate",
        "find evidence supporting or contradicting this claim",
        "give me sources for this information",
        "search the web before answering this",
    ]),

    ("obscure_factual", sig(r=.14, f=.05, e=.91, a=.12, v=.78), [
        "who composed this obscure game soundtrack?",
        "when was this small organization founded?",
        "who voiced this character in the original release?",
        "what year did this obscure competition begin?",
        "who designed this specific historical machine?",
        "where was this little-known film first screened?",
        "which developer created this old mod?",
        "who won the first edition of this minor tournament?",
        "what company manufactured this discontinued device?",
        "where did this uncommon phrase originate?",
    ]),

    ("specific_factual", sig(r=.12, f=.04, e=.72, a=.04, v=.55), [
        "who provides Hatsune Miku's voice?",
        "who wrote Frankenstein?",
        "where is Mount Fuji?",
        "when was Python first released?",
        "who composed Clair de Lune?",
        "what country is Machu Picchu in?",
        "who created the C programming language?",
        "when did the first iPhone launch?",
        "who painted The Starry Night?",
        "where is the Louvre located?",
    ]),

    ("ambiguous_context", sig(r=.34, f=.05, e=.08, a=.94, v=.05), [
        "what did they mean by that?",
        "why did it happen again?",
        "is this the same thing as before?",
        "what should I do about it?",
        "why is it doing that?",
        "which one did they mean?",
        "what happened there?",
        "is that normal?",
        "why would someone say that?",
        "what does this refer to?",
    ]),

    ("analysis_comparison", sig(r=.64, e=.03, a=.18), [
        "compare these two arguments and identify their assumptions",
        "which steps differ between these two solutions?",
        "explain why these two explanations reach different conclusions",
        "compare these algorithms conceptually",
        "find the contradiction between these two statements",
        "analyze the tradeoffs between these two designs",
        "compare these proofs without judging which is better",
        "identify what changed between these two versions",
        "explain the logical difference between these claims",
        "compare these approaches step by step",
    ]),

    ("chess_game_analysis", sig(r=.76, e=.04, a=.22, c=.08), [
        "analyze this chess position for tactics",
        "find the best continuation from this position",
        "why was this chess move a blunder?",
        "calculate the forcing sequence after this check",
        "analyze this endgame position",
        "what tactical motif did I miss here?",
        "find the strongest defensive move",
        "explain why this position is losing",
        "analyze this opening mistake",
        "find the mating idea in this position",
    ]),

    ("server_specific", sig(r=.32, f=.18, e=.86, a=.18, v=.70), [
        "what are the rules in the Mathematikaws server?",
        "when is the next server competition?",
        "what did the moderators announce about registrations?",
        "which channel contains the competition rules?",
        "what was the latest server announcement?",
        "what does this server role mean?",
        "who posted the announcement about the pretest?",
        "what did staff say about the deadline?",
        "find the old discussion about this competition",
        "what are the server's rules for QOTD submissions?",
    ]),
]

existing = []
for line in SOURCE.read_text().splitlines():
    if not line.strip():
        continue
    row = json.loads(line)
    row.setdefault("category", "manual_v1")
    existing.append(row)

rows = list(existing)

for category, values, prompts in groups:
    for prompt in prompts:
        rows.append({
            "prompt": prompt,
            "category": category,
            **values,
        })

# Deduplicate exact prompts while keeping the manually-created version first.
seen = set()
deduped = []

for row in rows:
    key = row["prompt"].strip().casefold()
    if key in seen:
        continue
    seen.add(key)
    deduped.append(row)

for i, row in enumerate(deduped, 1):
    for field in FIELDS:
        value = row[field]
        if not isinstance(value, (int, float)) or not 0 <= value <= 1:
            raise ValueError(f"row {i} invalid {field}: {value}")

with OUT.open("w") as f:
    for row in deduped:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")

print(f"existing: {len(existing)}")
print(f"generated before dedupe: {len(rows)}")
print(f"final: {len(deduped)}")
print(f"saved: {OUT}")
