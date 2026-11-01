# frame rail (hegota)

This folder is the removable hegota frame-native rail of the delta1 wallet: EIP-8141
frame-tx accounts with post-quantum keys on the ethrex privacy testnet (chainId 8141).

- `network.ts`: the local `FrameNetwork` registry (kept separate from the base 4337 registry).
- `railMode.ts`: is the rail the active network (the one check the page branches on).
- `railCore.ts`: shared core (seed derivation, sponsored vs self-pay rule, tx submission with
  the dropped-tx rebroadcast, the open-sponsor deploy, frame-tx decode for the UI).
- `lssRail.ts` / `mldsaRail.ts`: the two account classes a user can pick (leanSphincs-s,
  default, or ML-DSA-44).
- `pq.worker.ts` + `pqClient.ts`: the Comlink Web Worker that holds the keys, and its
  main-thread client. Secret keys never leave the worker.
- `stealthStore.ts`: the on-device store of stealth tickets (the only key to those funds).
- `engine/`: the vendored frame-tx engine (codec, ML-DSA, ML-KEM DKSAP, leanSphincs-s wasm).

The shadow world (Railgun privacy pool) is intentionally unavailable on this rail:
frame-native networks carry `pool: false` and have no 4337 backend.

To remove the rail: delete this `frame/` folder, the `Frame*.tsx` components, the
page-level branch that renders them when `isRailActive()` is true, and the Settings
network picker entries built from `FRAME_NETWORKS`.
