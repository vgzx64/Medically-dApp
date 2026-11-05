/**
 * Business layer on top of the registry contract.
 * Contains the read operations, the write operations and the EIP-712
 * signature helper used by the patient.
 */

import {
  Contract,
  Interface,
  Signature,
  TypedDataEncoder,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
  type Signer,
} from 'ethers';
import { REGISTRY_ABI, ConsentStatus } from './abi';
import { config } from './config';

export const REGISTRY_INTERFACE = new Interface(REGISTRY_ABI);

/**
 * EIP-712 domain of the registry.
 *
 * IMPORTANT: the domain must contain `chainId` and `verifyingContract`,
 * because OpenZeppelin's EIP712 builds the domain separator from all four
 * fields. Omitting them produces a different digest and every signature is
 * rejected with InvalidSignature.
 */
export const eip712Domain = (chainId: number, verifyingContract: string) => ({
  name: 'PatientConsentRegistry',
  version: '1',
  chainId,
  verifyingContract,
});

/** Default domain bound to the configured chain and contract. */
export const getEip712Domain = () => {
  const address = config.contractAddress;
  if (!address) {
    throw new Error(
      'contractAddress is not configured: set VITE_CONTRACT_ADDRESS or save an address in the ConfigPanel',
    );
  }
  return eip712Domain(config.chainId, address);
};

/** @deprecated Frozen at import time; prefer getEip712Domain() for runtime config. */
export const EIP712_DOMAIN = (() => {
  try {
    return getEip712Domain();
  } catch {
    // No contract configured yet; this deprecated constant is only used by
    // legacy call sites. Real code paths call getEip712Domain() and surface
    // a clear error when the address is missing.
    return eip712Domain(config.chainId, '');
  }
})();

