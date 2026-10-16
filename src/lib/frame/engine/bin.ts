// Vendored creation bytecode for the hegota rail (FASE 1.2a). These are the compiled
// AccountPQ and CREATE2 Factory from the testbed engine, inlined as hex so the worker
// needs no filesystem access. Source: r_hegota-testbed/engine-ts/test/fixtures/*.bin.
//
// AccountPQ: the post-quantum self-paying account. Constructor tail (appended at deploy)
// is commit(32) || pad(12) || verifier(20); see account.ts accountInitcode.
// Factory: a minimal CREATE2 deployer (calldata = salt || initcode), forwards msg.value.
import type { Hex } from "viem";

export const ACCOUNT_PQ_BIN: Hex = "0x604038603f19015f395f515f5560205160015560828061001e5f395ff3fe346080576009b0600ab09060021901146079576001546008b063c34781db60e01b5f526060600452602452615780604452615700806064525f81816084b55f6109748061578452826157a4b55f54906084200360755760205f91616124809381925afa1560755762495a6360e31b905103607557005b5f80fd5b60035f80aa005b00";
export const FACTORY_BIN: Hex = "0x602080600a5f395ff3fe36601f19018060205f375f35905f34f58015601c575f526014600cf35b5f80fd";
