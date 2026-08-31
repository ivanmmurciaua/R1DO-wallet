"use client";

/* RpcManager — per-network RPC fleet editor (Settings).

   Shows the effective RPC list for the ACTIVE network: the vetted curated nodes
   (each toggleable on/off) plus the user's own custom nodes (removable). Adding a
   node runs the in-browser bench (rpcManager.benchRpc) — the same battery as
   scripts/rpc-bench.sh plus CORS — and only accepts it if it passes, tagging it
   with the roles it earned (logs / scan). Edits persist to localStorage and take
   effect on RELOAD, exactly like the network switch. */

import { useEffect, useState } from "react";
import {
  activeRpcRoster,
  activeNetworkId,
  networkName,
  writePendingRpcOrigin,
  commitRpcHostsCookie,
  type RpcEntry,
} from "@/lib/networks";
import { RPC_HOSTS_COOKIE, CSP_CONNECT_BASE } from "@/lib/csp";
import {
  benchRpc,
  saveBenchedRpc,
  removeCustomRpc,
  setCuratedDisabled,
  type BenchCheck,
  type BenchResult,
} from "@/lib/rpcManager";

const mono = "var(--font-geist-mono), monospace";

// sessionStorage key: a URL to auto-bench right after an authorize-and-reload.
const PENDING_TEST_KEY = "r1do-rpc-pending-test";

const originOf = (url: string): string | null => {
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
};

// Origins the CURRENT page's CSP already allows: the curated base (always in the
// policy) + the user's authorized origins (from the cookie at load). A host must
// be here before the bench can reach it — otherwise we authorize + reload first.
// Curated nodes are always here, so testing them never needs a reload.
function baseOrigins(): string[] {
  return CSP_CONNECT_BASE.map((u) => {
    try {
      return new URL(u).origin;
    } catch {
      return "";
    }
  }).filter(Boolean);
}
function authorizedOrigins(): Set<string> {
  const set = new Set<string>(baseOrigins());
  try {
    const row = document.cookie.split("; ").find((c) => c.startsWith(RPC_HOSTS_COOKIE + "="));
    if (row) {
      const val = decodeURIComponent(row.slice(RPC_HOSTS_COOKIE.length + 1));
      for (const o of val.split(/[\s,]+/).filter(Boolean)) set.add(o);
    }
  } catch {
    /* ignore */
  }
  return set;
}

function Pill({ children, dim }: { children: React.ReactNode; dim?: boolean }) {
  return (
    <span
      style={{
        border: "1px solid currentColor",
        borderRadius: "2px",
        padding: "0 5px",
        fontSize: "0.6rem",
        letterSpacing: "0.06em",
        opacity: dim ? 0.45 : 0.8,
        textTransform: "uppercase",
      }}
    >
      {children}
    </span>
  );
}

function roleBadges(e: RpcEntry) {
  const roles = e.roles.length ? e.roles : (["general"] as const);
  return (
    <span style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}>
      {roles.map((r) => (
        <Pill key={r} dim={e.disabled}>
          {r}
          {r === "logs" && e.window ? ` ${e.window >= 1_000_000 ? e.window / 1_000_000 + "M" : Math.round(e.window / 1000) + "k"}` : ""}
        </Pill>
      ))}
    </span>
  );
}

const btn = (extra?: React.CSSProperties): React.CSSProperties => ({
  background: "transparent",
  border: "1px solid currentColor",
  color: "inherit",
  fontFamily: mono,
  fontSize: "0.7rem",
  letterSpacing: "0.06em",
  padding: "4px 9px",
  cursor: "pointer",
  ...extra,
});

