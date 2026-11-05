import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { TypedDataEncoder, recoverAddress, verifyTypedData } from 'ethers';
import {
  CONSENT_SCHEMA,
  CONSENT_TYPE,
  buildSignedConsent,
  checkSignedConsent,
  consentDigest,
  eip712Domain,
  hashDocument,
  parseSignedConsent,
  recoverConsentSigner,
  serializeSignedConsent,
  signConsent,
  type SignedConsentPayload,
} from './consent';

const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const patient = new Wallet(PK);
const REGISTRAR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const CHAIN = 31337;
const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const CONSENT_HASH = `0x${'11'.repeat(32)}`;
const CONSENT_ID = `0x${'22'.repeat(32)}`;

type Fields = Omit<SignedConsentPayload, 'schema' | 'chainId' | 'contract' | 'signature'>;

/** Sign a payload with `signer` (defaults to the patient itself). */
const signConsentAs = async (
  signer: Wallet,
  over: Partial<Fields> = {},
): Promise<SignedConsentPayload> => {
  const fields: Fields = {
    consentId: CONSENT_ID,
    patient: patient.address,
    issuer: REGISTRAR,
    consentHash: CONSENT_HASH,
    version: 1,
    expiresAt: 0,
    nonce: '0',
    ...over,
  };
  const signature = await signer.signTypedData(
    eip712Domain(CHAIN, CONTRACT) as never,
    CONSENT_TYPE as never,
    {
      patient: fields.patient,
      issuer: fields.issuer,
      consentHash: fields.consentHash,
      version: fields.version,
      expiresAt: fields.expiresAt,
      nonce: fields.nonce,
    },
  );
  return buildSignedConsent({ ...fields, signature }, { chainId: CHAIN, contract: CONTRACT });
};

const check = (consent: SignedConsentPayload, over: Partial<Parameters<typeof checkSignedConsent>[0]> = {}) =>
  checkSignedConsent({
    consent,
    chainId: CHAIN,
    contract: CONTRACT,
    submitter: REGISTRAR,
    currentNonce: 0n,
    nowSeconds: 1_800_000_000,
    ...over,
  });

describe('signed consent file', () => {
  it('survives a serialize/parse roundtrip', async () => {
    const consent = await signConsentAs(patient);
    const parsed = parseSignedConsent(serializeSignedConsent(consent));
    expect(parsed).toEqual(consent);
    expect(parsed.schema).toBe(CONSENT_SCHEMA);
  });

  it('is accepted once the patient signed for the submitting registrar', async () => {
    expect(check(await signConsentAs(patient))).toEqual([]);
  });

  it('recovers the patient as the signer', async () => {
    const consent = await signConsentAs(patient);
    expect(recoverConsentSigner(consent)).toBe(patient.address);
  });

  it('rejects files that are not signed consent files', () => {
    expect(() => parseSignedConsent('not json')).toThrow(/valid JSON/);
    expect(() => parseSignedConsent('[]')).toThrow(/JSON object/);
    expect(() => parseSignedConsent('{"schema":"other"}')).toThrow(/unknown format/);
  });

  it('rejects malformed fields', async () => {
    const consent = await signConsentAs(patient);
    const bad = (over: Partial<SignedConsentPayload>) =>
      () => parseSignedConsent(JSON.stringify({ ...consent, ...over }));
    expect(bad({ patient: '0x123' })).toThrow(/patient/);
    expect(bad({ consentHash: `0x${'11'.repeat(31)}` })).toThrow(/consentHash/);
    expect(bad({ version: 0 })).toThrow(/version/);
    expect(bad({ nonce: 0 as unknown as string })).toThrow(/nonce/);
    expect(bad({ signature: '0xdead' })).toThrow(/signature/);
  });

  it('reports a signature produced for another chain', async () => {
    const consent = await signConsentAs(patient);
    expect(check(consent, { chainId: 11155111 })).toEqual([
      'signed for chain 31337, but this app is on chain 11155111',
    ]);
  });

  it('reports a signature produced for another registry', async () => {
    const consent = await signConsentAs(patient);
    const problems = check(consent, { contract: OTHER });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/signed for registry/);
  });

  it('reports a signature whose issuer is not the submitting account', async () => {
    const consent = await signConsentAs(patient);
    const problems = check(consent, { submitter: OTHER });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/only that account can submit it/);
  });

  it('reports a signature that does not recover to the patient', async () => {
    const impostor = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const consent = await signConsentAs(impostor);
    const problems = check(consent);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/recovers to/);
  });

  it('reports a nonce that was already used', async () => {
    const consent = await signConsentAs(patient, { nonce: '3' });
    const problems = check(consent, { currentNonce: 4n });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/already registered or signed twice/);
  });

  it('reports an expiry in the past', async () => {
    const consent = await signConsentAs(patient, { expiresAt: 1_799_999_000 });
    const problems = check(consent);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/is in the past/);
  });
});

