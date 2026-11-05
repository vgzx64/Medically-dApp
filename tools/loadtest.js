/**
 * Load test for the PatientConsentRegistry dApp.
 *
 * Compares a SEQUENTIAL and a PARALLEL transaction profile against a local
 * Anvil node. For every profile the script reports throughput, latency
 * percentiles and the share of failed transactions.
 *
 * Nonce handling: both the transaction nonce and the EIP-712 consent nonce
 * are managed locally, so that a parallel profile does not fail with
 * "nonce has already been used" / "replacement fee too low".
 *
 * Usage:
 *   node tools/loadtest.js --rpc http://127.0.0.1:8545 \
 *     --contract 0x... --registrar 0x... --private-key 0x... \
 *     --patient-key 0x... --tx 50 --concurrency 5 --profile both \
 *     --out artifacts/logs/loadtest.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ethers } from '../client/node_modules/ethers/lib.esm/index.js';

const args = process.argv.slice(2);

const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const options = {
  rpc: arg('rpc', 'http://127.0.0.1:8545'),
  contract: arg('contract', ''),
  registrar: arg('registrar', ''),
  privateKey: arg('private-key', ''),
  patientKey: arg('patient-key', ''),
  tx: Number(arg('tx', '30')),
  concurrency: Number(arg('concurrency', '5')),
  profile: arg('profile', 'both'),
  out: arg('out', 'artifacts/logs/loadtest.json'),
};

const ABI = [
  'error ConsentAlreadyExists(bytes32 consentId)',
  'error ConsentNotFound(bytes32 consentId)',
  'error InvalidSignature()',
  'error InvalidExpiry()',
  'error EmptyHash()',
  'error NotConsentOwner(address caller, address owner)',
  'error ConsentNotActive(uint8 current)',
  'error ZeroAddress()',
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
  'error EnforcedPause()',
  'function registerConsent(bytes32 consentId, address patient, bytes32 consentHash, uint32 version, uint64 expiresAt, bytes signature) external',
  'function revokeConsent(bytes32 consentId) external',
  'function nonces(address patient) view returns (uint256)',
  'function hashConsent(address patient, address issuer, bytes32 consentHash, uint32 version, uint64 expiresAt, uint256 nonce) view returns (bytes32)',
  'function getConsentStatus(bytes32 consentId) view returns (uint8)',
  'function REGISTRAR_ROLE() view returns (bytes32)',
  'event ConsentRecorded(bytes32 indexed consentId, address indexed patient, address indexed issuer, bytes32 consentHash, uint32 version, uint64 expiresAt)',
  'event ConsentRevoked(bytes32 indexed consentId, address indexed patient, address indexed revokedBy, uint64 revokedAt)',
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

// The domain must include chainId and verifyingContract (OpenZeppelin EIP712).
const eip712Domain = (chainId, verifyingContract) => ({
  name: 'PatientConsentRegistry',
  version: '1',
  chainId,
  verifyingContract,
});

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
};

/**
 * Local nonce manager.
 *
 * The transaction nonce and the EIP-712 consent nonce are both allocated
 * from local counters, so that concurrent transactions do not collide.
 *
 * NOTE on the consent nonce: the contract verifies the patient signature
 * against the CURRENT on-chain nonce, therefore two transactions for the
 * SAME patient can never be executed in parallel - the second one would
 * see a nonce that is already used. To exercise a parallel profile the
 * load test therefore uses a POOL of patients, each with its own consent
 * nonce, which is also the realistic scenario: one registrar registers
 * consents for many different patients.
 */
class NonceManager {
  constructor(provider, contract, patients, sender) {
    this.provider = provider;
    this.contract = contract;
    this.patients = patients;
    this.sender = sender;
    this.txNonce = null;
    this.consentNonces = new Map();
  }

  async init() {
    this.txNonce = Number(await this.provider.getTransactionCount(this.sender, 'pending'));
    for (const patient of this.patients) {
      this.consentNonces.set(
        patient.address,
        Number(await this.contract.nonces(patient.address)),
      );
    }
  }

  nextTxNonce() {
    const value = this.txNonce;
    this.txNonce += 1;
    return value;
  }

