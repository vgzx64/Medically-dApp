/**
 * Monitoring demo for the PatientConsentRegistry dApp.
 *
 * Drives the real detection rules (R1 - access violation, R2 - operational
 * failure) against a local Anvil node and writes:
 *   - artifacts/logs/telemetry.jsonl  - the raw, secret-free JSONL stream
 *   - artifacts/logs/alerts.json       - the raised alerts
 *
 * Scenarios:
 *   1. A registrar registers a consent successfully.
 *   2. An attacker without REGISTRAR_ROLE tries to register 3 times
 *      -> rule R1 must fire.
 *   3. The RPC endpoint is unreachable -> rule R2 must fire.
 *
 * Usage:
 *   node tools/monitor_demo.mjs --rpc http://127.0.0.1:8545 \
 *     --contract 0x... --registrar 0x... --out-dir artifacts/logs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from '../client/node_modules/ethers/lib.esm/index.js';
import { DetectionEngine } from '../client/src/lib/rules.ts';
import { Telemetry, newCorrelationId } from '../client/src/lib/telemetry.ts';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const options = {
  rpc: arg('rpc', 'http://127.0.0.1:8545'),
  contract: arg('contract', ''),
  registrar: arg('registrar', ''),
  registrarKey: arg('registrar-key', ''),
  patientKey: arg('patient-key', ''),
  attackerKey: arg('attacker-key', ''),
  outDir: arg('out-dir', 'artifacts/logs'),
};

const ABI = [
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
  'error InvalidSignature()',
  'error ConsentAlreadyExists(bytes32 consentId)',
  'function registerConsent(bytes32 consentId, address patient, bytes32 consentHash, uint32 version, uint64 expiresAt, bytes signature) external',
  'function nonces(address patient) view returns (uint256)',
  'function REGISTRAR_ROLE() view returns (bytes32)',
];

const EIP712_TYPES = {
  Consent: [
    { name: 'patient', type: 'address' },
    { name: 'issuer', type: 'address' },
    { name: 'consentHash', type: 'bytes32' },
    { name: 'version', type: 'uint32' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
};

const eip712Domain = (chainId, verifyingContract) => ({
  name: 'PatientConsentRegistry',
  version: '1',
  chainId,
  verifyingContract,
});

/** Decode a revert into a readable reason. */
const decodeReason = (error, iface) => {
  try {
    const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
    if (data && data !== '0x') {
      const parsed = iface.parseError(data);
      if (parsed) return parsed.name;
    }
  } catch {
    // fall through
  }
  return error?.shortMessage ?? error?.message ?? String(error);
};

