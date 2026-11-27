# Changelog

## 1.0.0 (2026-11-27)
- First public task set: 40 deterministic tasks, 10 each in JSON, extraction, classification and instruction following.
- Grader 1.0.0: strict JSON parse, normalised exact match, programmatic constraints. No LLM judge.
- Decoding: temperature 0, max_tokens 1024.
- Daily runner as a Cloudflare Worker (cron, D1) and a command-line runner.

A change to any task, to the grader or to the decoding settings gets a new set version, so charts never mix versions.
