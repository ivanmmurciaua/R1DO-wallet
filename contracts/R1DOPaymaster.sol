// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

import "@account-abstraction/contracts/core/BasePaymaster.sol";

/// @title R1DOPaymaster — an OWN ERC-4337 v0.7 paymaster, for one purpose: to be
/// the paymaster address that Δ stealth-payment UserOps carry.
///
/// WHY THIS EXISTS (the scanner, not gas policy). The stealth scanner finds a
/// received payment by filtering EntryPoint `UserOperationEvent` logs on the
/// paymaster (an indexed field), then trial-decrypting the calldata of each hit.
/// When Δ payments are sponsored by Pimlico's SHARED verifying paymaster, that
/// filter matches every Pimlico customer's op on the chain — the scan downloads
/// thousands of unrelated txs to find a handful of ours (measured: 11,733 fetched
/// to find 0). Route Δ payments through THIS paymaster instead and the filter
/// matches only Δ payments: the fan-out doesn't get cheaper, it disappears. Gas
/// policy / the fee model live elsewhere (the batch splitter), NOT here.
///
/// AUDITED BASE. This inherits eth-infinitism's audited BasePaymaster (v0.7.0) for
/// all the machinery that touches funds and consensus — the EntryPoint interface,
/// deposit/stake plumbing, the ERC-165 entryPoint sanity check, and the
/// only-from-EntryPoint guards. The ONLY code that is ours is the sponsorship
/// decision below.
///
/// SPONSORSHIP RULE (this cut = permissive, testnet only). `_validatePaymasterUserOp`
/// sponsors every op unconditionally: no off-chain signer (a signer would see every
/// op before signing = it would just move the metadata leak from Pimlico to us), and
/// no on-chain gate yet. Returning an EMPTY context means the EntryPoint never calls
/// `postOp`, so the base's `_postOp` (which reverts unless overridden) is never
/// reached. It reads no storage → no EntryPoint stake is required to be bundled.
/// On a testnet "permissive" only means anyone could spend our free test ETH — we
/// top the deposit back up. The bounded-exposure gate that makes this safe on
/// mainnet (cap + owner pause) is a later iteration; it changes nothing the scanner
/// depends on.
contract R1DOPaymaster is BasePaymaster {
    constructor(IEntryPoint _entryPoint) BasePaymaster(_entryPoint) {}

    function _validatePaymasterUserOp(
        PackedUserOperation calldata, /* userOp */
        bytes32, /* userOpHash */
        uint256 /* maxCost */
    ) internal pure override returns (bytes memory context, uint256 validationData) {
        return ("", 0);
    }
}
