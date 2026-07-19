import {
  Button,
  Stack,
  Typography,
  FormControl,
  Popover,
  IconButton,
  Box,
  CircularProgress,
} from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useEffect, useRef, useState } from "react";
import { getWalletMetas } from "@/lib/localstorage";
import { listWalletCredentials } from "@/lib/credstore";
import { LOCAL_LAST_USER } from "@/app/constants";
import { WalletMeta } from "@/types";
import { Settings } from "@/components/Settings";

type props = {
  createOrLoad: (username: string, external: boolean, privacy?: boolean) => object;
};

export default function LoginWithPasskey({ createOrLoad }: props) {
  const hasAutoLoaded = useRef(false);
  const [wallets, setWallets] = useState<WalletMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [external, setExternal] = useState(true);
  // New wallets are PRIVATE by default; users can opt out to a public account.
  const [privacy, setPrivacy] = useState(true);
  const [privacyInfoAnchor, setPrivacyInfoAnchor] = useState<HTMLElement | null>(null);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const handleInfoClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  useEffect(() => {
    if (hasAutoLoaded.current) return;
    hasAutoLoaded.current = true;
    (async () => {
      // Wallet list = local metadata FIRST (so wallets[0] is THIS device's
      // primary wallet — "the first in the localStorage array"), then any
      // suite-wide credential from the shared store (R1DOToolsDB) not already
      // present. The Welcome-back card always unlocks the primary wallet
      // (LOCAL_LAST_USER, else wallets[0]); the rest are reachable via
      // "use a different wallet".
      const byName = new Map<string, WalletMeta>();
      for (const m of getWalletMetas()) {
        byName.set(m.username.toLowerCase(), m);
      }
      try {
        for (const c of await listWalletCredentials()) {
          const key = c.username.toLowerCase();
          if (!byName.has(key)) byName.set(key, { username: c.username });
        }
      } catch (e) {
        console.warn("[login] credential store unavailable:", e);
      }
      setWallets([...byName.values()]);
      setLoading(false);
    })();
  }, []);

  const handlePopoverClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);

  // Welcome-back target = the LAST wallet you logged in with (LOCAL_LAST_USER),
  // so a refresh offers the one you were actually using — not just whichever
  // happens to be first in the list. Falls back to wallets[0] if there's no
  // last-user record or it's no longer known on this device.
  const lastUser =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(LOCAL_LAST_USER)?.toLowerCase()
      : null;
  const primaryWallet =
    wallets.find((w) => w.username.toLowerCase() === lastUser) ?? wallets[0];

  return (
    <>
    {/* Beta notice — honest disclosure before any funds. Full detail (privacy scope,
        third-party dependencies) lives in the README, linked via the GitHub mark.
        Pinned near the top (the login form is vertically centered, so an in-flow
        banner would sit mid-screen next to the title). */}
    <Box sx={{ position: "fixed", top: 12, left: 0, right: 0, zIndex: 900, maxWidth: 480, mx: "auto", px: 2, pointerEvents: "none" }}>
      <Box
        sx={{
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1.5,
          border: "1px solid currentColor",
          borderRadius: "2px",
          px: 1.5,
          py: 0.85,
          opacity: 0.65,
          fontFamily: "var(--font-geist-mono), monospace",
          fontSize: "0.64rem",
          lineHeight: 1.5,
          letterSpacing: "0.02em",
        }}
      >
        <span>
          <b>BETA · not audited.</b> Experimental privacy wallet — use only small amounts you can afford to lose.
        </span>
        <a
          href="https://github.com/ivanmmurciaua/R1DO-wallet"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Source code on GitHub"
          title="Source & full disclosures on GitHub"
          style={{ color: "inherit", flexShrink: 0, display: "inline-flex", opacity: 0.9 }}
        >
          <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
      </Box>
    </Box>
    {wallets.length === 0 && !loading ? (
    <div>
      <Stack
        spacing={2}
        direction="column"
        sx={{ width: "100%", maxWidth: 480, mx: "auto", px: 2 }}
      >
        <Typography
          textAlign={"center"}
          marginBottom={8}
          marginTop={8}
          variant="h4"
        >
          R1DO Wallet
        </Typography>

        <input
          onChange={(e) => setUsername(e.target.value)}
          value={username}
          required
          placeholder="_ type your username"
          style={{
            fontSize: "1rem",
            fontFamily: "var(--font-geist-mono), monospace",
            borderRadius: "2px",
            border: "1px solid currentColor",
            background: "transparent",
            color: "inherit",
            width: "100%",
            padding: "12px 14px",
            outline: "none",
            boxSizing: "border-box",
            letterSpacing: "0.04em",
            opacity: 0.7,
            transition: "opacity 0.15s",
          }}
          onFocus={(e) => {
            e.target.style.borderColor = "currentColor";
            e.target.style.opacity = "1";
          }}
          onBlur={(e) => {
            e.target.style.borderColor = "currentColor";
            e.target.style.opacity = "0.7";
          }}
        />

        <Box>
          <Box display="flex" alignItems="center" mb={-0.3}>
            <Typography>Storage Type</Typography>
            <IconButton
              size="medium"
              onClick={handleInfoClick}
              sx={{
                ml: 1,
                color: (theme) =>
                  theme.palette.mode === "dark" ? "#fff" : "inherit",
              }}
              aria-label="More info"
            >
              <InfoOutlinedIcon fontSize="medium" />
            </IconButton>
            <Popover
              open={open}
              anchorEl={anchorEl}
              onClose={handlePopoverClose}
              anchorOrigin={{
                vertical: "bottom",
                horizontal: "left",
              }}
            >
              <Box
                p={2}
                maxWidth={250}
                sx={{
                  backgroundColor: (theme) =>
                    theme.palette.mode === "dark" ? "#222" : "#3B3B3B",
                  color: (theme) =>
                    theme.palette.mode === "dark" ? "#fff" : "#fff", // Blanco en ambos casos
                }}
              >
                If you create and store your passkey on your device, you can use
                it <b>but not manage it</b>. To manage your passkey (view,
                revoke, or sync it across devices), create it with an external
                provider such as Google or Apple.
              </Box>
            </Popover>
          </Box>

          <FormControl fullWidth>
            <select
              value={external ? "external" : "local"}
              onChange={(e) => setExternal(e.target.value === "external")}
              style={{
                width: "100%",
                padding: "12px 14px",
                border: "1px solid currentColor",
                borderRadius: "2px",
                fontSize: "1rem",
                fontFamily: "var(--font-geist-mono), monospace",
                cursor: "pointer",
                background: "transparent",
                color: "inherit",
                outline: "none",
                letterSpacing: "0.04em",
                opacity: 0.7,
              }}
            >
              <option value="external">External Provider</option>
              <option value="local">On your device</option>
            </select>
          </FormControl>
        </Box>

        <Box display="flex" alignItems="center" gap={1.5} sx={{ opacity: 0.75 }}>
          <input
            type="checkbox"
            id="privacy-toggle"
            checked={privacy}
            onChange={(e) => setPrivacy(e.target.checked)}
            style={{ width: 16, height: 16, cursor: "pointer", accentColor: "currentColor" }}
          />
          <label
            htmlFor="privacy-toggle"
            style={{
              fontFamily: "var(--font-geist-mono), monospace",
              fontSize: "0.9rem",
              cursor: "pointer",
              letterSpacing: "0.04em",
            }}
          >
            Enable privacy
          </label>
          <IconButton
            size="small"
            onClick={(e) => setPrivacyInfoAnchor(e.currentTarget)}
            sx={{ p: 0.25, color: (theme) => (theme.palette.mode === "dark" ? "#fff" : "inherit") }}
            aria-label="What is privacy mode?"
          >
            <InfoOutlinedIcon fontSize="small" />
          </IconButton>
          <Popover
            open={Boolean(privacyInfoAnchor)}
            anchorEl={privacyInfoAnchor}
            onClose={() => setPrivacyInfoAnchor(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
          >
            <Box
              p={2}
              maxWidth={260}
              sx={{
                fontSize: "0.7rem",
                lineHeight: 1.5,
                backgroundColor: (theme) => (theme.palette.mode === "dark" ? "#222" : "#3B3B3B"),
                color: "#fff",
              }}
            >
              Receive each payment at a fresh one-time <b>stealth address</b>, unlinkable to you,
              instead of a single reusable public address.
            </Box>
          </Popover>
        </Box>

        <Button
          onClick={async () => {
            if (!username.trim()) return;
            const user = username;
            const ext = external;
            const priv = privacy;
            setUsername("");
            setExternal(true);
            setPrivacy(true);
            createOrLoad(user.toLowerCase(), ext, priv);
          }}
          variant="contained"
          color="info"
          disabled={!username.trim()}
        >
          Login or Register
        </Button>
      </Stack>
    </div>
  ) : (
    <div>
      {loading ? (
        <div style={{ textAlign: "center" }}>
          <Typography
            marginBottom={1}
            marginTop={1}
            variant="h4"
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 2,
            }}
          >
            Loading wallets...
          </Typography>
          <CircularProgress size={50} sx={{ mb: 2, mt: 3 }} />
        </div>
      ) : (
        <Stack
          spacing={2}
          direction="column"
          sx={{ width: "100%", maxWidth: 480, mx: "auto", px: 2 }}
        >
          <Typography textAlign={"center"} marginTop={8} variant="h4">
            R1DO Wallet
          </Typography>
          <Typography
            textAlign={"center"}
            sx={{
              opacity: 0.6,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              fontSize: "0.72rem",
            }}
          >
            welcome back
          </Typography>

          {/* The device's primary wallet (wallets[0]). Unlocking is ONE
              deliberate passkey tap — no silent auto-restore. */}
          <Box
            sx={{
              border: "1px solid currentColor",
              borderRadius: "2px",
              p: "14px",
              mt: 1,
              textAlign: "center",
              fontFamily: "var(--font-geist-mono), monospace",
              letterSpacing: "0.08em",
              opacity: 0.85,
            }}
          >
            {primaryWallet.username.toUpperCase()}
          </Box>

          <Button
            onClick={() => createOrLoad(primaryWallet.username.toLowerCase(), false)}
            variant="contained"
            color="info"
          >
            Unlock
          </Button>

          {/* Hidden for the beta: creating/switching to another wallet from the
              unlock screen. Wallet management (incl. delete) lives in Settings.*/}
          {/*<Typography
            onClick={() => setWallets([])}
            sx={{
              cursor: "pointer",
              textAlign: "center",
              opacity: 0.55,
              fontFamily: "var(--font-geist-mono), monospace",
              fontSize: "0.78rem",
              letterSpacing: "0.04em",
              mt: 1,
              "&:hover": { opacity: 0.85 },
            }}
          >
            Use a different wallet
          </Typography>*/}

        </Stack>
      )}
    </div>
    )}
    {/* Network selector — login-screen scaffolding for multichain (gear is fixed-position) */}
    <Settings networkOnly />
    </>
  );
}
