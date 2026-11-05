// SPDX-License-Identifier: MIT
pragma solidity ^0.8.37;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {PatientConsentRegistry} from "../src/PatientConsentRegistry.sol";

/**
 * @title Deploy
 * @notice Deploys the fixed PatientConsentRegistry and grants REGISTRAR_ROLE
 *         to the registrar account. Designed for the Anvil local network.
 *
 * Usage:
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url http://127.0.0.1:8545 \
 *     --broadcast --private-key <admin-pk>
 */
contract Deploy is Script {
    function run() external {
        uint256 adminPk = vm.envUint("ADMIN_PRIVATE_KEY");
        address registrar = vm.envAddress("REGISTRAR_ADDRESS");

        vm.startBroadcast(adminPk);
        PatientConsentRegistry registry = new PatientConsentRegistry(vm.addr(adminPk));
        registry.setRegistrar(registrar, true);
        vm.stopBroadcast();

        console.log("PatientConsentRegistry deployed at:", address(registry));
        console.log("Admin:", vm.addr(adminPk));
        console.log("Registrar:", registrar);
    }
}