  nextConsentNonce(patient) {
    const value = this.consentNonces.get(patient) ?? 0;
    this.consentNonces.set(patient, value + 1);
    return value;
  }
}

/**
 * Build a pool of deterministic patient wallets.
 *
 * A fixed well-known TEST mnemonic keeps the run reproducible; these keys are
 * public Anvil/Hardhat test accounts and must never hold real funds.
 *
 * Every transaction of a profile gets its OWN patient wallet: the contract
 * serialises the consents of a single patient through a per-patient nonce, so
 * two transactions for the same patient can never be executed in parallel.
 * One wallet per transaction removes that contention entirely and is also the
 * realistic scenario (one registrar registers consents for many patients).
 */
const buildPatientPool = (size) => {
  const mnemonic =
    'test test test test test test test test test test test junk';
  const root = ethers.HDNodeWallet.fromPhrase(mnemonic);
  const pool = [];
  for (let i = 0; i < size; i += 1) {
    const child = root.deriveChild(i);
    pool.push({
      index: i,
      address: child.address,
      signer: new ethers.Wallet(child.privateKey),
    });
  }
  return pool;
};

/** Run `count` transactions, `limit` of them at the same time. */
const runProfile = async ({
  provider,
  wallet,
  patientPool,
  contract,
  count,
  limit,
  chainId,
}) => {
  const results = [];
  const latencies = [];
  let succeeded = 0;
  let failed = 0;

  const nonces = new NonceManager(
    provider,
    contract,
    patientPool.map((p) => ({ address: p.address })),
    wallet.address,
  );
  await nonces.init();

  const oneTransaction = async (index) => {
    const started = Date.now();
    try {
      // Each transaction uses the next patient of the pool.
      const poolEntry = patientPool[index % patientPool.length];
      const patient = poolEntry.address;
      const patientSigner = poolEntry.signer;
      const issuer = options.registrar;
      const docHash = ethers.keccak256(ethers.toUtf8Bytes(`loadtest-${index}-${started}`));
      const version = 1;
      const expiresAt = 0;

      const consentNonce = nonces.nextConsentNonce(patient);
      const signature = await patientSigner.signTypedData(
        eip712Domain(chainId, options.contract),
        EIP712_TYPES,
        {
          patient,
          issuer,
          consentHash: docHash,
          version,
          expiresAt,
          nonce: String(consentNonce),
        },
      );

      const consentId = ethers.keccak256(ethers.toUtf8Bytes(`consent-${index}-${started}`));
      const txNonce = nonces.nextTxNonce();

      const tx = await contract.registerConsent(
        consentId,
        patient,
        docHash,
        version,
        expiresAt,
        signature,
        { nonce: txNonce },
      );
      const receipt = await tx.wait(1);

      const latency = Date.now() - started;
      latencies.push(latency);
      succeeded += 1;
      results.push({
        index,
        status: 'success',
        latencyMs: latency,
        gasUsed: Number(receipt.gasUsed),
        txHash: receipt.hash,
        txNonce,
        consentNonce,
        patient,
      });
    } catch (error) {
      const latency = Date.now() - started;
      latencies.push(latency);
      failed += 1;
      // Try to decode the custom error of the revert.
      let decoded = error.shortMessage ?? error.message ?? String(error);
      try {
        const iface = new ethers.Interface(ABI);
        const data = error?.data ?? error?.info?.error?.data ?? error?.error?.data;
        if (data && data !== '0x') {
          const parsed = iface.parseError(data);
          if (parsed) decoded = `${parsed.name}(${parsed.args.map(String).join(', ')})`;
        }
      } catch {
        // keep the original message
      }
      results.push({
        index,
        status: 'failed',
        latencyMs: latency,
        error: decoded,
      });
    }
  };

  const started = Date.now();
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, count) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      await oneTransaction(index);
    }
  });
  await Promise.all(workers);
  const durationMs = Date.now() - started;

  const sorted = [...latencies].sort((a, b) => a - b);
  const gasValues = results.filter((r) => r.gasUsed !== undefined).map((r) => r.gasUsed);
  const gasSorted = [...gasValues].sort((a, b) => a - b);

  return {
    profile: limit === 1 ? 'sequential' : 'parallel',
    concurrency: limit,
    distinctPatients: patientPool.length,
    requested: count,
    succeeded,
    failed,
    failedShare: Number((failed / Math.max(count, 1)).toFixed(4)),
    durationMs,
    tps: Number((count / (durationMs / 1000)).toFixed(3)),
    latencyMs: {
      min: sorted[0] ?? 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1] ?? 0,
      mean: sorted.length
        ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
        : 0,
    },
    gasUsed: {
      min: gasSorted[0] ?? 0,
      p50: percentile(gasSorted, 50),
      p95: percentile(gasSorted, 95),
      max: gasSorted[gasSorted.length - 1] ?? 0,
      mean: gasSorted.length
        ? Math.round(gasSorted.reduce((a, b) => a + b, 0) / gasSorted.length)
        : 0,
      total: gasValues.reduce((a, b) => a + b, 0),
    },
    results,
  };
};

