// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {ConsentTestBase} from "./ConsentTestBase.sol";
import {PatientConsentRegistry} from "../src/PatientConsentRegistry.sol";

/**
 * @title PatientConsentRegistry fuzz / property tests
 * @notice  Property-based checks of the state machine and of the EIP-712
 *         signature scheme.
 */
contract PatientConsentRegistryFuzzTest is ConsentTestBase {
    /// @dev PROPERTY 1: for any valid patient signature, a successful
    ///      registration always leaves the record ACTIVE, with the exact
    ///      nonce that was used, and increments the patient nonce by one.
    function testFuzz_RegisterConsent_SuccessImpliesConsistentState(
        bytes32 docHash,
        uint32 version,
        uint64 expiresAt
    ) public {
        vm.assume(docHash != bytes32(0));
        vm.assume(expiresAt == 0 || expiresAt > block.timestamp + 1 hours);

        uint256 nonceBefore = registry.nonces(patient);
        bytes memory sig =
            _signConsent(patient, patientPk, registrar, docHash, version, expiresAt, nonceBefore);

        vm.prank(registrar);
        registry.registerConsent(CONSENT_ID, patient, docHash, version, expiresAt, sig);

        assertEq(registry.nonces(patient), nonceBefore + 1, "nonce +1");
        assertEq(
            uint256(registry.getConsentStatus(CONSENT_ID)),
            uint256(PatientConsentRegistry.ConsentStatus.ACTIVE),
            "ACTIVE"
        );
        PatientConsentRegistry.Consent memory c = registry.getConsent(CONSENT_ID);
        assertEq(c.consentHash, docHash, "hash");
        assertEq(c.version, version, "version");
        assertEq(c.expiresAt, expiresAt, "expiry");
        assertEq(c.issuer, registrar, "issuer");
        assertEq(c.patient, patient, "patient");
    }

    /// @dev PROPERTY 2: a signature produced with a stale nonce is ALWAYS
    ///      rejected, no matter what the other fields are.
    function testFuzz_RegisterConsent_StaleNonceAlwaysRejected(
        bytes32 docHash,
        uint32 version,
        uint256 staleNonce
    ) public {
        vm.assume(docHash != bytes32(0));
        vm.assume(staleNonce != registry.nonces(patient));

        bytes memory sig =
            _signConsent(patient, patientPk, registrar, docHash, version, 0, staleNonce);

        vm.prank(registrar);
        vm.expectRevert(PatientConsentRegistry.InvalidSignature.selector);
        registry.registerConsent(CONSENT_ID, patient, docHash, version, 0, sig);
    }

    /// @dev PROPERTY 3: after revocation the status never returns to ACTIVE,
    ///      whatever the caller does.
    function testFuzz_RevokedConsent_NeverBecomesActiveAgain(address caller) public {
        _registerDefault();
        vm.prank(patient);
        registry.revokeConsent(CONSENT_ID);

        vm.assume(caller != address(registry));
        vm.prank(caller);
        try registry.revokeConsent(CONSENT_ID) {} catch {}

        assertEq(
            uint256(registry.getConsentStatus(CONSENT_ID)),
            uint256(PatientConsentRegistry.ConsentStatus.REVOKED),
            "still REVOKED"
        );
    }

    /// @dev PROPERTY 4: the consent hash is bound to the issuing organisation
    ///      - a signature produced for another issuer never validates.
    function testFuzz_RegisterConsent_SignatureIsBoundToIssuer(address otherIssuer, bytes32 docHash)
        public
    {
        vm.assume(otherIssuer != registrar && otherIssuer != address(0));
        vm.assume(docHash != bytes32(0));

        bytes memory sig = _signConsent(
            patient, patientPk, otherIssuer, docHash, VERSION, 0, registry.nonces(patient)
        );

        vm.prank(registrar);
        vm.expectRevert(PatientConsentRegistry.InvalidSignature.selector);
        registry.registerConsent(CONSENT_ID, patient, docHash, VERSION, 0, sig);
    }

    /// @dev PROPERTY 5: an expired consent is never reported as valid.
    function testFuzz_ExpiredConsent_IsNeverValid(uint64 expiresAt) public {
        vm.assume(expiresAt > block.timestamp);
        vm.assume(expiresAt < type(uint64).max);

        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, expiresAt);
        vm.prank(registrar);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, expiresAt, sig);

        assertTrue(registry.isConsentValid(CONSENT_ID, registrar, VERSION), "valid before expiry");

        vm.warp(expiresAt);
        assertEq(
            uint256(registry.getConsentStatus(CONSENT_ID)),
            uint256(PatientConsentRegistry.ConsentStatus.EXPIRED),
            "EXPIRED"
        );
        assertFalse(registry.isConsentValid(CONSENT_ID, registrar, VERSION), "not valid");
    }
}
