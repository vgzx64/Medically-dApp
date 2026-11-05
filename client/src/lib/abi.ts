/**
 * Human-readable ABI of PatientConsentRegistry (the reference implementation).
 * Kept in sync with src/PatientConsentRegistry.sol.
 */

export const REGISTRY_ABI = [
  // --- events -------------------------------------------------------------
  'event ConsentRecorded(bytes32 indexed consentId, address indexed patient, address indexed issuer, bytes32 consentHash, uint32 version, uint64 expiresAt)',
  'event ConsentRevoked(bytes32 indexed consentId, address indexed patient, address indexed revokedBy, uint64 revokedAt)',
  'event RegistrarUpdated(address indexed registrar, bool enabled, address indexed by)',
  'event ContractPaused(address indexed by)',
  'event ContractUnpaused(address indexed by)',
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',

  // --- errors -------------------------------------------------------------
  'error ConsentAlreadyExists(bytes32 consentId)',
  'error ConsentNotFound(bytes32 consentId)',
  'error InvalidSignature()',
  'error InvalidNonce(uint256 expected, uint256 provided)',
  'error ConsentExpiredAlready(uint64 expiresAt)',
  'error InvalidExpiry()',
  'error EmptyHash()',
  'error NotConsentOwner(address caller, address owner)',
  'error ConsentNotActive(uint8 current)',
  'error ZeroAddress()',
  'error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)',
  'error AccessControlBadConfirmation()',
  'error EnforcedPause()',
  'error ExpectedPause()',

  // --- state changing -----------------------------------------------------
  'function registerConsent(bytes32 consentId, address patient, bytes32 consentHash, uint32 version, uint64 expiresAt, bytes signature) external',
  'function revokeConsent(bytes32 consentId) external',
  'function setRegistrar(address registrar, bool enabled) external',
  'function pause() external',
  'function unpause() external',

  // --- views --------------------------------------------------------------
  'function getConsentStatus(bytes32 consentId) view returns (uint8)',
  'function getConsent(bytes32 consentId) view returns (address patient, address issuer, bytes32 consentHash, uint64 createdAt, uint64 expiresAt, uint32 version, uint8 status)',
  'function checkConsentExists(bytes32 consentId) view returns (bool)',
  'function isConsentValid(bytes32 consentId, address issuer, uint32 requiredVersion) view returns (bool)',
  'function hashConsent(address patient, address issuer, bytes32 consentHash, uint32 version, uint64 expiresAt, uint256 nonce) view returns (bytes32)',
  'function nonces(address patient) view returns (uint256)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function ADMIN_ROLE() view returns (bytes32)',
  'function REGISTRAR_ROLE() view returns (bytes32)',
  'function paused() view returns (bool)',
] as const;

/** Consent status enumeration as defined in the Solidity contract. */
export enum ConsentStatus {
  None = 0,
  Active = 1,
  Revoked = 2,
  Expired = 3,
}

export const consentStatusLabel = (status: number): string =>
  (['NONE', 'ACTIVE', 'REVOKED', 'EXPIRED'][status] ?? 'UNKNOWN');
