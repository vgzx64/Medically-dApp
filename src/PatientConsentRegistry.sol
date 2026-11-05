// SPDX-License-Identifier: AGPL
pragma solidity ^0.8.37;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title PatientConsentRegistry
 * @notice Publicly verifiable ledger of patient consent grants and revocations for
 *         personal data processing. The contract NEVER stores medical documents,
 *         names, diagnoses or any other direct personal data — on-chain only the
 *         cryptographic hash of the consent document (with a unique salt), the
 *         status, timestamps and addresses are recorded.
 *
 * @dev  Security tooling: AccessControl, Pausable, EIP-712, per-patient nonces.
 *       This is the reference implementation; the deliberately vulnerable twin
 *       (tx.origin based authorization) lives in src/PatientConsentRegistryVuln.sol
 *       and exists for negative tests only.
 */
contract PatientConsentRegistry is AccessControl, Pausable, EIP712 {
    // ---------------------------------------------------------------------
    // Роли
    // ---------------------------------------------------------------------

    /// @notice Администратор (в продакшене — multisig): управляет ролями
    ///         и может ставить контракт на паузу.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    /// @notice Регистратор медицинской организации — фиксирует согласие
    ///         от имени организации после проверки подписи пациента.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    // ---------------------------------------------------------------------
    // Типы данных
    // ---------------------------------------------------------------------

    enum ConsentStatus {
        NONE, // 0 — записи нет
        ACTIVE, // 1 — действует
        REVOKED, // 2 — отозвано пациентом
        EXPIRED // 3 — истёк срок (вычисляется динамически)
    }

    struct Consent {
        address patient; // адрес пациента (или псевдонимизированный)
        address issuer; // адрес организации-регистратора
        bytes32 consentHash; // keccak256(canonicalDoc || salt)
        uint64 createdAt; // время регистрации
        uint64 expiresAt; // 0 — бессрочно
        uint32 version; // версия условий обработки
        ConsentStatus status; // текущий статус
    }

    /// @dev EIP-712 тип для подписи согласия пациентом.
    bytes32 private constant CONSENT_TYPEHASH = keccak256(
        "Consent(address patient,address issuer,bytes32 consentHash,uint32 version,uint64 expiresAt,uint256 nonce)"
    );

    // ---------------------------------------------------------------------
    // Хранилище
    // ---------------------------------------------------------------------

    /// @notice consentId => запись о согласии
    mapping(bytes32 => Consent) private _consents;

    /// @notice пациент => текущий nonce для EIP-712 подписи
    mapping(address => uint256) public nonces;

    // ---------------------------------------------------------------------
    // События
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
    // Ошибки
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
    // Модификаторы
    // ---------------------------------------------------------------------

    modifier consentExists(bytes32 consentId) {
        if (_consents[consentId].patient == address(0)) {
            revert ConsentNotFound(consentId);
        }
        _;
    }

    // ---------------------------------------------------------------------
    // Конструктор
    // ---------------------------------------------------------------------

    /**
     * @param admin Адрес администратора (в продакшене — multisig-кошелёк).
     */
    constructor(address admin) EIP712("PatientConsentRegistry", "1") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Основные функции
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
     * @param expiresAt   Expiry timestamp (0 — no expiry).
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
     *         Authorization uses msg.sender (NOT tx.origin), so an intermediary
     *         contract cannot revoke a consent on the patient's behalf.
     */
    function revokeConsent(bytes32 consentId) external whenNotPaused consentExists(consentId) {
        Consent storage c = _consents[consentId];

        if (msg.sender != c.patient) {
            revert NotConsentOwner(msg.sender, c.patient);
        }
        if (c.status != ConsentStatus.ACTIVE) revert ConsentNotActive(c.status);

        c.status = ConsentStatus.REVOKED;

        emit ConsentRevoked(consentId, c.patient, msg.sender, uint64(block.timestamp));
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

    /// @notice Получить полную запись согласия.
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

    /// @notice Helper — compute the EIP-712 digest off-chain.
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
