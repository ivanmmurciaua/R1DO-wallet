import {
  // Input,
  // Select,
  // MenuItem,
  Button,
  Stack,
  Typography,
  FormControl,
  Popover,
  IconButton,
  Box,
} from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useState } from "react";

type props = {
  createOrLoad: (username: string, external: boolean) => object;
};

export default function LoginWithPasskey({ createOrLoad }: props) {
  const [username, setUsername] = useState("");
  const [external, setExternal] = useState(false);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const handleInfoClick = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handlePopoverClose = () => {
    setAnchorEl(null);
  };

  const open = Boolean(anchorEl);

  return (
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
          placeholder="username"
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
            {/*<Select
              value={external ? "external" : "local"}
              onChange={(e) => setExternal(e.target.value === "external")}
              sx={{
                backgroundColor: (theme) =>
                  theme.palette.mode === "dark" ? "#222" : "#f5f5f5", // Fondo claro en light mode
                color: (theme) =>
                  theme.palette.mode === "dark" ? "#fff" : "#000", // Negro en light mode
                borderRadius: "4px",
                "& .MuiSelect-icon": {
                  color: (theme) =>
                    theme.palette.mode === "dark" ? "#fff" : "#000",
                },
              }}
              MenuProps={{
                PaperProps: {
                  sx: {
                    backgroundColor: (theme) =>
                      theme.palette.mode === "dark" ? "#333" : "#fff",
                    "& .MuiMenuItem-root": {
                      color: (theme) =>
                        theme.palette.mode === "dark" ? "#fff" : "#000",
                    },
                  },
                },
              }}
            >
              <MenuItem value="local">On your device</MenuItem>
              <MenuItem value="external">External Provider</MenuItem>
            </Select>*/}
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
          variant="outlined"
          sx={{
            marginTop: "10px",
            marginBottom: "24px",
            backgroundColor: (theme) =>
              theme.palette.mode === "dark" ? "#222" : "#fff",
            color: (theme) => (theme.palette.mode === "dark" ? "#fff" : "#222"),
            borderColor: (theme) =>
              theme.palette.mode === "dark" ? "#fff" : "#222",
            "&:hover": {
              backgroundColor: (theme) =>
                theme.palette.mode === "dark" ? "#333" : "#f0f0f0",
              borderColor: (theme) =>
                theme.palette.mode === "dark" ? "#fff" : "#222",
            },
          }}
          disabled={!username.trim()}
        >
          Login or Register
        </Button>
      </Stack>
    </div>
  );
}
