#!/usr/bin/env bash
# One-shot acceptance check: every step must succeed.
#
#   ./tools/verify.sh          - contracts, client, static analysis, e2e artefacts
#   ./tools/verify.sh --quick  - skip the load test and the chart rendering
#
# Requires: foundry (forge/anvil/cast), node, python3, slither.
# Artefacts are written to artifacts/logs/ and artifacts/screenshots/ (git-ignored).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

mkdir -p artifacts/logs artifacts/screenshots

QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
export PATH="$FOUNDRY_BIN:$PATH"

step() { printf '\n=== %s ===\n' "$1"; }

step "contracts: fmt + build + tests + invariants + coverage"
forge fmt --check
forge build --sizes > /dev/null
forge test -vv | tee artifacts/logs/forge-test.txt | tail -3
forge coverage --report summary | tee artifacts/logs/coverage.txt | tail -4

step "static analysis: slither reports + CI gate"
if command -v slither > /dev/null; then
  slither src/PatientConsentRegistry.sol --exclude-dependencies \
    --json artifacts/logs/slither-fixed.json > /dev/null
  slither src/PatientConsentRegistryVuln.sol --exclude-dependencies \
    --json artifacts/logs/slither-vuln.json > /dev/null
  python3 tools/slither_summary.py artifacts/logs/slither-fixed.json \
    artifacts/logs/slither-vuln.json --fail-on high,medium
else
  echo "slither not installed - skipped (CI enforces this gate)"
fi

step "client: typecheck + tests + build + audit"
npm --prefix client run typecheck
npm --prefix client test | tee artifacts/logs/vitest.txt | tail -4
npm --prefix client run build > /dev/null
npm --prefix client audit --audit-level=high

step "local network: start + deploy (writes client/.env.local)"
./tools/localnet.sh start
./tools/localnet.sh deploy | tail -3

CONTRACT="$(cat .contract-address)"
REGISTRAR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
REGISTRAR_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

if [[ "$QUICK" == "0" ]]; then
  step "load test: 30 sequential + 30 tx at concurrency 5"
  node tools/loadtest.js --rpc http://127.0.0.1:8545 \
    --contract "$CONTRACT" --registrar "$REGISTRAR" --private-key "$REGISTRAR_KEY" \
    --tx 30 --concurrency 5 --profile both --out artifacts/logs/loadtest.json | tail -6
  python3 tools/make_charts.py artifacts/logs/loadtest.json artifacts/logs | tail -2
fi

step "monitoring: rules R1 + R2 (headless)"
node tools/monitor_demo.mjs --rpc http://127.0.0.1:8545 --contract "$CONTRACT" \
  --registrar 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  --registrar-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --patient-key "$REGISTRAR_KEY" \
  --attacker-key 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a \
  --out-dir artifacts/logs | tail -4

step "e2e: production build + screenshots (browser errors fail the run)"
pkill -f 'vite preview' 2>/dev/null || true
( cd client && nohup npx vite preview --host 127.0.0.1 --port 4173 --strictPort \
    > "$ROOT/artifacts/logs/vite-preview.log" 2>&1 & echo $! > "$ROOT/.preview.pid" )
for _ in $(seq 1 40); do curl -sf http://127.0.0.1:4173 > /dev/null && break; sleep 1; done
node tools/screenshots.mjs --url http://127.0.0.1:4173 \
  --contract "$CONTRACT" --out artifacts/screenshots --strict
pkill -f 'vite preview' 2>/dev/null || true
rm -f "$ROOT/.preview.pid"

step "OK: every check passed"
