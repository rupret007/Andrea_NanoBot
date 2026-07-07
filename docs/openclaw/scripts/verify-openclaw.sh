#!/usr/bin/env bash
set -euo pipefail

summarize_agent_json() {
  node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const start = s.indexOf("{");
  if (start < 0) {
    console.log(s.trim());
    process.exit(1);
  }
  const j = JSON.parse(s.slice(start));
  const meta = j.result?.meta?.agentMeta ?? {};
  const trace = j.result?.meta?.executionTrace ?? {};
  const summary = {
    status: j.status,
    text: j.result?.payloads?.[0]?.text ?? null,
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    fallbackUsed: trace.fallbackUsed ?? false,
    toolSummary: j.result?.meta?.toolSummary ?? null,
  };
  console.log(JSON.stringify(summary, null, 2));
});
'
}

echo "== Gateway =="
openclaw gateway status

echo
echo "== Config =="
openclaw config validate --json

echo
echo "== Models =="
openclaw models status

echo
echo "== Plugins =="
openclaw plugins doctor

echo
echo "== Channels =="
openclaw channels status --json || true

echo
echo "== Andrea BlueBubbles MCP =="
openclaw mcp probe andrea-bluebubbles --json

echo
echo "== MiniMax Smoke Test =="
openclaw agent \
  --session-key agent:main:ops-minimax-smoke \
  --message 'Ops smoke test. Reply exactly OK_MINIMAX_OPS.' \
  --timeout 120 \
  --json | summarize_agent_json

echo
echo "== Brave Search Smoke Test =="
openclaw agent \
  --session-key agent:main:ops-brave-smoke \
  --message 'Use web_search once for query "OpenClaw Brave Search". Reply exactly OK_BRAVE_OPS if search worked.' \
  --timeout 180 \
  --json | summarize_agent_json
