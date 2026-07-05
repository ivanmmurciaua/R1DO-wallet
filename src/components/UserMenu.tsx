import React, { useState, useEffect, useCallback } from "react";
import {
  Button,
  Stack,
  Box,
  Typography,
  CircularProgress,
  IconButton,
} from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { SendEth } from "./SendEth";
import { SpendStealthUTXO } from "./SpendStealthUTXO";
import { ReceivePrivate } from "./ReceivePrivate";
import { QrCode } from "./QrCode";
import { GlitchText } from "./GlitchText";
import Popup from "./Popup";
import type { SafeWallet } from "@/lib/aa-client";
import { formatUnits, createPublicClient } from "viem";
import { sepoliaTransport } from "@/app/constants";
import { activeChain, activeChainId, networkName, explorerTxUrl, explorerAddressUrl } from "@/lib/networks";
import { getStealthBalances, getTokenBalances } from "@/lib/balances";
import { activeTokens, assetByAddress, formatAsset, type Asset } from "@/lib/assets";
import { getLastBlock } from "@/lib/client";
import { getDecimals, getSymbol, getStealthUTXOs, getSpendableUTXOs, applyStealthCleanup, getWalletMeta, saveStealthScanDurable, getLastScannedBlock, patchStealthUTXO, getHideBalance, setHideBalance } from "@/lib/localstorage";
import { getWalletCredential } from "@/lib/credstore";
import { loadFromDevice } from "@/lib/passkeys";
import { derivePQKeysFromPRF, scanStealthPayments, type StealthUTXO } from "@/lib/stealth";

type UserMenuProps = {
  wallet: SafeWallet;
  username: string;
  balance: number;
  address: string; // public Safe address — shown/copied in public Receive
};

type Transaction = {
  id: string;
  type: "sent" | "received" | "private";
  amount: number;
  proportion?: number;
  stealthAddress?: string;
  weiBalance?: bigint; // exact on-chain balance (private/stealth) — spend uses this, not the rounded `amount`
  symbol?: string; // per-row asset symbol (ERC20). undefined → native symbol.
  hash?: string; // tx hash for the explorer link (id is kept unique per row)
};

type EtherscanTransaction = {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  input: string;
  type: string;
  gas: string;
  gasUsed: string;
  traceId: string;
  isError: string;
  errCode: string;
};

type EtherscanResponse = {
  status: string;
  message: string;
  result: EtherscanTransaction[];
};

// ERC20 transfer row (Etherscan `tokentx`) — carries the token's own symbol and
// decimals per row, so each tx renders in its real units.
type EtherscanTokenTx = {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenSymbol: string;
  tokenDecimal: string;
  contractAddress: string;
};

type EtherscanTokenResponse = {
  status: string;
  message: string;
  result: EtherscanTokenTx[];
};

// Compact amount formatter: 2 decimals max, K/M/B for large values
// (11105.76 → "11.11K", 12.34 → "12.34", 1.23e6 → "1.23M").
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const fmtAmount = (n: number) => compactFmt.format(n);

export const UserMenu: React.FC<UserMenuProps> = ({ wallet, username, balance, address }) => {
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  const [currentView, setCurrentView] = useState<"menu" | "sendEth" | "spendUtxo" | "receivePrivate" | "receivePublic">("menu");
  const [copied, setCopied] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [stealthTxs, setStealthTxs] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUtxo, setSelectedUtxo] = useState<StealthUTXO | null>(null);
  const [selectedBalance, setSelectedBalance] = useState<number>(0);
  const [selectedWei, setSelectedWei] = useState<bigint>(0n);
  const [hideBalance, setHide] = useState<boolean>(() => getHideBalance());

  // Token list — collapsed by default; clicking the balance expands it and (only
  // then) fetches each curated token across the main Safe + stealth addresses in
  // one Multicall3 round-trip per token. Lazy: no token reads until expanded.
  const [showTokens, setShowTokens] = useState(false);
  const [tokenBals, setTokenBals] = useState<{ asset: Asset; total: bigint }[] | null>(null);
  const [tokensLoading, setTokensLoading] = useState(false);

  useEffect(() => {
    if (!showTokens) return;
    const tokens = activeTokens();
    if (tokens.length === 0) return;
    let mounted = true;
    const client = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
    const fetchTokens = async () => {
      try {
        if (tokenBals === null) setTokensLoading(true);
        // Public wallets hold no stealth funds (they never scan) → don't touch the
        // stealth store; query token balances on the main address only.
        const stealth = privacy ? getSpendableUTXOs(username).map((u) => u.stealthAddress) : [];
        const addrs = [address, ...stealth] as `0x${string}`[];
        const out = await Promise.all(
          tokens.map(async (t) => {
            const raws = await getTokenBalances(client, t.address as `0x${string}`, addrs);
            return { asset: t, total: raws.reduce((s, r) => s + r, 0n) };
          }),
        );
        if (mounted) setTokenBals(out);
      } catch (e) {
        console.warn("[UserMenu] token balances:", e);
      } finally {
        if (mounted) setTokensLoading(false);
      }
    };
    fetchTokens();
    const id = setInterval(fetchTokens, 15000);
    return () => {
      mounted = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTokens, username, address]);

  const toggleHideBalance = () => {
    setHide((h) => {
      const next = !h;
      setHideBalance(next);
      return next;
    });
  };

  const handleShowPopup = (message: string) => {
    setShowPopup(true);
    setPopupMessage(message);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        setShowPopup(false);
        resolve();
      }, 2000);
    });
  };

  const handleSendEth = () => {
    setCurrentView("sendEth");
  };

  const handleReceive = () => {
    setCurrentView(privacy ? "receivePrivate" : "receivePublic");
  };

