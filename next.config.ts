import type { NextConfig } from "next";
import NodePolyfillPlugin from "node-polyfill-webpack-plugin";

// Build para IPFS: `IPFS_BUILD=1 next build` → genera ./out estático con rutas
// relativas (funciona servido desde la raíz de un CID en cualquier gateway).
// Sin la variable, el dev/build normal queda intacto.
const ipfs = process.env.IPFS_BUILD === "1";
const basePath = ipfs ? "/wallet" : "";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["effervescent-ana-unsystematically.ngrok-free.dev"],
  // Railgun SDK necesita polyfills de Node en el navegador (crypto/stream/
  // buffer…), igual que el spike con vite-plugin-node-polyfills. Solo en el
  // bundle de cliente; en server no hace falta. (Verificamos con build, no dev.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webpack: (config: any, { isServer }: { isServer: boolean }) => {
    if (!isServer) {
      config.plugins.push(new NodePolyfillPlugin());
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    return config;
  },
  // Expuesto al cliente para prefijar manualmente los assets de public/ que
  // Next NO prefija solo (badge, manifest…) y para desactivar el PWA en IPFS.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_IPFS_BUILD: ipfs ? "1" : "",
  },
  // Se sirve como subcarpeta /wallet/ dentro del CID de R1DO-tools, en un
  // subdomain gateway (<CID>.ipfs.dweb.link/wallet/). `basePath` empieza con "/"
  // → no rompe next/font (a diferencia de un assetPrefix relativo) y hace que
  // todas las rutas sean /wallet/_next/… → resuelven bajo la subcarpeta.
  ...(ipfs && {
    output: "export",
    images: { unoptimized: true },
    basePath,
    trailingSlash: true,
  }),
};

export default nextConfig;
