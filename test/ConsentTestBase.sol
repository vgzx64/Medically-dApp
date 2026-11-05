// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {PatientConsentRegistry} from "../src/PatientConsentRegistry.sol";
import {PatientConsentRegistryVuln} from "../src/PatientConsentRegistryVuln.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice Shared fixtures and helpers for the test suites.
/// @dev    Kept in a separate file so that integration, fuzz and invariant
///         suites all use exactly the same signing / setup logic.
abstract contract ConsentTestBase is Test {
    PatientConsentRegistry internal registry;

    address internal admin = makeAddr("admin");
    address internal registrar = makeAddr("registrar");
    address internal attacker = makeAddr("attacker");

    address internal patient;
    uint256 internal patientPk;

    bytes32 internal constant CONSENT_ID = keccak256("consent-001");
    bytes32 internal constant DOC_HASH = keccak256("canonical-doc-with-salt");
    uint32 internal constant VERSION = 1;

    function setUp() public virtual {
        (patient, patientPk) = makeAddrAndKey("patient");

        vm.prank(admin);
        registry = new PatientConsentRegistry(admin);

        vm.prank(admin);
        registry.setRegistrar(registrar, true);
    }

    /// @dev Build a valid EIP-712 consent signature for the given issuer.
    function _signConsent(
        address _patient,
        uint256 _pk,
        address _issuer,
        bytes32 _docHash,
        uint32 _version,
        uint64 _expiresAt,
        uint256 _nonce
    ) internal view returns (bytes memory) {
        bytes32 digest = registry.hashConsent(
            _patient, _issuer, _docHash, _version, _expiresAt, _nonce
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Sign using the current on-chain nonce.
    function _signCurrent(address _issuer, bytes32 _docHash, uint32 _version, uint64 _expiresAt)
        internal
        view
        returns (bytes memory)
    {
        return _signConsent(
            patient, patientPk, _issuer, _docHash, _version, _expiresAt, registry.nonces(patient)
        );
    }

    function _registerDefault() internal {
        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, 0);
        vm.prank(registrar);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);
    }
}

/// @notice A malicious intermediary contract used to demonstrate that the
///         FIXED contract refuses `tx.origin`-style delegation.
contract ConsentRevokeProxy {
    PatientConsentRegistry public immutable registry;

    constructor(PatientConsentRegistry _registry) {
        registry = _registry;
    }

    /// @dev Tries to revoke the consent of the caller (tx.origin).
    function revokeViaProxy(bytes32 consentId) external {
        registry.revokeConsent(consentId);
    }
}

/// @notice Same intermediary, pointed at the vulnerable contract.
contract ConsentRevokeProxyVuln {
    PatientConsentRegistryVuln public immutable registry;

    constructor(PatientConsentRegistryVuln _registry) {
        registry = _registry;
    }

    function revokeViaProxy(bytes32 consentId) external {
        registry.revokeConsent(consentId);
    }
}