export const CONSENT_TYPE = {
  Consent: [
    { name: 'patient', type: 'address' },
    { name: 'issuer', type: 'address' },
    { name: 'consentHash', type: 'bytes32' },
    { name: 'version', type: 'uint32' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export interface ConsentRecord {
  consentId: string;
  patient: string;
  issuer: string;
  consentHash: string;
  createdAt: number;
  expiresAt: number;
  version: number;
  status: ConsentStatus;
}

export interface RegisterConsentInput {
  consentId: string;
  patient: string;
  consentHash: string;
  version: number;
  expiresAt: number;
  signature: string;
}

/** Create the registry contract bound to a signer. */
export const registryContract = (signer: Signer): Contract => {
  const address = config.contractAddress;
  if (!address) {
    throw new Error(
      'contractAddress is not configured: set VITE_CONTRACT_ADDRESS or save an address in the ConfigPanel',
    );
  }
  return new Contract(address, REGISTRY_ABI, signer);
};

/** Read-only view of the registry. */
export const readOnlyContract = (provider: Contract['runner']): Contract => {
  const address = config.contractAddress;
  if (!address) {
    throw new Error(
      'contractAddress is not configured: set VITE_CONTRACT_ADDRESS or save an address in the ConfigPanel',
    );
  }
  return new Contract(address, REGISTRY_ABI, provider);
};

/** Read the current nonce of a patient. */
export const getNonce = async (provider: Contract['runner'], patient: string): Promise<bigint> => {
  const contract = readOnlyContract(provider);
  return (await contract.nonces(patient)) as bigint;
};

/** Read the full consent record; returns undefined when it does not exist. */
export const getConsent = async (
  provider: Contract['runner'],
  consentId: string,
): Promise<ConsentRecord | undefined> => {
  const contract = readOnlyContract(provider);
  if (!(await contract.checkConsentExists(consentId))) return undefined;

  const c = await contract.getConsent(consentId);
  return {
    consentId,
    patient: c.patient as string,
    issuer: c.issuer as string,
    consentHash: c.consentHash as string,
    createdAt: Number(c.createdAt),
    expiresAt: Number(c.expiresAt),
    version: Number(c.version),
    status: Number(c.status) as ConsentStatus,
  };
};

/** Read the effective status of a consent. */
export const getConsentStatus = async (
  provider: Contract['runner'],
  consentId: string,
): Promise<ConsentStatus | undefined> => {
  const contract = readOnlyContract(provider);
  if (!(await contract.checkConsentExists(consentId))) return undefined;
  return Number(await contract.getConsentStatus(consentId)) as ConsentStatus;
};

/** Check the consent for a given organisation and document version. */
export const isConsentValid = async (
  provider: Contract['runner'],
  consentId: string,
  issuer: string,
  requiredVersion: number,
): Promise<boolean> => {
  const contract = readOnlyContract(provider);
  return (await contract.isConsentValid(consentId, issuer, requiredVersion)) as boolean;
};

/**
 * Hash of the consent document. The document itself never leaves the
 * off-chain storage: only keccak256(canonicalDocument || salt) is published.
 */
export const hashDocument = (canonicalDocument: string, salt: string): string =>
  keccak256(
    new Uint8Array([...toUtf8Bytes(canonicalDocument), ...toUtf8Bytes(salt)]),
  );

/** Compute the EIP-712 digest of a consent. */
export const consentDigest = (
  patient: string,
  issuer: string,
  consentHash: string,
  version: number,
  expiresAt: number,
  nonce: bigint,
  domain: { name: string; version: string; chainId: number; verifyingContract: string } =
    EIP712_DOMAIN,
): string =>
  TypedDataEncoder.hash(
    domain as unknown as { name: string; version: string },
    CONSENT_TYPE as unknown as Record<string, { name: string; type: string }[]>,
    {
      patient,
      issuer,
      consentHash,
      version,
      expiresAt,
      nonce: nonce.toString(),
    },
  );

/** Sign the consent with the patient key (EIP-712, no eth_sign prefix). */
export const signConsent = async (
  signer: Signer,
  input: {
    patient: string;
    issuer: string;
    consentHash: string;
    version: number;
    expiresAt: number;
    nonce: bigint;
    domain?: { name: string; version: string; chainId: number; verifyingContract: string };
  },
): Promise<string> => {
  const domain = input.domain ?? getEip712Domain();
  const signature = await signer.signTypedData(
    domain as unknown as { name: string; version: string },
    CONSENT_TYPE as unknown as Record<string, { name: string; type: string }[]>,
    {
      patient: input.patient,
      issuer: input.issuer,
      consentHash: input.consentHash,
      version: input.version,
      expiresAt: input.expiresAt,
      nonce: input.nonce.toString(),
    },
  );
  return Signature.from(signature).serialized;
};

// ---------------------------------------------------------------------------
// Signed consent files
//
// Signing and registering are two separate steps performed by two different
// parties: the patient signs the EIP-712 payload (it binds the patient, the
// issuer that will submit the transaction, the document hash, the terms
// version, the expiry and the patient nonce) and the registrar submits it.
// The signature therefore has to travel from one party to the other; a JSON
// file is used for that and is validated before it is sent on-chain.
// ---------------------------------------------------------------------------

/** Marker of the JSON format understood by the register panel. */
export const CONSENT_SCHEMA = 'pcr-consent-v1';

export interface SignedConsentPayload {
  schema: string;
  /** Chain the signature was produced for (part of the EIP-712 domain). */
  chainId: number;
  /** Registry the signature was produced for (part of the EIP-712 domain). */
  contract: string;
  consentId: string;
  patient: string;
  issuer: string;
  consentHash: string;
  /** Processing terms version, uint32 on-chain. */
  version: number;
  /** Unix seconds, 0 = no expiry (uint64 on-chain). */
  expiresAt: number;
  /** Patient nonce covered by the signature, decimal string (uint256). */
  nonce: string;
  signature: string;
}

const HEX = /^0x[0-9a-fA-F]*$/;
const isAddress = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const isBytes32 = (v: unknown): v is string =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/** Build the payload the patient hands to the registrar. */
export const buildSignedConsent = (
  input: Omit<SignedConsentPayload, 'schema' | 'chainId' | 'contract'>,
  target: { chainId: number; contract: string },
): SignedConsentPayload => ({
  schema: CONSENT_SCHEMA,
  chainId: target.chainId,
  contract: target.contract,
  ...input,
});

/** Pretty JSON, the way it is stored in a file. */
export const serializeSignedConsent = (consent: SignedConsentPayload): string =>
  JSON.stringify(consent, null, 2);

/**
 * Parse a signed consent file.
 *
 * @throws Error with a human readable message when the payload is unusable.
 */
export const parseSignedConsent = (text: string): SignedConsentPayload => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('the file must contain a JSON object');
  }
  const v = raw as Record<string, unknown>;

  if (v.schema !== CONSENT_SCHEMA) {
    throw new Error(`unknown format ${JSON.stringify(v.schema)} (expected ${CONSENT_SCHEMA})`);
  }
  if (!Number.isInteger(v.chainId) || (v.chainId as number) <= 0) {
    throw new Error('chainId must be a positive integer');
  }
  if (!isAddress(v.contract)) throw new Error('contract must be a 20 byte address');
  if (!isBytes32(v.consentId)) throw new Error('consentId must be 32 bytes');
  if (!isAddress(v.patient)) throw new Error('patient must be a 20 byte address');
  if (!isAddress(v.issuer)) throw new Error('issuer must be a 20 byte address');
  if (!isBytes32(v.consentHash)) throw new Error('consentHash must be 32 bytes');
  if (!Number.isInteger(v.version) || (v.version as number) < 1 || (v.version as number) > 0xffffffff) {
    throw new Error('version must be an integer between 1 and 2^32-1');
  }
  if (!Number.isInteger(v.expiresAt) || (v.expiresAt as number) < 0 || (v.expiresAt as number) > 0xffffffffffffffff) {
    throw new Error('expiresAt must be an integer between 0 and 2^64-1');
  }
  if (typeof v.nonce !== 'string' || !/^\d+$/.test(v.nonce)) {
    throw new Error('nonce must be a decimal string');
  }
  if (typeof v.signature !== 'string' || !HEX.test(v.signature) || v.signature.length !== 132) {
    throw new Error('signature must be a 65 byte hex string');
  }

  return {
    schema: CONSENT_SCHEMA,
    chainId: v.chainId as number,
    contract: v.contract as string,
    consentId: v.consentId as string,
    patient: v.patient as string,
    issuer: v.issuer as string,
    consentHash: v.consentHash as string,
    version: v.version as number,
    expiresAt: v.expiresAt as number,
    nonce: v.nonce as string,
    signature: v.signature as string,
  };
};

/** Address that produced the signature, recovered with the signed domain. */
export const recoverConsentSigner = (consent: SignedConsentPayload): string =>
  verifyTypedData(
    eip712Domain(consent.chainId, consent.contract) as unknown as { name: string; version: string },
    CONSENT_TYPE as unknown as Record<string, { name: string; type: string }[]>,
    {
      patient: consent.patient,
      issuer: consent.issuer,
      consentHash: consent.consentHash,
      version: consent.version,
      expiresAt: consent.expiresAt,
      nonce: consent.nonce,
    },
    consent.signature,
  );

export interface SignedConsentCheck {
  consent: SignedConsentPayload;
  /** Chain of the running app. */
  chainId: number;
  /** Registry the running app talks to (empty when not configured yet). */
  contract: string;
  /** Account that would send registerConsent(); the contract hashes it as issuer. */
  submitter: string;
  /** Current on-chain patient nonce, undefined while it is being read. */
  currentNonce: bigint | undefined;
  nowSeconds?: number;
}

/**
 * Reasons why the contract would reject this signed consent.
 * An empty list means the payload can be registered by `submitter`.
 */
export const checkSignedConsent = (input: SignedConsentCheck): string[] => {
  const { consent, chainId, contract, submitter, currentNonce } = input;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const problems: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (consent.chainId !== chainId) {
    problems.push(`signed for chain ${consent.chainId}, but this app is on chain ${chainId}`);
  }
  if (contract && !same(consent.contract, contract)) {
    problems.push(`signed for registry ${consent.contract}, but this app uses ${contract}`);
  }
  if (submitter && !same(consent.issuer, submitter)) {
    problems.push(
      `signed with issuer ${consent.issuer}: the contract hashes msg.sender as the issuer, so only that account can submit it (connected: ${submitter})`,
    );
  }
  try {
    const signer = recoverConsentSigner(consent);
    if (!same(signer, consent.patient)) {
      problems.push(`signature recovers to ${signer}, not to the patient ${consent.patient}`);
    }
  } catch {
    problems.push('signature is malformed');
  }
  if (currentNonce !== undefined) {
    let signedNonce: bigint | undefined;
    try {
      signedNonce = BigInt(consent.nonce);
    } catch {
      signedNonce = undefined;
    }
    if (signedNonce === undefined) {
      problems.push('nonce is not a number');
    } else if (signedNonce !== currentNonce) {
      problems.push(
        `the signature covers nonce ${signedNonce.toString()}, but the patient nonce is now ${currentNonce.toString()}: this consent was already registered or signed twice - ask the patient to sign again`,
      );
    }
  }
  if (consent.expiresAt !== 0 && consent.expiresAt <= now) {
    problems.push(`expiry ${new Date(consent.expiresAt * 1000).toISOString()} is in the past`);
  }
  return problems;
};
