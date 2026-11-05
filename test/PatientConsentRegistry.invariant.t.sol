// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Test} from "forge-std/Test.sol";
import {PatientConsentRegistry} from "../src/PatientConsentRegistry.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title ConsentRegistryHandler
 * @notice Restricts the action space so the invariant run does not degenerate
 *         into a sequence of meaningless reverting calls.
 */
contract ConsentRegistryHandler is Test {
    PatientConsentRegistry public registry;

    address public admin;
    address public registrar;
    address public patient;
    uint256 public patientPk;

    bytes32[] public seenIds;
    bytes32[] public revokedIds;
    uint256 public successfulRegisters;
    uint256 public successfulRevokes;
    uint256 public unauthorizedAttempts;

    constructor(
        PatientConsentRegistry _registry,
        address _admin,
        address _registrar,
        address _patient,
        uint256 _pk
    ) {
        registry = _registry;
        admin = _admin;
        registrar = _registrar;
        patient = _patient;
        patientPk = _pk;
    }

    function register(bytes32 consentId, bytes32 docHash) external {
        if (consentId == bytes32(0) || docHash == bytes32(0)) return;
        if (registry.checkConsentExists(consentId)) return;

        uint256 nonce = registry.nonces(patient);
        bytes32 digest = registry.hashConsent(patient, registrar, docHash, 1, 0, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(patientPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(registrar);
        try registry.registerConsent(consentId, patient, docHash, 1, 0, sig) {
            seenIds.push(consentId);
            successfulRegisters++;
        } catch {}
    }

    function revoke(uint256 idx) external {
        if (seenIds.length == 0) return;
        bytes32 consentId = seenIds[idx % seenIds.length];

        vm.prank(patient);
        try registry.revokeConsent(consentId) {
            successfulRevokes++;
            revokedIds.push(consentId);
        } catch {}
    }

    /// @dev Simulate an unauthorized privileged action (no role).
    function tryUnauthorizedRegister(bytes32 consentId, bytes32 docHash) external {
        if (consentId == bytes32(0) || docHash == bytes32(0)) return;
        if (registry.checkConsentExists(consentId)) return;

        uint256 nonce = registry.nonces(patient);
        bytes32 digest = registry.hashConsent(patient, registrar, docHash, 1, 0, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(patientPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(patient); // the patient is NOT a registrar
        try registry.registerConsent(consentId, patient, docHash, 1, 0, sig) {
        // must never happen
        }
        catch {
            unauthorizedAttempts++;
        }
    }

    function seenIdsLength() external view returns (uint256) {
        return seenIds.length;
    }

    function revokedIdsLength() external view returns (uint256) {
        return revokedIds.length;
    }
}

/**
 * @title PatientConsentRegistry invariant tests
 * @notice  Three machine-checkable invariants:
 *         I1 - a revoked consent never returns to ACTIVE;
 *         I2 - nonces increase by exactly one per successful registration and
 *              a stale-nonce signature is always rejected;
 *         I3 - every privileged state-changing call without the proper role
 *              reverts and leaves the state unchanged.
 */
contract PatientConsentRegistryInvariantTest is Test {
    PatientConsentRegistry internal registry;
    ConsentRegistryHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal registrar = makeAddr("registrar");
    address internal patient;
    uint256 internal patientPk;

    uint256 internal i3Counter;

    function setUp() public {
        (patient, patientPk) = makeAddrAndKey("patient");

        vm.prank(admin);
        registry = new PatientConsentRegistry(admin);
        vm.prank(admin);
        registry.setRegistrar(registrar, true);

        handler = new ConsentRegistryHandler(registry, admin, registrar, patient, patientPk);
    }

    // ------------------------------------------------------------------
    // I1 - a revoked consent never returns to ACTIVE
    // ------------------------------------------------------------------
    function invariant_I1_RevokedConsentNeverReturnsToActive() public view {
        uint256 len = handler.revokedIdsLength();
        for (uint256 i = 0; i < len; i++) {
            bytes32 id = handler.revokedIds(i);
            assertTrue(registry.checkConsentExists(id), "I1: revoked record must still exist");
            assertTrue(
                uint256(registry.getConsentStatus(id))
                    != uint256(PatientConsentRegistry.ConsentStatus.ACTIVE),
                "I1: revoked consent became ACTIVE again"
            );
            assertFalse(
                registry.isConsentValid(id, registrar, 1), "I1: revoked consent must not be valid"
            );
        }
    }

    // ------------------------------------------------------------------
    // I2 - the nonce advances by exactly one per successful registration
    // ------------------------------------------------------------------
    function invariant_I2_NonceEqualsSuccessfulRegistrations() public view {
        assertEq(
            registry.nonces(patient),
            handler.successfulRegisters(),
            "I2: nonce must equal the number of successful registrations"
        );
    }

    // ------------------------------------------------------------------
    // I3 - privileged calls without the role always revert
    // ------------------------------------------------------------------
    function invariant_I3_UnauthorizedCallsAlwaysRevert() public {
        // A fresh identifier for every invariant evaluation, so the call is
        // never short-circuited by an already existing record.
        bytes32 id = keccak256(abi.encode("invariant-unauthorized", i3Counter++));
        bytes32 docHash = keccak256(abi.encode("invariant-doc", id));
        uint256 nonceBefore = registry.nonces(patient);

        // A perfectly valid patient signature - only the missing role makes
        // the call unauthorized.
        bytes32 digest = registry.hashConsent(patient, registrar, docHash, 1, 0, nonceBefore);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(patientPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(patient); // the patient is NOT a registrar
        (bool ok, bytes memory ret) = address(registry)
            .call(
                abi.encodeWithSelector(
                    PatientConsentRegistry.registerConsent.selector, id, patient, docHash, 1, 0, sig
                )
            );

        assertFalse(ok, "I3: unauthorized call must revert");
        assertEq(
            bytes4(ret),
            IAccessControl.AccessControlUnauthorizedAccount.selector,
            "I3: unexpected revert reason"
        );

        // The state must be completely unchanged.
        assertFalse(registry.checkConsentExists(id), "I3: consent must not exist");
        assertEq(registry.nonces(patient), nonceBefore, "I3: nonce unchanged");

        // The unauthorized caller never obtains a registrar role.
        assertFalse(
            registry.hasRole(registry.REGISTRAR_ROLE(), patient),
            "I3: unauthorized caller must not hold REGISTRAR_ROLE"
        );
    }
}
