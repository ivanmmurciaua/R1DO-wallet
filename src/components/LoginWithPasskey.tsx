import {
  Input,
  Button,
  Stack,
  Typography,
  FormControl,
  Select,
  MenuItem,
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

        <Input
          onChange={(e) => setUsername(e.target.value)}
          value={username}
          required
          placeholder="username"
          sx={{
            backgroundColor: (theme) =>
              theme.palette.mode === "dark" ? "#222" : "#fff",
            color: (theme) => (theme.palette.mode === "dark" ? "#fff" : "#222"),
            borderRadius: "4px",
            input: {
              backgroundColor: (theme) =>
                theme.palette.mode === "dark" ? "#222" : "#fff",
              color: (theme) =>
                theme.palette.mode === "dark" ? "#fff" : "#222",
            },
          }}
        />

        <Box
          sx={{
            backgroundColor: (theme) =>
              theme.palette.mode === "dark" ? "#222" : "#fff",
          }}
        >
          <Box display="flex" alignItems="center" mb={-0.3}>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                color: (theme) =>
                  theme.palette.mode === "dark" ? "#fff" : "#222",
              }}
            >
              Storage Type
            </Typography>
            <IconButton
              size="medium"
              onClick={handleInfoClick}
              sx={{ ml: 1 }}
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
                    theme.palette.mode === "dark" ? "#222" : "#fff",
                  color: (theme) =>
                    theme.palette.mode === "dark" ? "#fff" : "#222",
                }}
              >
                If you create and store your passkey on your device, you can use
                it <b>but not manage it</b>. To manage your passkey (view,
                revoke, or sync it across devices), create it with an external
                provider such as Google or Apple.
              </Box>
            </Popover>
          </Box>

          <FormControl
            fullWidth
            sx={{
              backgroundColor: (theme) =>
                theme.palette.mode === "dark" ? "#222" : "#fff",
              color: (theme) =>
                theme.palette.mode === "dark" ? "#fff" : "#222",
              borderRadius: "4px",
            }}
          >
            <Select
              value={external ? "external" : "local"}
              onChange={(e) => setExternal(e.target.value === "external")}
              sx={{
                backgroundColor: (theme) =>
                  theme.palette.mode === "dark" ? "#222" : "#fff",
                color: (theme) =>
                  theme.palette.mode === "dark" ? "#fff" : "#222",
                borderRadius: "4px",
              }}
            >
              <MenuItem value="local">On your device</MenuItem>
              <MenuItem value="external">External Provider</MenuItem>
            </Select>
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
