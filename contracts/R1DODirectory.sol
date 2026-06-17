// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title R1DODirectory — opaque encrypted username directory (v2)
/// @notice Replaces the legacy PasskeyRegistry. Stores only AEAD blobs keyed
/// by an Argon2id-derived fingerprint: no usernames, no passkey
/// coordinates, no plaintext addresses. Nothing stored here is
/// harvestable by a future quantum adversary (symmetric crypto only),
/// and enumerating users requires one Argon2id evaluation (64 MiB,
/// ~1 s) per username guess instead of a free keccak.
///
/// Entry layout (opaque to the contract):
///   nonce(24) ‖ XChaCha20-Poly1305( padded payload )
/// where payload = version ‖ rawId ‖ safeAddress [‖ pqMetaAddress],
/// padded to a fixed size so all entries are indistinguishable.
///
/// Losing access to this contract NEVER locks funds: login works
/// from the resident passkey alone; the directory only powers
/// pay-by-username.
contract R1DODirectory {
    mapping(bytes32 => bytes) private entries;
    mapping(bytes32 => address) public writers;

    event EntrySet(bytes32 indexed fp, address indexed writer);

    /// First write claims the slot; updates only by the original writer
    /// (the user's Safe — its owner key derives from the same passkey).
    function setEntry(bytes32 fp, bytes calldata blob) external {
        address w = writers[fp];
        require(w == address(0) || w == msg.sender, "not entry owner");
        if (w == address(0)) writers[fp] = msg.sender;
        entries[fp] = blob;
        emit EntrySet(fp, msg.sender);
    }

    function getEntry(bytes32 fp) external view returns (bytes memory) {
        return entries[fp];
    }

    function hasEntry(bytes32 fp) external view returns (bool) {
        return entries[fp].length != 0;
    }
}