export default function RpcManager() {
  const id = activeNetworkId();
  const [roster, setRoster] = useState<RpcEntry[]>(() => activeRpcRoster());
  const [dirty, setDirty] = useState(false);
  const refresh = () => {
    setRoster(activeRpcRoster());
    setDirty(true);
  };

  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [checks, setChecks] = useState<BenchCheck[]>([]);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const runTest = async (target?: string) => {
    const u = (target ?? url).trim();
    if (!/^https:\/\/\S+$/.test(u)) {
      setErr("Enter a full https:// URL.");
      return;
    }
    const origin = originOf(u);
    if (!origin) {
      setErr("Invalid URL.");
      return;
    }
    setErr(null);
    // The bench can only reach a host whose origin the CURRENT page's CSP allows.
    // If it isn't authorized yet, authorize it (→ cookie) + reload, then auto-run
    // the bench after the reload. One click; the reload is the only friction.
    if (!authorizedOrigins().has(origin)) {
      writePendingRpcOrigin(origin);
      try {
        sessionStorage.setItem(PENDING_TEST_KEY, u);
        sessionStorage.setItem("r1do-reopen-settings", "1"); // reopen the panel after reload
      } catch {
        /* ignore */
      }
      commitRpcHostsCookie(); // put the origin into the cookie so the reloaded CSP allows it
      window.location.reload();
      return;
    }
    setResult(null);
    setChecks([]);
    setTesting(true);
    try {
      const r = await benchRpc(u, (c) => setChecks((prev) => [...prev, c]));
      setResult(r);
    } catch (e) {
      setErr("Bench failed: " + ((e as Error)?.message ?? String(e)));
    } finally {
      setTesting(false);
    }
  };

  // After an authorize-and-reload, resume the bench automatically on the host that
  // is now CSP-allowed.
  useEffect(() => {
    let pending: string | null = null;
    try {
      pending = sessionStorage.getItem(PENDING_TEST_KEY);
      sessionStorage.removeItem(PENDING_TEST_KEY);
    } catch {
      /* ignore */
    }
    if (pending) {
      setUrl(pending);
      void runTest(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = () => {
    if (!result?.accepted) return;
    saveBenchedRpc(id, result);
    writePendingRpcOrigin(""); // it lives in the override now; drop the pending slot
    setUrl("");
    setResult(null);
    setChecks([]);
    refresh();
  };

  const toggleCurated = (e: RpcEntry) => {
    setCuratedDisabled(id, e.url, !e.disabled);
    refresh();
  };
  const remove = (e: RpcEntry) => {
    removeCustomRpc(id, e.url);
    refresh();
  };

  return (
    <div>
      <p style={{ fontSize: "0.8rem", marginBottom: "10px" }}>RPCs — {networkName()}</p>

      {/* current fleet */}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginBottom: "14px" }}>
        {roster.map((e) => (
          <div
            key={e.url}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              opacity: e.disabled ? 0.45 : 1,
            }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: "0.72rem",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  textDecoration: e.disabled ? "line-through" : "none",
                }}
                title={e.url}
              >
                {e.url.replace(/^https:\/\//, "")}
              </div>
              <div style={{ marginTop: "3px", display: "flex", gap: "6px", alignItems: "center" }}>
                {roleBadges(e)}
                {!e.curated && <Pill dim>custom</Pill>}
              </div>
            </div>
            <div style={{ display: "flex", gap: "5px", flexShrink: 0 }}>
              <button
                onClick={() => {
                  setUrl(e.url);
                  void runTest(e.url);
                }}
                disabled={testing}
                style={btn({ opacity: testing ? 0.5 : 0.8 })}
                title="Bench this RPC from the browser"
              >
                [test]
              </button>
              {e.curated ? (
                <button onClick={() => toggleCurated(e)} style={btn()}>
                  {e.disabled ? "[ON]" : "[OFF]"}
                </button>
              ) : (
                <button onClick={() => remove(e)} style={btn({ opacity: 0.7 })}>
                  [×]
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* add + bench */}
      <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-rpc…"
          disabled={testing}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: "1px solid currentColor",
            borderRadius: "2px",
            color: "inherit",
            fontFamily: mono,
            fontSize: "0.72rem",
            padding: "6px 8px",
            outline: "none",
          }}
        />
        <button onClick={() => runTest()} disabled={testing} style={btn({ flexShrink: 0, opacity: testing ? 0.5 : 1 })}>
          {testing ? "[TESTING…]" : "[TEST]"}
        </button>
      </div>

      {err && <p style={{ fontSize: "0.68rem", color: "#e06", marginBottom: "6px" }}>{err}</p>}

      {(checks.length > 0 || result) && (
        <div style={{ border: "1px solid currentColor", borderRadius: "2px", padding: "8px", marginBottom: "8px" }}>
          <div style={{ fontFamily: mono, fontSize: "0.64rem", opacity: 0.7, marginBottom: "6px", wordBreak: "break-all" }}>
            {(result?.url ?? url).replace(/^https:\/\//, "")}
          </div>
          {checks.map((c) => (
            <div key={c.name} style={{ display: "flex", gap: "6px", fontSize: "0.66rem", fontFamily: mono, lineHeight: 1.6 }}>
              <span style={{ width: "12px", flexShrink: 0 }}>{c.ok ? "✓" : "✗"}</span>
              <span style={{ width: "108px", flexShrink: 0, opacity: 0.75 }}>{c.name}</span>
              <span style={{ opacity: 0.6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.detail}</span>
            </div>
          ))}
          {result && (
            <div style={{ marginTop: "8px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <span style={{ fontSize: "0.68rem", opacity: 0.85 }}>{result.summary}</span>
              {result.accepted && !roster.some((e) => e.url === result.url) && (
                <button onClick={add} style={btn({ flexShrink: 0 })}>
                  [ADD]
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {dirty && (
        <button
          onClick={() => {
            commitRpcHostsCookie(); // authorize the new custom origins in the next page's CSP
            window.location.reload();
          }}
          style={btn({ width: "100%", marginTop: "2px" })}
        >
          [RELOAD TO APPLY]
        </button>
      )}
    </div>
  );
}
