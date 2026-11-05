# Patient Consent Registry — Web3 dApp

A publicly verifiable ledger of patient consent for personal-data processing.

The smart contract stores **only** a salted `keccak256` hash of the consent document plus
the status, timestamps, terms version and addresses. Medical documents, names and
diagnoses never touch the chain. A consent is granted with an EIP-712 signature made by
the patient, recorded by an authorised registrar, and can only be revoked by the patient.

Everything here targets a **local Anvil network with Anvil test accounts and synthetic
data**. Publishing real private keys, seed phrases or passwords is forbidden — see
[`.env.example`](./.env.example).

## Stack

| Layer | Technologies |
|-------|--------------|
| Smart contract | Solidity 0.8.37, OpenZeppelin AccessControl / Pausable / EIP-712, Foundry 1.8.3 (`forge`, `anvil`, `cast`) |
| Static analysis | Slither (crytic), solc-select |
| Client | React 18, TypeScript 5.6, Vite 8, ethers.js v6 |
| Client tests | Vitest 5 |
| E2E screenshots | Playwright 1.55.1 |
| CI | GitHub Actions (`.github/workflows/`) |
| Load test / monitoring | Node.js (`tools/loadtest.js`, `tools/monitor_demo.mjs`) |

## Repository layout

```
src/        PatientConsentRegistry.sol (reference) + PatientConsentRegistryVuln.sol
            (deliberately vulnerable twin, negative tests only)
script/     Deploy.s.sol, GrantRoles.s.sol
test/       integration, fuzz and invariant suites
client/     React application (ethers v6, EIP-712, telemetry, monitoring, UI tests)
tools/      localnet.sh, verify.sh, loadtest.js, monitor_demo.mjs, screenshots.mjs,
            make_charts.py, slither_summary.py
artifacts/  generated test logs, charts and screenshots (git-ignored)
.github/    ci.yml (build/test/slither/audit), integration.yml (e2e: anvil+load+monitor+shots)
```

## Quick start

```bash
# 1. Submodules + client dependencies
git submodule update --init --recursive
npm --prefix client ci

# 2. Local network: start Anvil, deploy the contract, grant the roles.
#    The deploy step also writes client/.env.local with the contract address —
#    Vite only reads env files inside client/, a root .env is invisible to it.
./tools/localnet.sh start
./tools/localnet.sh deploy

# 3. Run the client (dev mode: built-in Anvil account #0 wallet)
npm --prefix client run dev      # http://127.0.0.1:5173
```

The UI is a control panel with sidebar navigation: **Overview** (session, latest events,
counters), **Consents** (Sign / Register / Revoke / Look up tabs), **Events**,
**Monitoring**, **Admin**, **Configuration**. The active section is kept in the URL hash
(`#/consents/register`), so a link survives a reload; network, contract address, alerts
and the current account stay visible in the top bar.

Production build and preview:

```bash
npm --prefix client run build
npm --prefix client run preview # http://127.0.0.1:4173
```

## How a consent is recorded

Registration takes two steps, which can be performed by one account or by two:

1. **Sign** — the patient signs an EIP-712 payload in *Consents → Sign* and receives a
   JSON file containing the payload and signature.
2. **Register** — an account holding `REGISTRAR_ROLE` loads that file in
   *Consents → Register* and submits the transaction.

The contract hashes `msg.sender` as `issuer` and validates `nonces(patient)`, so a
signature is bound to the submitting account and to the current nonce: the same file can
never be replayed. Revocation is done by the patient in *Consents → Revoke* and is
irreversible (`REVOKED` never returns to `ACTIVE`).

## Configuration

Client variables are documented in [`client/.env.example`](./client/.env.example):
`VITE_RPC_URL`, `VITE_CHAIN_ID`, `VITE_WALLET_MODE`, `VITE_CONTRACT_ADDRESS`,
`VITE_REGISTRAR_ADDRESS` (plus `VITE_DEV_PRIVATE_KEY` for the built-in dev wallet only).
The same values can be edited in the *Configuration* panel and are persisted in
`localStorage`.

## Checks

```bash
./tools/verify.sh          # contracts, client, slither, load test, monitoring, screenshots
./tools/verify.sh --quick  # same, without the load test and the charts
```

Individual suites:

```bash
# Contracts: unit + integration + fuzz + invariants
forge test -vv
forge coverage --report summary

# Static analysis (reference and vulnerable contracts) + CI gate
slither src/PatientConsentRegistry.sol     --exclude-dependencies --json artifacts/logs/slither-fixed.json
slither src/PatientConsentRegistryVuln.sol --exclude-dependencies --json artifacts/logs/slither-vuln.json
python3 tools/slither_summary.py artifacts/logs/slither-fixed.json \
  artifacts/logs/slither-vuln.json --fail-on high,medium

# Client: types, tests, build, dependency audit
npm --prefix client run typecheck
npm --prefix client test
npm --prefix client run build
npm --prefix client audit --audit-level=high

# Load test: 30 sequential + 30 transactions at 5 concurrent clients
node tools/loadtest.js --rpc http://127.0.0.1:8545 \
  --contract "$(cat .contract-address)" \
  --registrar 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  --private-key <REGISTRAR_TEST_KEY> \
  --tx 30 --concurrency 5 --profile both --out artifacts/logs/loadtest.json

# Monitoring: rules R1 (access violation) and R2 (operational failure)
node tools/monitor_demo.mjs --rpc http://127.0.0.1:8545 \
  --contract "$(cat .contract-address)" --out-dir artifacts/logs ...

# Charts and screenshots (any browser error fails the run)
python3 tools/make_charts.py artifacts/logs/loadtest.json artifacts/logs
node tools/screenshots.mjs --url http://127.0.0.1:4173 \
  --contract "$(cat .contract-address)" --out artifacts/screenshots --strict
```

## Security model

Threats covered (STRIDE): spoofed sender on privileged calls, signature replay, consent
treated as valid after expiry, silent failure of a registrar transaction, unauthorised
role management, and RPC unavailability or flooding.

| Risk | Mitigation |
|------|------------|
| Spoofed privileged call (`tx.origin` abuse) | `msg.sender` authorization + `onlyRole(REGISTRAR_ROLE)`; the vulnerable twin exists only for negative tests and the Slither comparison |
| Signature replay | EIP-712 payload carrying a per-patient `nonce`, with `issuer` bound to `msg.sender` |
| Expired consent treated as valid | `EXPIRED` is computed dynamically from `expiresAt` |
| State change not reflected after a transaction | the client compares the receipt with the contract state before reporting success |
| RPC outage / overload | retries, the `R2` operational-failure rule, and a load-test budget |

Invariants verified by the fuzzing suite (`test/PatientConsentRegistry.invariant.t.sol`):

- `I1` — a `REVOKED` consent never becomes `ACTIVE` again.
- `I2` — `nonces(patient)` always equals the number of successful registrations.
- `I3` — calls from an address without the required role always revert.

Runtime detection (`client/src/lib/rules.ts`, exercised by `tools/monitor_demo.mjs`):
`R1` fires on repeated unauthorised attempts against a privileged action and blocks that
address for a cool-down window; `R2` fires on transport-level failures (unreachable RPC,
timeouts). Telemetry is written without secrets and is scanned for key material in CI.

CI gates everything: `forge fmt --check`, `forge build`, `forge test`, deeper invariant
runs, `forge coverage`, a Slither High/Medium gate, client typecheck and unit tests, the
production build, and `npm audit --audit-level=high`.

## License

AGPL-3.0 — see [LICENSE](./LICENSE).
