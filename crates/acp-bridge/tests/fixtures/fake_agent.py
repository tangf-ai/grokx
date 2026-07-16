#!/usr/bin/env python3
"""Minimal ACP agent over stdio for bridge integration tests.

Protocol: newline-delimited JSON-RPC 2.0.
After session/new, optionally emits a parked permission request (when
FAKE_AGENT_PERMISSION=1) that must be answered before session/prompt completes.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time


def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> None:
    emit_perm = os.environ.get("FAKE_AGENT_PERMISSION", "0") == "1"
    session_id = "fake-engine-session-1"
    perm_rpc_id = 9001
    perm_answered = threading.Event()
    perm_outcome: dict = {}

    # Drain nothing; process line by line
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Client → agent response (permission answer)
        if "id" in msg and "method" not in msg:
            if msg.get("id") == perm_rpc_id:
                perm_outcome["value"] = msg
                perm_answered.set()
            continue

        method = msg.get("method")
        mid = msg.get("id")
        params = msg.get("params") or {}

        if method == "initialize":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": {},
                        "authMethods": [],
                    },
                }
            )
        elif method == "authenticate":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "session/new":
            send(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {"sessionId": session_id},
                }
            )
            if emit_perm:
                # Server-initiated permission request (has method + id)
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": perm_rpc_id,
                        "method": "session/request_permission",
                        "params": {
                            "sessionId": session_id,
                            "toolCall": {
                                "toolCallId": "tc-1",
                                "title": "Bash",
                                "kind": "execute",
                                "rawInput": {"command": "echo hello"},
                            },
                        },
                    }
                )
        elif method == "session/prompt":
            # If permission was required, wait until client answers it.
            if emit_perm and not perm_answered.wait(timeout=10):
                send(
                    {
                        "jsonrpc": "2.0",
                        "id": mid,
                        "error": {
                            "code": -32000,
                            "message": "permission never answered",
                        },
                    }
                )
                continue
            # Stream a tiny message then finish the prompt RPC.
            send(
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"text": "pong"},
                        },
                    },
                }
            )
            outcome = perm_outcome.get("value") or {}
            result = {"stopReason": "end_turn"}
            if outcome:
                result["permissionOutcome"] = outcome.get("result")
            send({"jsonrpc": "2.0", "id": mid, "result": result})
        elif method == "session/cancel":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        else:
            # Unknown: ack if request
            if mid is not None:
                send({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