describe('EIP-712 consent type', () => {
  it('declares the same type string as the contract', () => {
    expect(TypedDataEncoder.from(CONSENT_TYPE as never).encodeType('Consent')).toBe(
      'Consent(address patient,address issuer,bytes32 consentHash,uint32 version,uint64 expiresAt,uint256 nonce)',
    );
  });

  it('builds the OpenZeppelin domain with all four fields', () => {
    expect(eip712Domain(CHAIN, CONTRACT)).toEqual({
      name: 'PatientConsentRegistry',
      version: '1',
      chainId: CHAIN,
      verifyingContract: CONTRACT,
    });
  });
});

describe('hashDocument', () => {
  it('is deterministic for the same document and salt', () => {
    expect(hashDocument('doc', 'salt')).toBe(hashDocument('doc', 'salt'));
  });

  it('changes with the salt, so the hash cannot be brute forced', () => {
    expect(hashDocument('doc', 'salt')).not.toBe(hashDocument('doc', 'pepper'));
  });

  it('changes with the document', () => {
    expect(hashDocument('doc', 'salt')).not.toBe(hashDocument('doc2', 'salt'));
  });

  it('returns a 32 byte hash', () => {
    expect(hashDocument('doc', 'salt')).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('consentDigest', () => {
  const base = {
    patient: patient.address,
    issuer: REGISTRAR,
    consentHash: CONSENT_HASH,
    version: 1,
    expiresAt: 0,
    nonce: 0n,
    domain: eip712Domain(CHAIN, CONTRACT),
  };
  const digest = (over: Partial<typeof base> = {}) => {
    const v = { ...base, ...over };
    return consentDigest(v.patient, v.issuer, v.consentHash, v.version, v.expiresAt, v.nonce, v.domain);
  };

  it('binds the patient and the issuer', () => {
    expect(digest()).not.toBe(digest({ patient: OTHER }));
    expect(digest()).not.toBe(digest({ issuer: OTHER }));
  });

  it('binds the document hash, version, expiry and nonce', () => {
    expect(digest()).not.toBe(digest({ consentHash: `0x${'33'.repeat(32)}` }));
    expect(digest()).not.toBe(digest({ version: 2 }));
    expect(digest()).not.toBe(digest({ expiresAt: 1_900_000_000 }));
    expect(digest()).not.toBe(digest({ nonce: 1n }));
  });

  it('binds the domain, so a signature cannot move between chains or registries', () => {
    expect(digest()).not.toBe(digest({ domain: eip712Domain(1, CONTRACT) }));
    expect(digest()).not.toBe(digest({ domain: eip712Domain(CHAIN, OTHER) }));
  });
});

describe('signConsent', () => {
  const input = {
    patient: patient.address,
    issuer: REGISTRAR,
    consentHash: CONSENT_HASH,
    version: 1,
    expiresAt: 0,
    nonce: 0n,
    domain: eip712Domain(CHAIN, CONTRACT),
  };

  it('produces a 65 byte EIP-712 signature by the patient', async () => {
    const signature = await signConsent(patient, input);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(
      verifyTypedData(
        input.domain as never,
        CONSENT_TYPE as never,
        {
          patient: input.patient,
          issuer: input.issuer,
          consentHash: input.consentHash,
          version: input.version,
          expiresAt: input.expiresAt,
          nonce: input.nonce.toString(),
        },
        signature,
      ),
    ).toBe(patient.address);
  });

  it('signs the digest computed by consentDigest', async () => {
    const signature = await signConsent(patient, input);
    const digest = consentDigest(
      input.patient,
      input.issuer,
      input.consentHash,
      input.version,
      input.expiresAt,
      input.nonce,
      input.domain,
    );
    expect(recoverAddress(digest, signature)).toBe(patient.address);
  });
});
