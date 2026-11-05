import { useEffect, useState } from 'react';
import { keccak256, toUtf8Bytes } from 'ethers';
import { config } from '../lib/config';
import {
  buildSignedConsent,
  getNonce,
  hashDocument,
  serializeSignedConsent,
  signConsent,
  type SignedConsentPayload,
} from '../lib/consent';
import type { UseRegistry } from '../hooks/useRegistry';

const randomSalt = (): string =>
  `salt-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** A random 32 byte consent id (the salt guarantees uniqueness). */
const randomConsentId = (salt: string): string =>
  keccak256(toUtf8Bytes(`consent-${salt}-${Math.random()}`));

/**
 * Patient side of the flow: sign a consent and hand the signed file to the
 * registrar. Nothing is sent on-chain here, so no REGISTRAR_ROLE is needed.
 *
 * The signature binds:
 *  - patient      the signer (the contract requires recover(digest) == patient)
 *  - issuer       the account that will send registerConsent() (msg.sender)
 *  - consentHash  keccak256(document || salt), the document stays off-chain
 *  - version      processing terms version
 *  - expiresAt    0 = no expiry
 *  - nonce        the patient nonce, so a signature cannot be replayed
 * plus the EIP-712 domain (chainId + registry address), so the file is only
 * valid for this deployment.
 */
export const SignPanel = ({ app }: { app: UseRegistry }) => {
  const { wallet, connected } = app;

  const [issuer, setIssuer] = useState(config.registrarAddress ?? '');
  const [documentText, setDocumentText] = useState('Patient consent for data processing, v1');
  const [version, setVersion] = useState(1);
  const [expiresInDays, setExpiresInDays] = useState(0);
  const [nonce, setNonce] = useState<bigint | undefined>(undefined);
  const [signed, setSigned] = useState<SignedConsentPayload | undefined>(undefined);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // The signature covers the nonce the contract will read, so show it.
  useEffect(() => {
    if (!wallet) {
      setNonce(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const value = await getNonce(wallet.provider as any, wallet.address);
        if (!cancelled) setNonce(value);
      } catch {
        if (!cancelled) setNonce(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet, app.contractReady, app.events.length]);

  const sign = async () => {
    if (!wallet) return;
    const targetIssuer = issuer.trim();
    if (!targetIssuer) {
      setNote('Issuer is required: it is the account that will submit the consent.');
      return;
    }

    setBusy(true);
    try {
      const salt = randomSalt();
      const consentHash = hashDocument(documentText, salt);
      const consentId = randomConsentId(salt);
      const expiresAt =
        expiresInDays > 0
          ? Math.floor(Date.now() / 1000) + expiresInDays * 24 * 60 * 60
          : 0;

      // Read the nonce right before signing: a stale nonce is rejected.
      const currentNonce = await getNonce(wallet.provider as any, wallet.address);
      const signature = await signConsent(wallet.signer, {
        patient: wallet.address,
        issuer: targetIssuer,
        consentHash,
        version,
        expiresAt,
        nonce: currentNonce,
      });

      const consent = buildSignedConsent(
        {
          consentId,
          patient: wallet.address,
          issuer: targetIssuer,
          consentHash,
          version,
          expiresAt,
          nonce: currentNonce.toString(),
          signature,
        },
        { chainId: config.chainId, contract: config.contractAddress ?? '' },
      );

      setNonce(currentNonce);
      setSigned(consent);
      setNote(
        `Signed for nonce ${currentNonce.toString()}. Salt (keep off-chain, needed to re-derive the hash): ${salt}`,
      );
    } catch (error) {
      setSigned(undefined);
      setNote(`Signing failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const json = signed ? serializeSignedConsent(signed) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setNote('Signed consent copied to the clipboard.');
    } catch {
      setNote('Clipboard is not available: select the JSON and copy it manually.');
    }
  };

  const download = () => {
    if (!signed) return;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `consent-${signed.consentId.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <div className="card-header fw-bold"><i className="bi-pen me-2"></i>Sign a consent (patient)</div>
      <div className="card-body">

        {!connected ? (
          <p className="text-muted small">Connect the patient wallet to sign a consent.</p>
        ) : (
          <>
            <div className="mb-3">
              <label className="form-label">Patient (the signing account)</label>
              <input className="form-control" value={wallet?.address ?? ''} readOnly />
              <div className="form-text">
                The contract requires ECDSA.recover(digest) == patient, so only the
                connected account can sign for itself.
              </div>
            </div>

            <div className="mb-3">
              <label htmlFor="sign-issuer" className="form-label">
                Issuer (the registrar that will submit it)
              </label>
              <input
                id="sign-issuer"
                className="form-control"
                value={issuer}
                placeholder="0x..."
                onChange={(e) => setIssuer(e.target.value)}
              />
              <div className="form-text">
                The contract hashes msg.sender as the issuer, so this must be the account
                that sends registerConsent(), otherwise the signature is rejected with
                InvalidSignature.
              </div>
            </div>

            <div className="mb-3">
              <label htmlFor="sign-doc" className="form-label">
                Consent document (only its hash is published on-chain)
              </label>
              <textarea
                id="sign-doc"
                className="form-control"
                rows={2}
                value={documentText}
                onChange={(e) => setDocumentText(e.target.value)}
              />
            </div>

            <div className="row g-3">
              <div className="col-6">
                <div className="mb-3">
                  <label htmlFor="sign-version" className="form-label">Version</label>
                  <input
                    id="sign-version"
                    className="form-control"
                    type="number"
                    min={1}
                    value={version}
                    onChange={(e) => setVersion(Number(e.target.value))}
                  />
                </div>
              </div>
              <div className="col-6">
                <div className="mb-3">
                  <label htmlFor="sign-expires" className="form-label">Expires in days (0 = no expiry)</label>
                  <input
                    id="sign-expires"
                    className="form-control"
                    type="number"
                    min={0}
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>

            <div className="mb-3">
              <button
                className="btn btn-primary"
                onClick={() => void sign()}
                disabled={busy || !app.contractReady || !issuer.trim()}
              >
                {busy ? 'Signing…' : 'Sign consent'}
              </button>
              <div className="form-text">
                Patient nonce covered by the signature:{' '}
                {nonce === undefined ? 'reading…' : nonce.toString()}
              </div>
            </div>

            {signed && (
              <>
                <div className="mb-3">
                  <label htmlFor="signed-json" className="form-label">
                    Signed consent — send this file to the registrar
                  </label>
                  <textarea
                    id="signed-json"
                    className="form-control font-monospace"
                    rows={10}
                    readOnly
                    value={json}
                  />
                </div>
                <div className="mb-3 d-flex gap-2">
                  <button className="btn btn-outline-primary btn-sm" onClick={() => void copy()}>
                    <i className="bi bi-clipboard me-1"></i>Copy JSON
                  </button>
                  <button className="btn btn-outline-secondary btn-sm" onClick={download}>
                    <i className="bi bi-download me-1"></i>Download file
                  </button>
                </div>
              </>
            )}

            {note && <div className="alert alert-info small mb-0">{note}</div>}
          </>
        )}
      </div>
    </div>
  );
};
