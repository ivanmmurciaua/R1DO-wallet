// Throwaway roundtrip test for stealth Safe address prediction — deleted after running.
import { randomBytes } from "crypto";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { privateKeyToAccount } from "viem/accounts";
import {
  derivePQKeysFromPRF,
  generateStealthPayment,
  checkPQPayment,
  extractStealthBlobs,
  deriveStealthSpendingKey,
  deriveStealthH,
} from "./stealth";
import {
  RPC_URL, BUNDLER_URL, PAYMASTER_URL,
  ENTRYPOINT_ADDRESS, SAFE_MODULES_ADDRESS, SAFE_MODULES_VERSION, SAFE_SW_VERSION,
} from "@/app/constants";

async function main() {
  console.log("=== Stealth Safe roundtrip test ===");

  const prf = new Uint8Array(randomBytes(32));
  const receiverKeys = await derivePQKeysFromPRF(prf);

  console.log("\n--- Sender: generateStealthPayment ---");
  const payment = await generateStealthPayment(receiverKeys.pqMetaAddress);
  console.log(`Sender computed stealthAddress (Safe): ${payment.stealthAddress}`);

  console.log("\n--- Receiver: extract blob from calldata + checkPQPayment ---");
  // Simulate the scanner: the blob is found by pattern-matching the calldata
  const blobs = extractStealthBlobs(payment.calldataBlob);
  if (blobs.length !== 1) {
    console.log(`❌ extractStealthBlobs found ${blobs.length} blobs (expected 1)`);
    process.exitCode = 1;
    return;
  }
  console.log(`Blob extracted: viewTag=0x${blobs[0].viewTag.toString(16).padStart(2, "0")}`);

  const matched = await checkPQPayment(
    receiverKeys.spendingPrivateKey,
    receiverKeys.viewingPrivateKey,
    receiverKeys.mlkemDecapsKey,
    blobs[0],
  );
  console.log(`Receiver computed stealthAddress (Safe): ${matched}`);
  const step1 = matched?.toLowerCase() === payment.stealthAddress.toLowerCase();
  console.log(step1 ? "✅ MATCH (generate ↔ extract ↔ check)" : "❌ MISMATCH (generate ↔ extract ↔ check)");

  console.log("\n--- Spend-side: predicted Safe must match too (spendStealthUTXO logic) ---");
  const h = await deriveStealthH(
    receiverKeys.viewingPrivateKey,
    receiverKeys.mlkemDecapsKey,
    payment.ephemeralPubkey,
    payment.kemCiphertext,
  );
  const saltNonce = BigInt(h).toString();

  const stealthPrivKey = await deriveStealthSpendingKey(
    receiverKeys.spendingPrivateKey,
    receiverKeys.viewingPrivateKey,
    receiverKeys.mlkemDecapsKey,
    payment.ephemeralPubkey,
    payment.kemCiphertext,
  );
  const stealthOwner = privateKeyToAccount(stealthPrivKey);
  console.log(`Re-derived stealth owner EOA: ${stealthOwner.address}`);

  const stealthPack = await Safe4337Pack.init({
    provider: RPC_URL,
    signer: stealthPrivKey,
    bundlerUrl: BUNDLER_URL,
    safeModulesVersion: SAFE_MODULES_VERSION,
    customContracts: {
      entryPointAddress: ENTRYPOINT_ADDRESS,
      safe4337ModuleAddress: SAFE_MODULES_ADDRESS,
    },
    paymasterOptions: { isSponsored: true, paymasterUrl: PAYMASTER_URL },
    options: {
      owners: [stealthOwner.address],
      threshold: 1,
      safeVersion: SAFE_SW_VERSION,
      saltNonce,
    },
  });
  const spendPredicted = await stealthPack.protocolKit.getAddress();
  console.log(`spendStealthUTXO would instantiate Safe at: ${spendPredicted}`);
  const isDeployed = await stealthPack.protocolKit.isSafeDeployed();
  console.log(`Is deployed on-chain (expected false — never funded): ${isDeployed}`);

  const step2 = spendPredicted.toLowerCase() === payment.stealthAddress.toLowerCase();
  console.log(step2 ? "✅ MATCH (receive ↔ spend)" : "❌ MISMATCH (receive ↔ spend)");

  if (step1 && step2) {
    console.log("\n🎉 Full roundtrip verified — same Safe address across generate/check/spend");
  } else {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exitCode = 1;
});
