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
import DeleteIcon from "@mui/icons-material/Delete";
import { useEffect, useRef, useState } from "react";
import { getAllWallets, removeLocalData } from "@/lib/localstorage";
import { LocalStorageData } from "@/types";

type props = {
  createOrLoad: (username: string, external: boolean, privacy?: boolean) => object;
  isRestoring?: boolean;
};

export default function LoginWithPasskey({ createOrLoad, isRestoring = false }: props) {
  const hasAutoLoaded = useRef(false);
  const [wallets, setWallets] = useState<LocalStorageData[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [external, setExternal] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const handleInfoClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  useEffect(() => {
    if (hasAutoLoaded.current) return;
    const wallets = getAllWallets();
    if (wallets.length > 0) {
      setWallets(wallets);
      hasAutoLoaded.current = true;
      // Autoload the wallet
      // if (wallets.length === 1) {
      //   createOrLoad(wallets[0].username.toLowerCase(), false);
      // }
    }
    setLoading(false);
  }, [setLoading]);

  const handlePopoverClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);

  return wallets.length === 0 && !loading && !isRestoring ? (
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
            setPrivacy(false);
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
      <Stack>
        {/*loading || wallets.length < 2 ? (*/}
        {loading || isRestoring ? (
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
          <Stack>
            <Typography
              textAlign={"center"}
              marginBottom={3}
              marginTop={8}
              variant="h4"
            >
              Select a wallet
            </Typography>
            <Box
              sx={{
                borderRadius: 2,
                p: 2,
                maxWidth: "100%",
              }}
            >
              {wallets.map((wallet: LocalStorageData, index: number) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    marginBottom: "7px",
                    gap: "8px",
                  }}
                >
                  <div
                    style={{
                      border: "1px solid",
                      borderColor: "divider",
                      flex: 1,
                    }}
                  >
                    <Typography
                      variant="body1"
                      sx={{
                        p: 1,
                        textAlign: "center",
                        cursor: "pointer",
                        "&:hover": { backgroundColor: "action.hover" },
                        borderRadius: 1,
                        "&:not(:last-child)": { mb: 1 },
                      }}
                      onClick={() =>
                        createOrLoad(wallet.username.toLowerCase(), false)
                      }
                    >
                      {wallet.username.toUpperCase()}
                    </Typography>
                  </div>
                  <IconButton
                    size="small"
                    sx={{
                      color: "error.main",
                      "&:hover": { color: "error.dark" },
                      minWidth: "40px",
                      height: "40px",
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      removeLocalData(wallet.username.toLowerCase());
                      const updatedWallets = wallets.filter(
                        (_, i) => i !== index,
                      );
                      setWallets(updatedWallets);
                    }}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </div>
              ))}
            </Box>
            <Typography textAlign={"center"} marginBottom={1} marginTop={8}>
              Or
            </Typography>
            <Button variant="contained" onClick={() => setWallets([])}>
              Create / Load new wallet
            </Button>
          </Stack>
        )}
      </Stack>
    </div>
  );
}
