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
import { migrateLocalStorageToV1 } from "@/lib/localstorage-migrate"; // TEMP: remove in a future iteration
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
  const [external, setExternal] = useState(false);
  // New wallets are private by default
  const [privacy, setPrivacy] = useState(true);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const handleInfoClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  useEffect(() => {
    if (hasAutoLoaded.current) return;
    hasAutoLoaded.current = true;
    migrateLocalStorageToV1(); // TEMP one-shot: pre-namespace keys → r1do/wallet/v1
    (async () => {
      // Wallet list = local metadata FIRST (so wallets[0] is THIS device's
      // primary wallet — "the first in the localStorage array"), then any
      // suite-wide credential from the shared store (R1DOToolsDB) not already
      // present. The Welcome-back card always unlocks wallets[0], even if more
      // exist; the rest are reachable via "use a different wallet".
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
              <option value="local">On your device</option>
              <option value="external">External Provider</option>
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
        </Box>

        <Button
          onClick={async () => {
            if (!username.trim()) return;
            const user = username;
            const ext = external;
            const priv = privacy;
            setUsername("");
            setExternal(false);
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

          <Typography
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
          </Typography>
        </Stack>
      )}
    </div>
    )}
    {/* Network selector — login-screen scaffolding for multichain (gear is fixed-position) */}
    <Settings networkOnly />
    </>
  );
}
