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
   
   **If you're not 100% sure the bug is real after reading the surrounding code, DO NOT report it.**

5. Report ONLY verified findings as a markdown table:
   File | Line | Issue | Severity (critical/high/medium/low) | Suggested Fix

6. After the table, state how many initial candidates were found vs how many survived verification. Example: "Found 12 candidates, 3 verified as real issues (9 were false positives after reading surrounding code)."
