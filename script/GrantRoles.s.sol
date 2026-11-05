// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {PatientConsentRegistry} from "../src/PatientConsentRegistry.sol";

/**
 * @title GrantRoles
 * @notice Grants or revokes the registrar role of an account.
 *
 * Usage:
 *   forge script script/GrantRoles.s.sol:GrantRoles \
 *     --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key <admin-pk>
 *
 * Environment: REGISTRY_ADDRESS, REGISTRAR_ADDRESS, ENABLED (true/false)
 */
contract GrantRoles is Script {
    function run() external {
        uint256 adminPk = vm.envUint("ADMIN_PRIVATE_KEY");
        address registry = vm.envAddress("REGISTRY_ADDRESS");
        address registrar = vm.envAddress("REGISTRAR_ADDRESS");
        bool enabled = vm.envBool("ENABLED");

        vm.startBroadcast(adminPk);
        PatientConsentRegistry r = PatientConsentRegistry(registry);
        r.setRegistrar(registrar, enabled);
        vm.stopBroadcast();

        console.log("Registrar role set to", enabled, "for", registrar);
    }
}
