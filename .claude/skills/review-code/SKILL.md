---
description: Review code from the local git repository for the specified LXC or component.
user-invocable: true
---

# /review-code — Code Review

Review code for the specified LXC or component. Finds bugs, security issues, error handling gaps, and performance problems.

## Input

If argument contains a LXC number or name, find all related code files in the local project using Glob and Grep.

LXC → local code mapping:
- LXC 100 / media → BOILER/dashboard/server.js media endpoints + any scripts/media* files
- LXC 103 / agents → agent scripts in the repo (boiler agent, wf96c_ingest, collect_weather, ha_api_patched, tuya_adapter_patched). Note: `ha_to_pg_updated.py` still on disk but cron removed 2026-04-23 — only review if user explicitly asks about the legacy fallback path.
- LXC 104 / timers → any cron/timer/scheduler scripts
- LXC 105 / orchestrator → orchestrator scripts + RULES/
- dashboard → BOILER/dashboard/server.js + public/js/*.js + public/*.html

If no argument given, ask which LXC or component to review.

## Steps

1. Find all relevant files using Glob
2. Read each file
3. Review all code for:
   - Bugs and logic errors
   - Security issues (hardcoded secrets, injection risks)
   - Error handling gaps (unhandled exceptions, missing try/catch)
   - Performance problems
   - Dead code or unused variables

4. **⚠ CRITICAL: VERIFY EVERY FINDING before reporting.**

   For EACH potential issue found:
   - Read the surrounding code (±20 lines) to check if the issue is already handled
   - Check if a guard/validation exists earlier in the function
   - Check if the variable is re-initialized on reconnect/retry
   - Check if the exception type is `Exception` (correct) vs bare `except:` (wrong)
   - Trace the data flow to confirm the bug is actually reachable
   
   **Common false positives to avoid:**
   - "float(None) will crash" — check if None is guarded earlier in the function
   - "variable not reset" — check if the outer loop re-initializes it on reconnect
   - "bare except swallows everything" — verify it's actually bare `except:` not `except Exception:`
   - "consecutive_failures never resets" — check if reset is inside the try block on success path
   - "inserts incomplete data" — check if this is intentional with explicit logging
   - "no token validation" — check if validation happens at a different point in the file

   **Benign patterns — DO NOT report even if theoretically unsafe:**
   - **Dict / list mutations under CPython GIL** where every single op is atomic AND the write is idempotent (multiple writers produce identical data). Example: cache `{"data": None, "ts": 0}` updated from multiple threads, each fetching the same DB row. The race exists but is benign.
   - **"Security concern" that doesn't match the deployment threat model.** If the code runs on a home LAN behind NAT and the attacker would need local network access, that's not a high-severity finding. State the threat model explicitly and match severity to realistic risk.
   - **State machines that self-heal within 1-2 evaluation ticks** after an edge case. E.g., a rule that mis-counts once after an engine restart but corrects on the next event. Note it in comments but don't flag as a bug.
   - **"Defense-in-depth suggestions"** — the code could be more robust but the current behavior is correct. These belong in documentation, not a bug report.

   **Verification by language — apply these beyond the generic ±20 line check:**

   - **JavaScript (async + promises)** — "no error handling on fetch" is a trap if you only look at lines.
     1. Walk UP past the enclosing `async function X() {` / `(async () => {` / `function X() {` — it can be 50+ lines above the fetch.
     2. Scan the entire function body for `try { ... } catch (e) {` OR any `.catch(...)` chained in the promise chain.
     3. Common idiom `await fetch(url).then(r => r.json())` inside an async function's `try { }` block IS correctly handled — a thrown JSON parse error is caught by the outer try. DO NOT flag.
     4. Only flag when the fetch is outside any try/catch AND has no `.catch()`. Quote the enclosing function's first line in the report.
   - **JavaScript (innerHTML XSS)** — safe sources include `toLocaleString` / `toLocaleTimeString` / `toLocaleDateString` / `toFixed` output (numeric/time — no HTML metachars by construction); already passed through `escHtml` / `escapeHtml` / `DOMPurify`; strongly-typed DB columns (INTEGER, NUMERIC, BOOLEAN). Only flag when the source is a free-form TEXT column AND not escaped.
   - **Python (exception propagation)** — before reporting "unhandled exception", walk UP to the enclosing function AND check the caller. Rule-engine rules don't need their own try/except because `rule_engine.py` wraps every `evaluate()` call in one already.
   - **SQL (injection)** — before reporting, check if the interpolated value passes through `_ALLOWED_TABLES` / `_ALLOWED_COLUMNS` regex allowlists (used throughout this codebase).

   **If you're not 100% sure the bug is real after reading the surrounding code, DO NOT report it.**

4b. **Second pass — drop anything without an observable failure.**
    For each surviving candidate, write a one-sentence scenario describing what the user would actually notice. If the sentence is "nothing observable" or "only theoretically under rare conditions" — drop the finding. The goal is a report the user can act on, not a catalog of hypotheticals.

    For JS specifically, the observable-failure sentence must name the exact enclosing function and confirm no try/catch. If you can't quote the enclosing function's signature line, you haven't verified enough.

4c. **When delegating to an Explore/Plan subagent.**
    The subagent only reports CANDIDATES. The main agent MUST re-verify every candidate before presenting to the user:
    1. Open the file at the claimed line
    2. Find the enclosing function's open and close braces/colons
    3. Confirm the claimed issue holds IN CONTEXT, not just at line scope
    4. Report both the subagent's candidate count AND the main-agent's post-verification count

    Pattern match in a subagent without a main-agent verification pass = false positives get shipped to the user. A single shared pattern (e.g., every `fetch().then` flagged while inside a try/catch) can cascade: 1 category × 7 occurrences = 7 retractions. Re-verify at function scope before reporting.

5. Report ONLY verified findings as a markdown table:
   File | Line | Issue | Severity | Concrete failure scenario | Suggested Fix

   **Severity calibration (be strict):**
   - **critical** — data loss, silent data corruption, service unavailability, or security breach reachable under the deployment's real threat model.
   - **high** — reproducible incorrect user-visible behavior; violates a documented invariant; data inconsistency that requires manual repair.
   - **medium** — happens occasionally under realistic conditions, has observable bad behavior but the system recovers without intervention.
   - **low** — observable behavior IS affected but rarely and briefly (e.g., one spurious timer fire per restart). If the user would never notice in practice, DON'T REPORT IT.

   Every row MUST include a "Concrete failure scenario" cell — one sentence describing what the user would observe. If you can't write one, the finding isn't real enough to report.

6. After the table, state how many initial candidates were found vs how many survived verification. Example: "Found 12 candidates, 3 verified as real issues (9 were false positives after reading surrounding code)."
