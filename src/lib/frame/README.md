# frame rail (hegota)

This folder is the removable hegota frame-native rail surface for the delta1 wallet.
In FASE 0 it is strictly READ-ONLY: it can read a native balance and an account
view over the Hegota testnet (chainId 8141), and nothing more.

It touches NO base code: every file here is new and self-contained, built only on
`viem` and the TS standard library (no engine package, no new dependency). The
`FrameNetwork` type is local on purpose so the base registry stays decoupled.

The shadow world (Railgun privacy pool) is intentionally UNAVAILABLE on this rail:
frame-native networks carry `pool: false` and have no 4337 backend. Write entry
points (`send`/`execute`) throw `NotImplemented` until a later phase wires them.

To remove the rail: delete this `frame/` folder, plus the future one-line seam in
the base backend selection that calls `frameBackendFor(networkId)`. Nothing else
in the wallet depends on it.
