# Aleph AI production v1

Announcement release `9da9d2a` stays frozen. This release changes only AI inference, provider choice and scheduler behavior. Existing routing signals, tool permissions, retrieval policies, strict output validation, conversation history and Discord privacy boundaries remain in place.

Exact greetings/thanks return without a model. Raw arithmetic uses the existing calculator. Short fast/internal requests without demanding reasoning/coding markers use Phi. Existing standard/deep/external-knowledge routes use configured Groq GPT-OSS; explicit proof, derivation, debugging, coding, async, algorithm and integer-pair prompts cannot become easy/local through a mistaken fast classification. Private Discord lookup remains local.

Groq calls have a 45-second request budget inside the existing job budget. During retryable external failures, Phi may synthesize a non-deep answer only from already retrieved evidence; exact quote and source validation still controls publication. Hard reasoning, coding and unsupported vision never silently downgrade. The durable queue permits at most two provider deferrals, with a ten-minute overall recovery window, respecting Retry-After. Longer outages produce a concise temporary-failure response. No paid provider exists.

When verified web evidence is present, optional native tool calls are omitted from the synthesis request so the model focuses on the existing grounding selection protocol. Failed retrieval returns the existing honest refusal; no model may pretend a failed tool succeeded.

Production enables `COGNITIVE_ROUTING=true` and the existing Groq external config for `openai/gpt-oss-120b`, preserving Phi's endpoint, service token, database, web key, tools and sandbox settings. Deploy only the changed AI JavaScript modules and restart only `aleph-zero-ai`. Preserve announcement config/code, worker PID and bot PID, and retain an AI config/code/SQLite backup.

Deferred: further classifier calibration beyond the prior 88/120 route evidence; broader answer evaluations; vision support; enabling the currently disabled Python sandbox. These are not prerequisites for this text-first v1. No new full model matrix is required.