const handleBackToMenu = (message: string = "") => {
    if (message !== "") {
      handleShowPopup(message);
    }
    setCurrentView("menu");
  };

  const handleOpenSpend = (transaction: Transaction) => {
    if (transaction.type !== "private" || !transaction.stealthAddress) return;
    const utxo = getStealthUTXOs(username).find((u) => u.stealthAddress === transaction.stealthAddress);
    if (!utxo) return;
    setSelectedUtxo(utxo);
    setSelectedBalance(transaction.amount);
    setSelectedWei(transaction.weiBalance ?? 0n);
    setCurrentView("spendUtxo");
  };

  const privacy = getWalletMeta(username)?.privacy ?? false;
  const symbol = getSymbol();

  // Headline balance for the wallet-home card: native stealth total in a privacy
  // wallet (sum ONLY native rows — token rows carry their own symbol and can't be
  // added into the ⧫ figure), else the public Safe.
  const shownBalance = privacy
    ? Number(formatUnits(stealthTxs.filter((t) => !t.symbol).reduce((s, t) => s + (t.weiBalance ?? 0n), 0n), getDecimals()))
    : balance;

  const fetchTransactions = useCallback(async () => {
    if (privacy) return; // private wallet — no Etherscan
    setLoading(true);
    try {
      const address = await wallet.protocolKit.getAddress();
      const userAddress = address.toLowerCase();
      const apiKey = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY;
      const block = await getLastBlock();

      // Native (internal ETH calls — the Safe sends as an internal call) and ERC20
      // transfers (tokentx) come from sibling Etherscan endpoints; fetch both and
      // merge into one time-ordered feed. Each token row keeps its own decimals.
      const base = `https://api.etherscan.io/v2/api?chainid=${activeChainId()}&address=${address}&startblock=0&endblock=${block}&page=1&offset=10&sort=desc&apikey=${apiKey}`;
      const [nativeData, tokenData]: [EtherscanResponse, EtherscanTokenResponse] = await Promise.all([
        fetch(`${base}&module=account&action=txlistinternal`).then((r) => r.json()),
        fetch(`${base}&module=account&action=tokentx`).then((r) => r.json()),
      ]);

      const decimals = getDecimals();
      const rows: (Transaction & { ts: number })[] = [];

      if (nativeData.status === "1" && Array.isArray(nativeData.result)) {
        for (const tx of nativeData.result) {
          if (tx.type !== "call") continue;
          rows.push({
            id: `${tx.hash}:native`,
            hash: tx.hash,
            type: tx.from.toLowerCase() === userAddress ? "sent" : "received",
            amount: parseFloat(formatUnits(BigInt(tx.value), decimals)),
            ts: Number(tx.timeStamp),
          });
        }
      }

      // Only curated tokens — keeps spam/scam airdrops out of the feed.
      const curated = new Set(activeTokens().map((t) => t.address!.toLowerCase()));
      if (tokenData.status === "1" && Array.isArray(tokenData.result)) {
        for (const tx of tokenData.result) {
          if (!curated.has(tx.contractAddress.toLowerCase())) continue;
          rows.push({
            id: `${tx.hash}:${tx.contractAddress.toLowerCase()}`,
            hash: tx.hash,
            type: tx.from.toLowerCase() === userAddress ? "sent" : "received",
            amount: parseFloat(formatUnits(BigInt(tx.value), Number(tx.tokenDecimal))),
            symbol: tx.tokenSymbol,
            ts: Number(tx.timeStamp),
          });
        }
      }

      rows.sort((a, b) => b.ts - a.ts);
      setTransactions(
        rows.slice(0, 12).map((t) => ({ id: t.id, hash: t.hash, type: t.type, amount: t.amount, symbol: t.symbol })),
      );
    } catch (error) {
      console.error("Error fetching transactions:", error);
    } finally {
      setLoading(false);
    }
  }, [wallet, privacy]);

  useEffect(() => {
    if (wallet) {
      fetchTransactions();
      const interval = setInterval(fetchTransactions, 90000);
      return () => clearInterval(interval);
    }
  }, [wallet, fetchTransactions]);

  const fetchStealthBalances = useCallback(async () => {
    let utxos = getSpendableUTXOs(username);
    if (utxos.length === 0) return;
    const pub = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });

    // Discover the asset of still-untagged pre-minted notes (off-chain Courier
    // receives). An ERC20 sent to one would otherwise read as native 0 forever:
    // no tag → no receivedAt → never listed. On-chain finds are tagged in the
    // scan and Ghost notes at creation, but Courier notes are minted blank — so
    // probe curated tokens over them here (the periodic detection path) and tag
    // the hit; the native/token split + received-stamp below then treat it right.
    const untagged = utxos.filter((u) => u.localOnly && !u.asset);
    if (untagged.length > 0) {
      const addrs = untagged.map((u) => u.stealthAddress);
      for (const t of activeTokens()) {
        const bals = await getTokenBalances(pub, t.address as `0x${string}`, addrs);
        bals.forEach((b, i) => {
          if (b > 0n) patchStealthUTXO(username, addrs[i], { asset: t.address as `0x${string}` });
        });
      }
      utxos = getSpendableUTXOs(username); // re-read with the fresh asset tags
    }

    type Row = { utxo: StealthUTXO; raw: bigint; amount: number; symbol?: string };
    const rows: Row[] = [];

    // Displayed amount is rounded; sub-dust (e.g. 1 wei) rounds to 0 and is
    // treated as "no funds" — both for the list and the received stamp.
    const round = (raw: bigint, decimals: number) => parseFloat(parseFloat(formatUnits(raw, decimals)).toFixed(4));

    // Native UTXOs (no asset tag) — one Multicall3 in native units.
    const nativeUtxos = utxos.filter((u) => !u.asset);
    if (nativeUtxos.length > 0) {
      const decimals = getDecimals();
      const bals = await getStealthBalances(pub, nativeUtxos.map((u) => u.stealthAddress));
      nativeUtxos.forEach((utxo, i) => {
        const raw = bals[i] ?? 0n;
        rows.push({ utxo, raw, amount: round(raw, decimals) });
      });
    }

    // Token UTXOs — grouped by the tagged asset; one Multicall3 per token, read
    // in that token's own decimals. Only the known token is queried (never the
    // whole curated set) — that's the point of tagging at discovery.
    const tokenUtxos = utxos.filter((u) => !!u.asset);
    const byToken = new Map<string, StealthUTXO[]>();
    for (const u of tokenUtxos) {
      const k = u.asset!.toLowerCase();
      const g = byToken.get(k);
      if (g) g.push(u);
      else byToken.set(k, [u]);
    }
    for (const [tokenAddr, group] of byToken) {
      const asset = assetByAddress(tokenAddr);
      const decimals = asset?.decimals ?? 18;
      const bals = await getTokenBalances(pub, tokenAddr as `0x${string}`, group.map((u) => u.stealthAddress));
      group.forEach((utxo, i) => {
        const raw = bals[i] ?? 0n;
        rows.push({ utxo, raw, amount: round(raw, decimals), symbol: asset?.symbol });
      });
    }

    // Stamp first-funding once (sequential → no read-modify-write race). This is
    // the persistent "received" signal the ReceivePrivate list reads, so status
    // never needs its own balance fetch.
    for (const { utxo, raw, amount } of rows) {
      if (amount > 0 && !utxo.receivedAt) patchStealthUTXO(username, utxo.stealthAddress, { receivedAt: Date.now() });
      // Tombstone an address that was funded (receivedAt) and now reads 0: it's
      // been spent, so it drops out of every future read. Confirmed 0 only — a
      // thrown multicall never reaches here. Never funded → leave it (a Courier
      // receive awaiting funds reads 0 too, but that's "pending", not "spent").
      else if (raw === 0n && utxo.receivedAt) applyStealthCleanup(username, utxo.stealthAddress);
    }

    setStealthTxs(
      rows
        .filter((r) => r.amount > 0)
        .map(({ utxo, raw, amount, symbol }) => ({
          id: utxo.stealthAddress,
          type: "private" as const,
          amount,
          stealthAddress: utxo.stealthAddress,
          weiBalance: raw, // exact — spend clamps to this, never the rounded `amount`
          symbol, // undefined = native ⧫; token symbol otherwise (drives the row label)
        })),
    );
  }, [username]);

  const handleBackFromSpend = (message: string = "") => {
    setSelectedUtxo(null);
    handleBackToMenu(message);
    fetchStealthBalances();
  };

  const refreshPrivate = useCallback(async () => {
    const cred = await getWalletCredential(username).catch(() => null);
    if (!cred) return;
    setLoading(true);
    try {
      const prf = await loadFromDevice(cred.rawId);
      if (!prf || prf.length === 0) {
        await fetchStealthBalances();
        return;
      }
      const keys = await derivePQKeysFromPRF(prf);
      const lastBlock = getLastScannedBlock(username);
      const pub = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
      const fromBlock = lastBlock ?? (await pub.getBlockNumber() - 21600n);
      // Windowed scan: each window persists to idb and only THEN advances the
      // cursor → resumable, never skips a UTXO (see saveStealthScanDurable).
      let merged = [...getStealthUTXOs(username)];
      await scanStealthPayments(
        keys.spendingPrivateKey,
        keys.viewingPrivateKey,
        keys.mlkemDecapsKey,
        fromBlock,
        async (windowUtxos, windowEnd) => {
          merged = [
            ...merged,
            ...windowUtxos.filter((u) => !merged.some((e) => e.stealthAddress === u.stealthAddress)),
          ];
          await saveStealthScanDurable(username, merged, windowEnd);
        },
      );
      await fetchStealthBalances();
    } catch (e) {
      console.error("[refreshPrivate] error:", e);
      await fetchStealthBalances();
    } finally {
      setLoading(false);
    }
  }, [username, fetchStealthBalances]);

  useEffect(() => {
    if (!privacy) return;
    fetchStealthBalances();
    // The login-time scan (runStealthScan) writes new UTXOs to localStorage in
    // the background — poll so the list picks them up once it lands, instead
    // of staying frozen at whatever was there when this component mounted.
    const id = setInterval(fetchStealthBalances, 15000);
    return () => clearInterval(id);
  }, [privacy, fetchStealthBalances]);

  if (currentView === "sendEth") {
    return <SendEth wallet={wallet} username={username} balance={balance} onBack={handleBackToMenu} />;
  }

  if (currentView === "spendUtxo" && selectedUtxo) {
    return (
      <SpendStealthUTXO
        utxo={selectedUtxo}
        balance={selectedBalance}
        balanceWei={selectedWei}
        username={username}
        onBack={handleBackFromSpend}
      />
    );
  }

  if (currentView === "receivePrivate") {
    return <ReceivePrivate username={username} onBack={handleBackFromSpend} />;
  }

  if (currentView === "receivePublic") {
    const copyAddress = () => {
      navigator.clipboard?.writeText(address ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    return (
      <Box sx={{ pb: 4 }}>
        {/* Header */}
        <Box sx={{ display: "flex", alignItems: "center", maxWidth: 400, mx: "auto", mb: 1 }}>
          <IconButton onClick={() => setCurrentView("menu")} size="small" aria-label="Back">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography sx={{ flex: 1, textAlign: "center", fontWeight: 600, letterSpacing: "0.02em", mr: 4 }}>
            Receive
          </Typography>
        </Box>

        <Stack spacing={2.5} direction="column" alignItems="center" sx={{ width: "100%", maxWidth: 400, mx: "auto" }}>
          {/* QR */}
          <Box sx={{ display: "flex", justifyContent: "center", mt: 1 }}>
            <QrCode value={address ?? ""} size={232} />
          </Box>

          <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center", lineHeight: 1.6, maxWidth: 300 }}>
            Scan to send {symbol}, or copy your address below.
          </Typography>

          {/* Address card — whole row copies */}
          <Box
            onClick={copyAddress}
            title="Tap to copy your address"
            sx={{
              width: "100%",
              border: "1px solid",
              borderColor: copied ? "success.main" : "divider",
              borderRadius: 2,
              px: 1.75,
              py: 1.5,
              cursor: "pointer",
              transition: "border-color 0.15s",
              "&:hover": { borderColor: "primary.main" },
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.75 }}>
              <Typography sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Your address
              </Typography>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, color: copied ? "success.main" : "primary.main" }}>
                {copied ? <CheckIcon sx={{ fontSize: "0.95rem" }} /> : <ContentCopyIcon sx={{ fontSize: "0.95rem" }} />}
                <Typography sx={{ fontSize: "0.68rem", letterSpacing: "0.04em" }}>
                  {copied ? "copied" : "copy"}
                </Typography>
              </Box>
            </Box>
            <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.82rem", wordBreak: "break-all", lineHeight: 1.5 }}>
              {address}
            </Typography>
          </Box>

          <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.62rem", opacity: 0.5, letterSpacing: "0.06em", textAlign: "center" }}>
            {networkName()}
          </Typography>
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 2 }}>
      <Stack
        spacing={2}
        direction="column"
        sx={{ width: "100%", maxWidth: 400, mx: "auto" }}
      >
        {/* Wallet-home balance card */}
        <Box
          sx={{
            border: "1px solid", borderColor: "divider", borderRadius: "2px", p: 2, textAlign: "left",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.5 }}>
            <Typography sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Your balance
            </Typography>
            <IconButton
              onClick={toggleHideBalance}
              size="small"
              aria-label={hideBalance ? "Show balance" : "Hide balance"}
              title={hideBalance ? "Show balance" : "Hide balance"}
              sx={{ p: 0.25 }}
            >
              {hideBalance ? <VisibilityOffIcon sx={{ fontSize: "1rem" }} /> : <VisibilityIcon sx={{ fontSize: "1rem" }} />}
            </IconButton>
          </Box>
          <Typography
            onClick={activeTokens().length > 0 ? () => setShowTokens((s) => !s) : undefined}
            title={activeTokens().length > 0 ? "Show tokens" : undefined}
            sx={{
              fontFamily: "var(--font-geist-mono), monospace",
              fontSize: "2rem",
              lineHeight: 1.1,
              fontWeight: 500,
              wordBreak: "break-all",
              cursor: activeTokens().length > 0 ? "pointer" : "default",
              userSelect: "none",
            }}
          >
            {hideBalance ? <GlitchText length={7} /> : fmtAmount(shownBalance)} {symbol}
            {activeTokens().length > 0 && (
              <Box
                component="span"
                sx={{
                  fontSize: "0.9rem",
                  opacity: 0.45,
                  ml: 1,
                  display: "inline-block",
                  transform: showTokens ? "rotate(180deg)" : "none",
                  transition: "transform 0.15s",
                }}
              >
                ▾
              </Box>
            )}
          </Typography>
          <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.7rem", opacity: 0.6, mt: 0.75, letterSpacing: "0.04em" }}>
            {username} · {privacy ? "private" : "public"} · light
          </Typography>

          {/* Token list — expands on balance click; lazy Multicall3 fetch (Fase 1). */}
          {activeTokens().length > 0 && showTokens && (
            <Box sx={{ mt: 1.5, pt: 1.5, borderTop: "1px solid", borderColor: "divider" }}>
              {tokensLoading && tokenBals === null ? (
                <Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
                  <CircularProgress size={14} />
                </Box>
              ) : (
                (tokenBals ?? []).map(({ asset, total }) => (
                  <Box key={asset.address} sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", py: 0.4 }}>
                    <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.78rem", opacity: 0.7 }}>
                      {asset.symbol}
                    </Typography>
                    <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.85rem" }}>
                      {hideBalance ? <GlitchText length={4} /> : fmtAmount(Number(formatAsset(total, asset)))}
                    </Typography>
                  </Box>
                ))
              )}
            </Box>
          )}
        </Box>

        <div>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              mt: 3,
              mb: 2,
              gap: 1,
            }}
          >
            <Typography
              sx={{
                fontWeight: 500,
              }}
            >
              {/* Private wallets list stealth UTXOs, not txs — be honest about it. */}
              {privacy ? "Stealth UTXOs" : "Recent Transactions"}
            </Typography>
            <IconButton
              onClick={privacy ? refreshPrivate : fetchTransactions}
              disabled={loading}
              size="small"
              sx={{ color: "primary.main" }}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Box>

          {loading ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
              <CircularProgress size={24} />
            </Box>
          ) : (privacy ? stealthTxs : transactions).length === 0 ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
              <Typography variant="body2" color="text.secondary">
                No transactions found
              </Typography>
            </Box>
          ) : (
            <Stack spacing={0.75} sx={{ maxHeight: 240, overflowY: "auto", pr: 0.5, maxWidth: 300, mx: "auto" }}>
              {(privacy ? stealthTxs : transactions).map((transaction) => (
                <Box
                  key={transaction.id}
                  component={transaction.type !== "private" ? "a" : "div"}
                  href={transaction.type !== "private" ? (explorerTxUrl(transaction.hash ?? transaction.id) ?? undefined) : undefined}
                  target={transaction.type !== "private" ? "_blank" : undefined}
                  rel={transaction.type !== "private" ? "noopener noreferrer" : undefined}
                  onClick={transaction.type === "private" ? () => handleOpenSpend(transaction) : undefined}
                  title={transaction.type === "private" ? "Tap to spend from this stealth balance" : undefined}
                  sx={{
                    display: "flex", alignItems: "center", gap: 1,
                    border: "1px solid", borderColor: "divider", borderRadius: "2px",
                    px: 1.25, py: 0.75,
                    cursor: "pointer", textDecoration: "none", color: "inherit",
                    "&:hover": { borderColor: "primary.main" },
                  }}
                >
                  {transaction.type === "sent" ? (
                    <ArrowForwardIcon sx={{ color: "primary.main", fontSize: "1.1rem", flexShrink: 0 }} />
                  ) : transaction.type === "received" ? (
                    <ArrowBackIcon sx={{ color: "secondary.main", fontSize: "1.1rem", flexShrink: 0 }} />
                  ) : (
                    <Typography sx={{ fontSize: "1rem", fontFamily: "var(--font-geist-mono), monospace", opacity: 0.6, lineHeight: 1, flexShrink: 0 }}>
                      ◈
                    </Typography>
                  )}
                  <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: 1, gap: 1, minWidth: 0, fontFamily: "var(--font-geist-mono), monospace" }}>
                    {transaction.type === "private" && (
                      // Clickable → explorer for the ACTIVE network. stopPropagation so
                      // it opens the address page instead of triggering the row's spend.
                      <Typography
                        component="a"
                        href={explorerAddressUrl(transaction.stealthAddress ?? "") ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title="View this stealth address on the explorer"
                        variant="caption"
                        sx={{ fontFamily: "inherit", letterSpacing: "0.04em", opacity: 0.7, color: "inherit", textDecoration: "none", "&:hover": { textDecoration: "underline", opacity: 1 } }}
                      >
                        {transaction.stealthAddress?.slice(0, 6)}…{transaction.stealthAddress?.slice(-4)}
                      </Typography>
                    )}
                    <Typography variant="body2" sx={{ fontFamily: "inherit", letterSpacing: "0.04em", fontWeight: 500, ml: "auto" }}>
                      {hideBalance ? <GlitchText length={4} /> : fmtAmount(transaction.amount)} {transaction.symbol ?? symbol}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          )}
        </div>
        {showPopup && popupMessage && <Popup popupMessage={popupMessage} />}
      </Stack>

      {/* Fixed bottom action bar (wallet-home). Renders only on the menu view
          since the sub-views return earlier. Sits at the bottom over the footer. */}
      <Box
        sx={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 1100,
          bgcolor: "background.default",
          borderTop: "1px solid",
          borderColor: "divider",
          pb: "env(safe-area-inset-bottom)",
        }}
      >
        <Stack direction="row" sx={{ width: "100%", maxWidth: 460, mx: "auto" }}>
          {[
            { key: "send", label: "Send", icon: <ArrowUpwardIcon fontSize="small" />, onClick: handleSendEth, disabled: false },
            { key: "receive", label: "Receive", icon: <ArrowDownwardIcon fontSize="small" />, onClick: handleReceive, disabled: false },
            { key: "soon", label: "soon", icon: <AddIcon fontSize="small" />, onClick: undefined, disabled: true },
          ].map((slot) => (
            <Button
              key={slot.key}
              onClick={slot.onClick}
              disabled={slot.disabled}
              sx={{
                flex: 1,
                minWidth: 0,
                flexDirection: "column",
                gap: 0.25,
                py: 1.25,
                borderRadius: 0,
                color: "text.primary",
              }}
            >
              {slot.icon}
              <Typography sx={{ fontSize: "0.6rem", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {slot.label}
              </Typography>
            </Button>
          ))}
        </Stack>
      </Box>
    </Box>
  );
};
