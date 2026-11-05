// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {ConsentTestBase, ConsentRevokeProxy, ConsentRevokeProxyVuln} from "./ConsentTestBase.sol";
import {PatientConsentRegistry} from "../src/PatientConsentRegistry.sol";
import {PatientConsentRegistryVuln} from "../src/PatientConsentRegistryVuln.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title PatientConsentRegistry integration tests
 * @notice  End-to-end scenarios over the FIXED contract: happy path, negative
 *         scenarios (unauthorized role, invalid signature, replay, proxy
 *         delegation), state-change verification and event assertions.
 */
contract PatientConsentRegistryIntegrationTest is ConsentTestBase {
    // ------------------------------------------------------------------
    // 1. Happy path: register a consent
    // ------------------------------------------------------------------
    function test_RegisterConsent_HappyPath() public {
        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, 0);

        vm.prank(registrar);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);

        assertEq(
            uint256(registry.getConsentStatus(CONSENT_ID)),
            uint256(PatientConsentRegistry.ConsentStatus.ACTIVE),
            "status must be ACTIVE"
        );

        PatientConsentRegistry.Consent memory c = registry.getConsent(CONSENT_ID);
        assertEq(c.patient, patient, "patient");
        assertEq(c.issuer, registrar, "issuer");
        assertEq(c.consentHash, DOC_HASH, "hash");
        assertEq(c.version, VERSION, "version");
        assertTrue(registry.isConsentValid(CONSENT_ID, registrar, VERSION), "isConsentValid");
        assertEq(registry.nonces(patient), 1, "nonce incremented");
    }

    // ------------------------------------------------------------------
    // 2. Negative: caller without REGISTRAR_ROLE
    // ------------------------------------------------------------------
    function test_RegisterConsent_RevertsForUnauthorizedRole() public {
        bytes memory sig = _signCurrent(attacker, DOC_HASH, VERSION, 0);
        bytes32 registrarRole = registry.REGISTRAR_ROLE();

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, registrarRole
            )
        );
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);

        // State must be untouched
        assertFalse(registry.checkConsentExists(CONSENT_ID), "no record created");
        assertEq(registry.nonces(patient), 0, "nonce untouched");
    }

    // ------------------------------------------------------------------
    // 3. Negative: administration without ADMIN_ROLE
    // ------------------------------------------------------------------
    function test_SetRegistrar_RevertsForUnauthorizedRole() public {
        bytes32 adminRole = registry.ADMIN_ROLE();

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, adminRole
            )
        );
        registry.setRegistrar(attacker, true);

        assertFalse(registry.hasRole(registry.REGISTRAR_ROLE(), attacker), "role not granted");
    }

    // ------------------------------------------------------------------
    // 4. Negative: signature produced by the wrong key
    // ------------------------------------------------------------------
    function test_RegisterConsent_RevertsForInvalidSignature() public {
        (, uint256 wrongPk) = makeAddrAndKey("wrong");
        bytes memory sig = _signConsent(patient, wrongPk, registrar, DOC_HASH, VERSION, 0, 0);

        vm.prank(registrar);
        vm.expectRevert(PatientConsentRegistry.InvalidSignature.selector);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);
    }

    // ------------------------------------------------------------------
    // 5. Negative: replay of an already used signature (nonce reuse)
    // ------------------------------------------------------------------
    function test_RegisterConsent_RevertsOnSignatureReplay() public {
        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, 0);

        vm.prank(registrar);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);

        bytes32 anotherId = keccak256("consent-002");
        vm.prank(registrar);
        vm.expectRevert(PatientConsentRegistry.InvalidSignature.selector);
        registry.registerConsent(anotherId, patient, DOC_HASH, VERSION, 0, sig);

        assertFalse(registry.checkConsentExists(anotherId), "second record absent");
        assertEq(registry.nonces(patient), 1, "nonce still 1");
    }

    // ------------------------------------------------------------------
    // 6. State change: revoke by the patient
    // ------------------------------------------------------------------
    function test_RevokeConsent_ByPatient_ChangesState() public {
        _registerDefault();

        vm.prank(patient);
        registry.revokeConsent(CONSENT_ID);

        assertEq(
            uint256(registry.getConsentStatus(CONSENT_ID)),
            uint256(PatientConsentRegistry.ConsentStatus.REVOKED),
            "status must be REVOKED"
        );
        assertFalse(registry.isConsentValid(CONSENT_ID, registrar, VERSION), "no longer valid");
    }

    // ------------------------------------------------------------------
    // 7. Negative: revoke by a third party
    // ------------------------------------------------------------------
    function test_RevokeConsent_RevertsForNonOwner() public {
        _registerDefault();

        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(
                PatientConsentRegistry.NotConsentOwner.selector, attacker, patient
            )
        );
        registry.revokeConsent(CONSENT_ID);

        assertEq(
            uint256(registry.getConsentStatus(CONSENT_ID)),
            uint256(PatientConsentRegistry.ConsentStatus.ACTIVE),
            "status unchanged"
        );
    }

    // ------------------------------------------------------------------
    // 8. Negative: revoke through an intermediary contract.
    //    The fixed contract uses msg.sender => the proxy is rejected.
    // ------------------------------------------------------------------
    function test_RevokeConsent_RevertsThroughProxyContract() public {
        _registerDefault();

        ConsentRevokeProxy proxy = new ConsentRevokeProxy(registry);

        vm.prank(patient);
        vm.expectRevert(
            abi.encodeWithSelector(
                PatientConsentRegistry.NotConsentOwner.selector, address(proxy), patient
            )
        );
        proxy.revokeViaProxy(CONSENT_ID);

        assertEq(
            uint256(registry.getConsentStatus(CONSENT_ID)),
            uint256(PatientConsentRegistry.ConsentStatus.ACTIVE),
            "status unchanged"
        );
    }

    // ------------------------------------------------------------------
    // 9. Negative (control): the vulnerable variant IS exploitable
    //    through a proxy - the tx.origin flaw fixed in PR #3.
    // ------------------------------------------------------------------
    function test_VulnerableContract_ProxyRevokeSucceeds() public {
        vm.prank(admin);
        PatientConsentRegistryVuln vuln = new PatientConsentRegistryVuln(admin);
        vm.prank(admin);
        vuln.setRegistrar(registrar, true);

        bytes32 digest = vuln.hashConsent(patient, registrar, DOC_HASH, VERSION, 0, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(patientPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(registrar);
        vuln.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);

        ConsentRevokeProxyVuln proxy = new ConsentRevokeProxyVuln(vuln);

        // The patient calls the malicious proxy => tx.origin == patient.
        // The two-argument prank sets msg.sender AND tx.origin.
        vm.prank(patient, patient);
        proxy.revokeViaProxy(CONSENT_ID);

        assertEq(
            uint256(vuln.getConsentStatus(CONSENT_ID)),
            uint256(PatientConsentRegistryVuln.ConsentStatus.REVOKED),
            "vulnerable contract was exploited"
        );
    }

    // ------------------------------------------------------------------
    // 10. Events: ConsentRecorded / ConsentRevoked
    // ------------------------------------------------------------------
    function test_Events_AreEmitted() public {
        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, 0);

        vm.expectEmit(true, true, true, true, address(registry));
        emit PatientConsentRegistry.ConsentRecorded(
            CONSENT_ID, patient, registrar, DOC_HASH, VERSION, 0
        );
        vm.prank(registrar);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);

        vm.expectEmit(true, true, true, true, address(registry));
        emit PatientConsentRegistry.ConsentRevoked(
            CONSENT_ID, patient, patient, uint64(block.timestamp)
        );
        vm.prank(patient);
        registry.revokeConsent(CONSENT_ID);
    }

    // ------------------------------------------------------------------
    // 11. Negative: expiry in the past
    // ------------------------------------------------------------------
    function test_RegisterConsent_RevertsForPastExpiry() public {
        vm.warp(1_700_000_000);
        uint64 past = uint64(block.timestamp - 1);
        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, past);

        vm.prank(registrar);
        vm.expectRevert(PatientConsentRegistry.InvalidExpiry.selector);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, past, sig);
    }

    // ------------------------------------------------------------------
    // 12. State change: revoking the registrar role blocks registration
    // ------------------------------------------------------------------
    function test_RemoveRegistrar_BlocksRegistration() public {
        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, 0);
        bytes32 registrarRole = registry.REGISTRAR_ROLE();

        vm.prank(admin);
        registry.setRegistrar(registrar, false);

        vm.prank(registrar);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, registrar, registrarRole
            )
        );
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);
    }

    // ------------------------------------------------------------------
    // 13. Negative: duplicate consent id
    // ------------------------------------------------------------------
    function test_RegisterConsent_RevertsForDuplicateId() public {
        _registerDefault();

        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, 0);
        vm.prank(registrar);
        vm.expectRevert(
            abi.encodeWithSelector(PatientConsentRegistry.ConsentAlreadyExists.selector, CONSENT_ID)
        );
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);
    }

    // ------------------------------------------------------------------
    // 14. Negative: query of a missing record
    // ------------------------------------------------------------------
    function test_QueryMissingConsent_Reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(PatientConsentRegistry.ConsentNotFound.selector, CONSENT_ID)
        );
        registry.getConsentStatus(CONSENT_ID);
    }

    // ------------------------------------------------------------------
    // 15. Negative: the contract is paused
    // ------------------------------------------------------------------
    function test_RegisterConsent_RevertsWhilePaused() public {
        vm.prank(admin);
        registry.pause();

        bytes memory sig = _signCurrent(registrar, DOC_HASH, VERSION, 0);
        vm.prank(registrar);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);

        vm.prank(admin);
        registry.unpause();

        vm.prank(registrar);
        registry.registerConsent(CONSENT_ID, patient, DOC_HASH, VERSION, 0, sig);
        assertEq(registry.nonces(patient), 1, "registered after unpause");
    }
}
