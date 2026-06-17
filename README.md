# R1DO Wallet — Δ (Delta)

> A self-custody wallet you open with your fingerprint. No seed phrases, no
> third parties — and now with **two worlds**: a normal, public side, and a
> private side where your money moves without leaving a trail.

> [!CAUTION]
> **Testnet only.** Δ runs on Ethereum **Sepolia** (test network, play money).
> Don't put real savings here. This is experimental software.

---

## What is it?

R1DO Wallet is a crypto wallet for normal people. You create it with the same
gesture you use to unlock your phone — your **passkey** (fingerprint / face /
PIN). There's no seed phrase to write down, no password, and no company in the
middle holding your keys. You, and only you, control your funds.

**Δ (Delta)** is the version that adds **privacy as a first-class feature**.
Most wallets are a glass house: anyone can follow every payment you make. Δ
gives you a second, private world where your balance and your payments are
hidden — while keeping the easy, public wallet for everyday use.

## The two worlds, one switch

Δ has a single toggle that flips the whole wallet between two modes:

- **🌖 Public world** — a clean, normal smart wallet. Send and receive, pay
  people by username, check your balance. Everything works the way you'd
  expect.
- **🌑 Private world (the shadows)** — your funds enter a **privacy pool** where
  amounts and links are hidden. You can send privately, receive privately, and
  take money back out to a fresh address that isn't tied to your identity.

You move money between the two worlds whenever you want. Public when you want
convenience, private when you want privacy.

## What you can do

- **Open a wallet in seconds** with just a username and your device passkey —
  no seed phrase, no email, no third-party login.
- **Pay by username.** Type a friend's name instead of a long `0x…` address.
  The lookup is encrypted, so the list of who's who isn't public.
- **Send privately.** Pay someone so that the amount and the connection between
  you stay hidden.
- **Receive privately** at one-time "stealth" addresses that can't be linked
  back to you.
- **Cash out** from the private world to any address — including a brand-new
  one only you control, so the exit doesn't reveal who you are.

## Privacy, in plain terms

Δ stacks a few ideas so that "private" actually means private:

- **Stealth addresses** — every private payment lands at a fresh, single-use
  address. Nobody watching the chain can tell they're all yours.
- **A privacy pool** — funds you make private get mixed into a shared pool, so
  individual amounts and senders/receivers are hidden by zero-knowledge proofs
  (math that proves a payment is valid *without revealing its details*).
- **Future-proof secrecy** — the part of the system that decides "who can
  discover this private payment" is protected with **post-quantum**
  cryptography, so it stays private even against the powerful computers of the
  future. (See [TECHSTACK.md](./TECHSTACK.md) for the details.)

## Why passkeys instead of seed phrases?

A seed phrase is a long secret you must write down and never lose. Passkeys
replace that with the secure chip already in your phone or laptop (the same one
that guards your fingerprint). Your wallet's keys are *derived* from that
passkey on the fly and never stored anywhere — not on a server, not by us.

> [!WARNING]
> **This is real self-custody.** If you create the passkey only on your device
> and lose it without a backup/sync, you lose access to the wallet — the same
> way losing a seed-phrase paper would. With great power, etc.

## How it's built (the short version)

- **Smart wallet:** each account is a [Safe](https://safe.global) smart account
  running on account abstraction (ERC-4337); gas is sponsored so you don't need
  to hold ETH just to get started.
- **Private pool:** powered by the [Railgun](https://railgun.org) privacy
  system (zero-knowledge proofs).
- **App:** Next.js + React, viem, MUI.

For a deep, primitive-by-primitive breakdown — especially the **cryptography** —
read **[TECHSTACK.md](./TECHSTACK.md)**.

## Run it locally

```bash
npm install
cp .env.example .env     # add your Pimlico API key (and directory address, if used)
```

```bash
# Δ uses the Railgun engine in the browser, which needs the full webpack build.
npm run build
npm run start
```

> [!NOTE]
> Use **build + start**, not `dev`. The private pool relies on Node polyfills
> that only apply under the webpack production build.

## Status & roadmap

- [x] Passkey-derived smart wallet (no seed phrase)
- [x] Pay by username (encrypted directory)
- [x] Stealth / private payments (post-quantum hybrid)
- [x] Private pool: shield · private transfer · unshield
- [ ] Auto-shield of incoming funds
- [ ] Key rotation & recovery flows
- [ ] Security audit
- [ ] Mainnet (only after audit)

---

### License & credits

Δ is the experimental privacy fork of R1DO Wallet.
Licensed under the MIT License — see [LICENSE](LICENSE).

Copyright (c) 2025–2026 Iván M.M
