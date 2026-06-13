#!/usr/bin/env python3
"""
Seed realistic fixture data into the agent-profiler server.
Uses the exact attribute names the ingest normaliser expects.

Usage:
  python3 scripts/seed-fixtures.py
  python3 scripts/seed-fixtures.py --endpoint http://localhost:7070
"""
import argparse
import json
import time
import urllib.request
import uuid

def kv(key, value):
    return {"key": key, "value": {"stringValue": str(value)}}

def span(trace_id, span_id, parent_id, name, kind_int,
         start_ns, end_ns, attrs, status_code="STATUS_CODE_OK"):
    s = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": kind_int,
        "startTimeUnixNano": str(start_ns),
        "endTimeUnixNano": str(end_ns),
        "attributes": attrs,
        "status": {"code": status_code},
    }
    if parent_id:
        s["parentSpanId"] = parent_id
    return s

def post(endpoint, payload):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{endpoint}/v1/traces",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return r.status

def make_session(harness="opencode", agent="my-agent", model="claude-sonnet-4-5",
                 seed=0):
    """
    Build a two-turn session trace with:
      Turn 1: high cache hit (90%), 1 LLM call, 2 tool calls
      Turn 2: low cache hit (12%), 2 LLM calls, 0 tool calls  ← expensive turn
    """
    rng = lambda: uuid.uuid4().hex[:16]
    now = int(time.time() * 1e9) - seed * 3_600_000_000_000  # stagger sessions

    S = int(1e9)  # 1 second in nanoseconds

    trace  = rng()
    root   = rng()
    t1_id  = rng()
    l1_id  = rng()
    to1_id = rng()
    to2_id = rng()
    t2_id  = rng()
    l2_id  = rng()
    l3_id  = rng()

    input_msgs_t1 = json.dumps([
        {"message": {"role": "system",    "content": "You are a helpful coding assistant. You have access to read_file and bash tools. Always write clean, idiomatic Python."}},
        {"message": {"role": "user",      "content": "Write a function to sort a list"}},
    ])
    output_msgs_t1 = json.dumps([
        {"message": {"role": "assistant", "content": "Here's a clean Python sort function:\n\n```python\ndef sort_list(items, reverse=False):\n    \"\"\"Sort a list in ascending order by default.\"\"\"\n    return sorted(items, reverse=reverse)\n```\n\nThis uses Python's built-in `sorted()` which is stable and O(n log n)."}}
    ])
    tool1_output = json.dumps({"content": "def sort_list(items):\n    return sorted(items)\n", "exit_code": 0})
    tool2_output = json.dumps({"content": "........\n8 passed in 0.03s", "exit_code": 0})

    input_msgs_t2_l1 = json.dumps([
        {"message": {"role": "system",    "content": "You are a helpful coding assistant. You have access to read_file and bash tools. Always write clean, idiomatic Python."}},
        {"message": {"role": "user",      "content": "Write a function to sort a list"}},
        {"message": {"role": "assistant", "content": "Here's a clean Python sort function..."}},
        {"message": {"role": "user",      "content": "Now add type hints and docstrings to all functions in the codebase"}},
    ])
    output_msgs_t2_l1 = json.dumps([
        {"message": {"role": "assistant", "content": "I'll read the current files first to understand what needs type annotations."}}
    ])
    input_msgs_t2_l2 = json.dumps([
        {"message": {"role": "system",    "content": "You are a helpful coding assistant. You have access to read_file and bash tools. Always write clean, idiomatic Python."}},
        {"message": {"role": "user",      "content": "Write a function to sort a list"}},
        {"message": {"role": "assistant", "content": "Here's a clean Python sort function..."}},
        {"message": {"role": "user",      "content": "Now add type hints and docstrings to all functions in the codebase"}},
        {"message": {"role": "assistant", "content": "I'll read the current files first..."}},
        {"message": {"role": "tool",      "content": "def sort_list(items):\n    return sorted(items)\n"}},
    ])
    output_msgs_t2_l2 = json.dumps([
        {"message": {"role": "assistant", "content": "Here are the updated functions with type hints and docstrings:\n\n```python\nfrom typing import List, TypeVar\n\nT = TypeVar('T')\n\ndef sort_list(items: List[T], reverse: bool = False) -> List[T]:\n    \"\"\"\n    Sort a list in ascending order.\n\n    Args:\n        items: The list to sort.\n        reverse: If True, sort in descending order.\n\n    Returns:\n        A new sorted list.\n    \"\"\"\n    return sorted(items, reverse=reverse)\n```"}}
    ])

    prompt_segs_l1 = json.dumps([
        {"ord": 0, "source_kind": "system",       "source_name": "system-prompt",   "char_len": 140, "is_static": True,  "sha256": "aabbcc001"},
        {"ord": 1, "source_kind": "tool",          "source_name": "read_file-def",   "char_len": 320, "is_static": True,  "sha256": "aabbcc002"},
        {"ord": 2, "source_kind": "tool",          "source_name": "bash-def",        "char_len": 290, "is_static": True,  "sha256": "aabbcc003"},
        {"ord": 3, "source_kind": "user",          "source_name": "user-message",    "char_len": 38,  "is_static": False, "sha256": "aabbcc004"},
    ])
    prompt_segs_l2 = json.dumps([
        {"ord": 0, "source_kind": "system",       "source_name": "system-prompt",   "char_len": 140, "is_static": True,  "sha256": "aabbcc001"},
        {"ord": 1, "source_kind": "tool",          "source_name": "read_file-def",   "char_len": 320, "is_static": True,  "sha256": "aabbcc002"},
        {"ord": 2, "source_kind": "tool",          "source_name": "bash-def",        "char_len": 290, "is_static": True,  "sha256": "aabbcc003"},
        {"ord": 3, "source_kind": "assistant",     "source_name": "prior-turn-1",    "char_len": 220, "is_static": False, "sha256": "aabbcc010"},
        {"ord": 4, "source_kind": "user",          "source_name": "user-message",    "char_len": 62,  "is_static": False, "sha256": "aabbcc011"},
    ])

    spans = [
        # ── Root / session span ────────────────────────────────────────────────
        span(trace, root, None, "openinference.chain", 2,
             now, now + 14 * S,
             [
                 kv("openinference.span.kind", "CHAIN"),
                 kv("agent.name",              agent),
                 kv("llm.model_name",          model),
                 kv("session.id",              trace),
             ]),

        # ── Turn 1: high cache hit ─────────────────────────────────────────────
        span(trace, t1_id, root, "turn", 2,
             now, now + 5 * S,
             [
                 kv("openinference.span.kind", "CHAIN"),
                 kv("input.value",  "Write a function to sort a list"),
                 kv("output.value", "Here's a clean Python sort function:\n\n```python\ndef sort_list(items, reverse=False):\n    \"\"\"Sort a list in ascending order by default.\"\"\"\n    return sorted(items, reverse=reverse)\n```"),
             ]),
        # LLM call 1 — 90% cache hit
        span(trace, l1_id, t1_id, "LLM", 3,
             now + 300 * int(1e6), now + 2800 * int(1e6),
             [
                 kv("openinference.span.kind",                   "LLM"),
                 kv("llm.model_name",                            model),
                 kv("llm.provider",                              "anthropic"),
                 kv("llm.token_count.prompt",                    "4200"),
                 kv("llm.token_count.completion",                "350"),
                 kv("llm.token_count.prompt_details.cache_read", "3800"),
                 kv("llm.token_count.prompt_details.cache_write","400"),
                 kv("llm.cost.total",                            "0.00245"),
                 kv("llm.input_messages",                        input_msgs_t1),
                 kv("llm.output_messages",                       output_msgs_t1),
                 kv("prompt.segments",                           prompt_segs_l1),
             ]),
        # Tool 1: read_file
        span(trace, to1_id, t1_id, "read_file", 3,
             now + 100 * int(1e6), now + 400 * int(1e6),
             [
                 kv("openinference.span.kind", "TOOL"),
                 kv("tool.name",    "read_file"),
                 kv("input.value",  json.dumps({"path": "src/sort.py"})),
                 kv("output.value", tool1_output),
             ]),
        # Tool 2: bash
        span(trace, to2_id, t1_id, "bash", 3,
             now + 3 * S, now + 5 * S,
             [
                 kv("openinference.span.kind", "TOOL"),
                 kv("tool.name",    "bash"),
                 kv("input.value",  json.dumps({"cmd": "python -m pytest tests/ -q"})),
                 kv("output.value", tool2_output),
             ]),

        # ── Turn 2: low cache hit, two LLM round-trips ─────────────────────────
        span(trace, t2_id, root, "turn", 2,
             now + 5 * S, now + 14 * S,
             [
                 kv("openinference.span.kind", "CHAIN"),
                 kv("input.value",  "Now add type hints and docstrings to all functions in the codebase"),
                 kv("output.value", "Here are the updated functions with type hints and docstrings:\n\n```python\nfrom typing import List, TypeVar\n\nT = TypeVar('T')\n\ndef sort_list(items: List[T], reverse: bool = False) -> List[T]:\n    ...\n```"),
             ]),
        # LLM call 2 — low cache (11%), planning step
        span(trace, l2_id, t2_id, "LLM", 3,
             now + 5 * S + 100 * int(1e6), now + 9 * S,
             [
                 kv("openinference.span.kind",                   "LLM"),
                 kv("llm.model_name",                            model),
                 kv("llm.provider",                              "anthropic"),
                 kv("llm.token_count.prompt",                    "9800"),
                 kv("llm.token_count.completion",                "280"),
                 kv("llm.token_count.prompt_details.cache_read", "1100"),
                 kv("llm.token_count.prompt_details.cache_write","8700"),
                 kv("llm.cost.total",                            "0.01320"),
                 kv("llm.input_messages",                        input_msgs_t2_l1),
                 kv("llm.output_messages",                       output_msgs_t2_l1),
                 kv("prompt.segments",                           prompt_segs_l2),
             ]),
        # LLM call 3 — high cache (88%), synthesis step
        span(trace, l3_id, t2_id, "LLM", 3,
             now + 9 * S, now + 13 * S,
             [
                 kv("openinference.span.kind",                   "LLM"),
                 kv("llm.model_name",                            model),
                 kv("llm.provider",                              "anthropic"),
                 kv("llm.token_count.prompt",                    "11200"),
                 kv("llm.token_count.completion",                "820"),
                 kv("llm.token_count.prompt_details.cache_read", "9900"),
                 kv("llm.token_count.prompt_details.cache_write","1300"),
                 kv("llm.cost.total",                            "0.00890"),
                 kv("llm.input_messages",                        input_msgs_t2_l2),
                 kv("llm.output_messages",                       output_msgs_t2_l2),
                 kv("prompt.segments",                           prompt_segs_l2),
             ]),
    ]

    return {
        "resourceSpans": [{
            "resource": {
                "attributes": [kv("harness", harness)]
            },
            "scopeSpans": [{"spans": spans}]
        }]
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://localhost:7070")
    args = parser.parse_args()

    sessions = [
        dict(harness="opencode", agent="my-agent",     model="claude-sonnet-4-5", seed=0),
        dict(harness="opencode", agent="my-agent",     model="claude-sonnet-4-5", seed=1),
        dict(harness="vscode",   agent="copilot-agent",model="gpt-4o",            seed=2),
    ]

    for i, s in enumerate(sessions):
        payload = make_session(**s)
        status = post(args.endpoint, payload)
        print(f"  [{i+1}/{len(sessions)}] {s['harness']}/{s['agent']} ({s['model']}) → HTTP {status}")

    print(f"\nDone. Open {args.endpoint} to explore.")

if __name__ == "__main__":
    main()