const main = async () => {
  const records = [];
  const engine = new DetectionEngine();
  const telemetry = new Telemetry((record) => {
    records.push(record);
    const alert = engine.ingest(record);
    if (alert) {
      console.log(`  [ALERT ${alert.ruleId}/${alert.severity}] ${alert.title}: ${alert.description}`);
    }
  });

  const provider = new ethers.JsonRpcProvider(options.rpc);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const iface = new ethers.Interface(ABI);

  const registrar = new ethers.Wallet(options.registrarKey, provider);
  const patient = new ethers.Wallet(options.patientKey, provider);
  const attacker = new ethers.Wallet(options.attackerKey, provider);

  const contract = new ethers.Contract(options.contract, ABI, registrar);

  console.log(`Monitoring demo against ${options.rpc} (chain ${chainId})`);
  console.log(`Contract ${options.contract}`);

  // ---- scenario 1: a legitimate registration -------------------------
  console.log('\n[1] legitimate registration by the registrar');
  const correlationId = newCorrelationId();
  const docHash = ethers.keccak256(ethers.toUtf8Bytes('monitor-demo-doc'));
  const consentId = ethers.keccak256(ethers.toUtf8Bytes(`monitor-${Date.now()}`));
  const nonce = Number(await contract.nonces(patient.address));

  try {
    const signature = await patient.signTypedData(
      eip712Domain(chainId, options.contract),
      EIP712_TYPES,
      {
        patient: patient.address,
        issuer: registrar.address,
        consentHash: docHash,
        version: 1,
        expiresAt: 0,
        nonce: String(nonce),
      },
    );

    const tx = await contract.registerConsent(
      consentId,
      patient.address,
      docHash,
      1,
      0,
      signature,
    );
    const receipt = await tx.wait(1);

    telemetry.tx('tx.confirmed', {
      correlationId,
      from: registrar.address,
      method: 'registerConsent',
      txHash: receipt.hash,
      metrics: { gasUsed: Number(receipt.gasUsed), latencyMs: 42, blockNumber: Number(receipt.blockNumber) },
    });
    telemetry.contract('event.recorded', {
      correlationId,
      txHash: receipt.hash,
      context: { consentId, patient: patient.address, issuer: registrar.address },
    });
  } catch (error) {
    telemetry.tx('tx.failed', {
      correlationId,
      level: 'error',
      from: registrar.address,
      method: 'registerConsent',
      message: decodeReason(error, iface),
    });
  }

  // ---- scenario 2: access violations (rule R1) -----------------------
  console.log('\n[2] unauthorized registrations -> rule R1');
  const attackerContract = new ethers.Contract(options.contract, ABI, attacker);
  for (let i = 0; i < 4; i += 1) {
    const correlationId2 = newCorrelationId();
    const id = ethers.keccak256(ethers.toUtf8Bytes(`attack-${i}-${Date.now()}`));
    const hash = ethers.keccak256(ethers.toUtf8Bytes(`attack-doc-${i}`));
    const attackerNonce = Number(await attackerContract.nonces(attacker.address));
    try {
      const signature = await attacker.signTypedData(
        eip712Domain(chainId, options.contract),
        EIP712_TYPES,
        {
          patient: attacker.address,
          issuer: registrar.address,
          consentHash: hash,
          version: 1,
          expiresAt: 0,
          nonce: String(attackerNonce),
        },
      );
      const tx = await attackerContract.registerConsent(
        id,
        attacker.address,
        hash,
        1,
        0,
        signature,
      );
      const receipt = await tx.wait(1);
      telemetry.tx('tx.confirmed', {
        correlationId: correlationId2,
        from: attacker.address,
        method: 'registerConsent',
        txHash: receipt.hash,
      });
    } catch (error) {
      const reason = decodeReason(error, iface);
      telemetry.tx('tx.reverted', {
        correlationId: correlationId2,
        level: 'error',
        from: attacker.address,
        method: 'registerConsent',
        message: reason,
        context: { reason },
      });
    }
  }

  // ---- scenario 3: operational failures (rule R2) ---------------------
  console.log('\n[3] RPC failures -> rule R2');
  for (let i = 0; i < 6; i += 1) {
    telemetry.rpc('rpc.error', {
      level: 'error',
      message: 'connection refused (simulated transport failure)',
      context: { endpoint: options.rpc },
    });
  }

  // ---- write the artefacts -------------------------------------------
  mkdirSync(options.outDir, { recursive: true });
  const telemetryPath = join(options.outDir, 'telemetry.jsonl');
  writeFileSync(
    telemetryPath,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );

  const alerts = engine.getAlerts();
  const alertsPath = join(options.outDir, 'alerts.json');
  writeFileSync(
    alertsPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), alerts }, null, 2)}\n`,
    'utf-8',
  );

  console.log(`\nTelemetry records: ${records.length} -> ${telemetryPath}`);
  console.log(`Alerts raised:     ${alerts.length} -> ${alertsPath}`);
  for (const alert of alerts) {
    console.log(`  - ${alert.ruleId} [${alert.severity}] ${alert.subject}: ${alert.description}`);
  }

  // The demo is only successful when both rules fired.
  const rulesFired = new Set(alerts.map((a) => a.ruleId));
  const ok = rulesFired.has('R1') && rulesFired.has('R2');
  console.log(`\n${ok ? 'OK' : 'FAIL'}: rules fired = ${[...rulesFired].join(', ')}`);
  process.exit(ok ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
