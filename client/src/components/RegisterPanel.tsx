import { useEffect, useState } from 'react';
import { config } from '../lib/config';
import {
  checkSignedConsent,
  getNonce,
  parseSignedConsent,
  readOnlyContract,
  registryContract,
  type SignedConsentPayload,
} from '../lib/consent';
import type { UseRegistry } from '../hooks/useRegistry';

const short = (value: string): string =>
  value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;

/**
 * Registrar side of the flow: submit a consent that the patient signed.
 *
 * This panel never signs anything. It takes the signed consent file produced
 * by the patient, checks it against this chain, this registry, the connected
 * account and the patient nonce - the same conditions the contract checks -
 * and only then sends registerConsent().
 */
export const RegisterPanel = ({ app }: { app: UseRegistry }) => {
  const { wallet, connected, send } = app;

  const [raw, setRaw] = useState('');
  const [parsed, setParsed] = useState<SignedConsentPayload | undefined>(undefined);
  const [parseError, setParseError] = useState('');
  const [nonce, setNonce] = useState<bigint | undefined>(undefined);
  const [problems, setProblems] = useState<string[]>([]);
  const [consentId, setConsentId] = useState('');
  const [isRegistrar, setIsRegistrar] = useState<boolean | undefined>(undefined);
  const [note, setNote] = useState('');

  const busy = app.tx.stage !== 'idle' && app.tx.stage !== 'confirmed' && app.tx.stage !== 'failed';

  // Only the registrar may submit: the contract enforces REGISTRAR_ROLE.
  useEffect(() => {
    if (!wallet) {
      setIsRegistrar(undefined);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const contract = readOnlyContract(wallet.provider as any);
        const role = (await contract.REGISTRAR_ROLE()) as string;
        const has = (await contract.hasRole(role, wallet.address)) as boolean;
        if (!cancelled) setIsRegistrar(has);
      } catch {
        if (!cancelled) setIsRegistrar(undefined);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  // Parse the pasted/loaded file.
  useEffect(() => {
    if (!raw.trim()) {
      setParsed(undefined);
      setParseError('');
      return;
    }
    try {
      const consent = parseSignedConsent(raw);
      setParsed(consent);
      setParseError('');
      setConsentId(consent.consentId);
    } catch (error) {
      setParsed(undefined);
      setParseError(error instanceof Error ? error.message : String(error));
    }
  }, [raw]);

  // The signature covers the patient nonce: read it from the chain.
  useEffect(() => {
    if (!parsed || !wallet) {
      setNonce(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const value = await getNonce(wallet.provider as any, parsed.patient);
        if (!cancelled) setNonce(value);
      } catch {
        if (!cancelled) setNonce(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parsed, wallet, app.events.length]);

  useEffect(() => {
    if (!parsed) {
      setProblems([]);
      return;
    }
    setProblems(
      checkSignedConsent({
        consent: parsed,
        chainId: config.chainId,
        contract: config.contractAddress ?? '',
        submitter: wallet?.address ?? '',
        currentNonce: nonce,
      }),
    );
  }, [parsed, wallet, nonce]);

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setRaw(await file.text());
  };

  const submit = async () => {
    if (!wallet || !parsed) return;
    const id = consentId.trim() || parsed.consentId;
    const contract = registryContract(wallet.signer);
    const hash = await send(
      () =>
        contract.registerConsent(
          id,
          parsed.patient,
          parsed.consentHash,
          parsed.version,
          parsed.expiresAt,
          parsed.signature,
        ),
      'registerConsent',
    );

    if (hash) {
      // The signature is spent: its nonce is now used on-chain.
      setRaw('');
      setNote(
        `Registered consent ${id} in tx ${hash}. The signed file is used up - ask the patient for a new signature to register another consent.`,
      );
    }
  };

  const blocked =
    !parsed || problems.length > 0 || isRegistrar === false || !app.contractReady;

  return (
    <div className="card">
      <div className="card-header fw-bold"><i className="bi-file-earmark-check me-2"></i>Register a signed consent (registrar)</div>
      <div className="card-body">

        {!connected ? (
          <p className="text-muted small">Connect the registrar wallet to submit a consent.</p>
        ) : (
          <>
            <div className="mb-3">
              <label htmlFor="consent-file" className="form-label">Signed consent file (from the patient)</label>
              <input
                id="consent-file"
                className="form-control"
                type="file"
                accept="application/json,.json"
                onChange={(e) => void loadFile(e.target.files?.[0])}
              />
            </div>

            <div className="mb-3">
              <label htmlFor="consent-json" className="form-label">…or paste the JSON</label>
              <textarea
                id="consent-json"
                className="form-control font-monospace"
                rows={6}
                value={raw}
                placeholder='{"schema":"pcr-consent-v1", …}'
                onChange={(e) => setRaw(e.target.value)}
              />
            </div>

            {parseError && (
              <div className="alert alert-danger small">Not a valid signed consent: {parseError}</div>
            )}

            {parsed && (
              <div className="mb-3">
                <table className="table table-sm small mb-0">
                  <tbody>
                    <tr><th scope="row">Patient</th><td className="font-monospace">{short(parsed.patient)}</td></tr>
                    <tr><th scope="row">Issuer</th><td className="font-monospace">{short(parsed.issuer)}</td></tr>
                    <tr><th scope="row">Document hash</th><td className="font-monospace">{short(parsed.consentHash)}</td></tr>
                    <tr><th scope="row">Version</th><td>{parsed.version}</td></tr>
                    <tr>
                      <th scope="row">Expires</th>
                      <td>{parsed.expiresAt === 0 ? 'never' : new Date(parsed.expiresAt * 1000).toISOString()}</td>
                    </tr>
                    <tr>
                      <th scope="row">Nonce in signature</th>
                      <td className="font-monospace">
                        {parsed.nonce} (on-chain: {nonce === undefined ? '…' : nonce.toString()})
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {problems.length > 0 && (
              <div className="alert alert-danger small">
                <div className="fw-bold mb-1">The contract would reject this signature:</div>
                <ul className="mb-0 ps-3">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mb-3">
              <label htmlFor="consent-id" className="form-label">Consent id</label>
              <input
                id="consent-id"
                className="form-control font-monospace"
                value={consentId}
                placeholder="0x..."
                onChange={(e) => setConsentId(e.target.value)}
              />
              <div className="form-text">
                Taken from the signed file; the id is not part of the signature, so the
                registrar may use its own.
              </div>
            </div>

            <div className="mb-3">
              <button
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={busy || blocked || !consentId.trim()}
              >
                {busy ? 'Processing…' : 'Register signed consent'}
              </button>
            </div>

            {note && <div className="alert alert-success small">{note}</div>}

            {isRegistrar === false && (
              <div className="alert alert-danger small">
                The connected account does not hold REGISTRAR_ROLE, so the transaction would
                be rejected by the contract. Connect the registrar account or ask the
                administrator for the role.
              </div>
            )}

            {isRegistrar === true && (
              <div className="alert alert-success small">
                The connected account holds REGISTRAR_ROLE.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
