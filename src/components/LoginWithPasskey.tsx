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
import { getAllWallets } from "@/lib/localstorage";
import { LocalStorageData } from "@/types";

type props = {
  createOrLoad: (username: string, external: boolean) => object;
};

export default function LoginWithPasskey({ createOrLoad }: props) {
  const hasAutoLoaded = useRef(false);
  const [wallets, setWallets] = useState<LocalStorageData[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState("");
  const [external, setExternal] = useState(false);
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

  return wallets.length === 0 && !loading ? (
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
          SafeKey Wallet
        </Typography>

        <input
          onChange={(e) => setUsername(e.target.value)}
          value={username}
          required
          placeholder="Type your username"
          style={{
            fontSize: "1.2em",
            borderRadius: "4px",
            border: "1px solid #555",
            width: "100%",
            padding: "7px",
          }}
        ></input>

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
                padding: "7px",
                border: "1px solid #555",
                borderRadius: "4px",
                fontSize: "16px",
                cursor: "pointer",
              }}
            >
              <option value="local">On your device</option>
              <option value="external">External Provider</option>
            </select>
          </FormControl>
        </Box>

        <Button
          onClick={async () => {
            if (!username.trim()) return;
            const user = username;
            const ext = external;
            setUsername("");
            setExternal(false);
            createOrLoad(user.toLowerCase(), ext);
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
                    border: "1px solid",
                    borderColor: "divider",
                    marginBottom: "7px",
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
