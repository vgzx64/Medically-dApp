// SPDX-License-Identifier: AGPL
pragma solidity ^0.8.37;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PatientConsentRegistryVuln
 * @notice Publicly verifiable ledger of patient consent grants and revocations for
 *         personal data processing. The contract NEVER stores medical documents,
 *         names, diagnoses or any other direct personal data — on-chain only the
 *         cryptographic hash of the consent document (with a unique salt), the
 *         status, timestamps and addresses are recorded.
 *
 * @dev    DELIBERATELY VULNERABLE CONTRACT (used for negative testing and for the
 *         Slither comparison). The ONLY difference from src/PatientConsentRegistry.sol:
 *         in revokeConsent the authorization check uses tx.origin instead of
 *         msg.sender (see the VULNERABILITY comment below).
 *         Local / test network use only.
 */
contract PatientConsentRegistryVuln is AccessControl, Pausable, EIP712 {
    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// @notice Administrator (a multisig wallet in production): manages roles
    ///         and can put the contract on pause.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Registrar of a medical organisation - records a consent on
    ///         behalf of the organisation after verifying the patient signature.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    // ---------------------------------------------------------------------
    // Data types
    // ---------------------------------------------------------------------

    enum ConsentStatus {
        NONE, // 0 - no record
        ACTIVE, // 1 - valid
        REVOKED, // 2 - revoked by the patient
        EXPIRED // 3 - expired (computed dynamically)
    }

    struct Consent {
        address patient; // patient address (or a pseudonymised one)
        address issuer; // address of the registering organisation
        bytes32 consentHash; // keccak256(canonicalDoc || salt)
        uint64 createdAt; // registration timestamp
        uint64 expiresAt; // 0 - no expiry
        uint32 version; // version of the processing terms
        ConsentStatus status; // current status
    }

    /// @dev EIP-712 type used for the patient consent signature.
    bytes32 private constant CONSENT_TYPEHASH = keccak256(
        "Consent(address patient,address issuer,bytes32 consentHash,uint32 version,uint64 expiresAt,uint256 nonce)"
    );

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice consentId => consent record
    mapping(bytes32 => Consent) private _consents;

    /// @notice patient => current nonce for the EIP-712 signature
    mapping(address => uint256) public nonces;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ConsentRecorded(
        bytes32 indexed consentId,
        address indexed patient,
        address indexed issuer,
        bytes32 consentHash,
        uint32 version,
        uint64 expiresAt
    );

    event ConsentRevoked(
        bytes32 indexed consentId,
        address indexed patient,
        address indexed revokedBy,
        uint64 revokedAt
    );

    event RegistrarUpdated(address indexed registrar, bool enabled, address indexed by);

    event ContractPaused(address indexed by);
    event ContractUnpaused(address indexed by);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ConsentAlreadyExists(bytes32 consentId);
    error ConsentNotFound(bytes32 consentId);
    error InvalidSignature();
    error InvalidNonce(uint256 expected, uint256 provided);
    error ConsentExpiredAlready(uint64 expiresAt);
    error InvalidExpiry();
    error EmptyHash();
    error NotConsentOwner(address caller, address owner);
    error ConsentNotActive(ConsentStatus current);
    error ZeroAddress();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier consentExists(bytes32 consentId) {
        if (_consents[consentId].patient == address(0)) {
            revert ConsentNotFound(consentId);
        }
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /**
     * @param admin Administrator address (a multisig wallet in production).
     */
    constructor(address admin) EIP712("PatientConsentRegistry", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Main functions
    // ---------------------------------------------------------------------

    /**
     * @notice Register a patient consent.
     * @dev    Checks-Effects-Interactions pattern: every check happens before
     *         any storage write; there are no external calls.
     *         The patient signs an EIP-712 message; the registrar submits the
     *         transaction on behalf of the medical organisation.
     *
     * @param consentId   Unique identifier of the consent record.
     * @param patient     Patient address.
     * @param consentHash keccak256(canonicalDoc || salt). The salt is kept off-chain.
     * @param version     Version of the processing terms.
     * @param expiresAt   Expiry timestamp (0 - no expiry).
     * @param signature   EIP-712 signature produced by the patient.
     */
    function registerConsent(
        bytes32 consentId,
        address patient,
        bytes32 consentHash,
        uint32 version,
        uint64 expiresAt,
        bytes calldata signature
    ) external onlyRole(REGISTRAR_ROLE) whenNotPaused {
        if (patient == address(0)) revert ZeroAddress();
        if (consentHash == bytes32(0)) revert EmptyHash();
        if (_consents[consentId].patient != address(0)) {
            revert ConsentAlreadyExists(consentId);
        }

        if (expiresAt != 0 && expiresAt <= block.timestamp) {
            revert InvalidExpiry();
        }

        // EIP-712 signature check for the patient
        uint256 currentNonce = nonces[patient];
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CONSENT_TYPEHASH,
                    patient,
                    msg.sender,
                    consentHash,
                    version,
                    expiresAt,
                    currentNonce
                )
            )
        );

        address signer = ECDSA.recover(digest, signature);
        if (signer != patient) revert InvalidSignature();

        // Effects
        nonces[patient] = currentNonce + 1;
        _consents[consentId] = Consent({
            patient: patient,
            issuer: msg.sender,
            consentHash: consentHash,
            createdAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            version: version,
            status: ConsentStatus.ACTIVE
        });

        emit ConsentRecorded(consentId, patient, msg.sender, consentHash, version, expiresAt);
    }

    /**
     * @notice Revoke an active consent. Callable by the patient only.
     * @dev    Revocation is irreversible: REVOKED -> ACTIVE is forbidden.
     *
     *         !!! VULNERABILITY (deliberate): authorization via tx.origin !!!
     *         tx.origin is always the EOA that initiated the transaction,
     *         no matter which contract the call went through.
     *         If a patient calls any third-party contract (a honeypot),
     *         that contract can revoke the consent on the patient's behalf.
     */
    function revokeConsent(bytes32 consentId) external whenNotPaused consentExists(consentId) {
        Consent storage c = _consents[consentId];

        // VULNERABILITY: tx.origin instead of msg.sender (broken access control).
        if (tx.origin != c.patient) {
            revert NotConsentOwner(tx.origin, c.patient);
        }
        if (c.status != ConsentStatus.ACTIVE) revert ConsentNotActive(c.status);

        c.status = ConsentStatus.REVOKED;

        emit ConsentRevoked(consentId, c.patient, tx.origin, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /// @notice Grant / revoke the registrar role. ADMIN_ROLE only.
    function setRegistrar(address registrar, bool enabled) external onlyRole(ADMIN_ROLE) {
        if (registrar == address(0)) revert ZeroAddress();
        if (enabled) {
            _grantRole(REGISTRAR_ROLE, registrar);
        } else {
            _revokeRole(REGISTRAR_ROLE, registrar);
        }
        emit RegistrarUpdated(registrar, enabled, msg.sender);
    }

    /// @notice Emergency stop of consent registration.
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
        emit ContractPaused(msg.sender);
    }

    /// @notice Resume normal operation.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
        emit ContractUnpaused(msg.sender);
    }

    // ---------------------------------------------------------------------
    // View functions
    // ---------------------------------------------------------------------

    /**
     * @notice Return the effective consent status, taking expiry into account.
     * @dev    EXPIRED is computed dynamically, no extra transaction is needed.
     */
    function getConsentStatus(bytes32 consentId)
        external
        view
        consentExists(consentId)
        returns (ConsentStatus)
    {
        Consent storage c = _consents[consentId];
        if (c.status == ConsentStatus.ACTIVE && c.expiresAt != 0 && block.timestamp >= c.expiresAt)
        {
            return ConsentStatus.EXPIRED;
        }
        return c.status;
    }

    /// @notice Return the full consent record.
    function getConsent(bytes32 consentId)
        external
        view
        consentExists(consentId)
        returns (Consent memory)
    {
        return _consents[consentId];
    }

    function checkConsentExists(bytes32 consentId) external view returns (bool) {
        return _consents[consentId].patient != address(0);
    }

    /**
     * @notice Check that the consent is actually valid for a given organisation
     *         and document version.
     */
    function isConsentValid(bytes32 consentId, address issuer, uint32 requiredVersion)
        external
        view
        returns (bool)
    {
        Consent storage c = _consents[consentId];
        if (c.patient == address(0)) return false;
        if (c.status != ConsentStatus.ACTIVE) return false;
        if (c.issuer != issuer) return false;
        if (requiredVersion != 0 && c.version != requiredVersion) return false;
        if (c.expiresAt != 0 && block.timestamp >= c.expiresAt) return false;
        return true;
    }

    /// @notice Helper - compute the EIP-712 digest off-chain.
    function hashConsent(
        address patient,
        address issuer,
        bytes32 consentHash,
        uint32 version,
        uint64 expiresAt,
        uint256 nonce
    ) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CONSENT_TYPEHASH, patient, issuer, consentHash, version, expiresAt, nonce
                )
            )
        );
    }
}