const main = async () => {
  if (!options.contract || !options.privateKey) {
    console.error('Missing --contract or --private-key');
    process.exit(2);
  }

  const provider = new ethers.JsonRpcProvider(options.rpc);
  // The transaction is sent by the registrar (it holds REGISTRAR_ROLE),
  // the consent is signed by the patient.
  const wallet = new ethers.Wallet(options.privateKey, provider);
  const patientWallet = options.patientKey
    ? new ethers.Wallet(options.patientKey, provider)
    : wallet;
  // A pool of patients: the contract serialises the consents of one
  // patient through the per-patient nonce, so a parallel profile needs
  // several distinct patients.
  // Each profile receives its own pool of patients (one wallet per
  // transaction), so the two profiles start from identical conditions and do
  // not interfere with each other.
  const poolFor = (size) => {
    const pool = buildPatientPool(size);
    if (options.patientKey) {
      // The explicitly provided test patient performs the first transaction.
      pool[0] = { index: 0, address: patientWallet.address, signer: patientWallet };
    }
    return pool;
  };
  const contract = new ethers.Contract(options.contract, ABI, wallet);

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log(`RPC ${options.rpc} chainId ${chainId}`);
  console.log(`Contract ${options.contract}`);
  console.log(`Registrar ${options.registrar}`);
  console.log(`Registrar signer ${wallet.address}`);
  console.log(`Patient pool     ${options.tx} wallet(s) per profile`);

  const report = {
    startedAt: new Date().toISOString(),
    rpc: options.rpc,
    contract: options.contract,
    registrar: options.registrar,
    signer: wallet.address,
    patientPool: poolFor(options.tx).map((p) => p.address),
    chainId,
    profiles: [],
  };

  const runOne = async (limit) => {
    const r = await runProfile({
      provider,
      wallet,
      patientPool: poolFor(options.tx),
      contract,
      count: options.tx,
      limit,
      chainId,
    });
    report.profiles.push(r);
    console.log(
      `tps=${r.tps} p50=${r.latencyMs.p50}ms p95=${r.latencyMs.p95}ms ` +
        `failed=${r.failed} gas(mean)=${r.gasUsed.mean}`,
    );
  };

  if (options.profile === 'both' || options.profile === 'sequential') {
    console.log(`\n== sequential profile (${options.tx} transactions) ==`);
    await runOne(1);
  }

  if (options.profile === 'both' || options.profile === 'parallel') {
    console.log(
      `\n== parallel profile (${options.tx} transactions, concurrency ${options.concurrency}) ==`,
    );
    await runOne(options.concurrency);
  }

  if (report.profiles.length === 2) {
    const [seq, par] = report.profiles;
    report.comparison = {
      throughputGain: seq.tps > 0 ? Number((par.tps / seq.tps).toFixed(3)) : null,
      p50Ratio:
        seq.latencyMs.p50 > 0 ? Number((par.latencyMs.p50 / seq.latencyMs.p50).toFixed(3)) : null,
      p95Ratio:
        seq.latencyMs.p95 > 0 ? Number((par.latencyMs.p95 / seq.latencyMs.p95).toFixed(3)) : null,
    };
    console.log('\n== comparison ==');
    console.log(`throughput gain: x${report.comparison.throughputGain}`);
    console.log(`p95 latency ratio: x${report.comparison.p95Ratio}`);
  }

  report.finishedAt = new Date().toISOString();
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  console.log(`\nReport written to ${options.out}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
