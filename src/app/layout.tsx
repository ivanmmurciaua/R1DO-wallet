import type { Metadata } from "next";
import { Geist, Geist_Mono, Shippori_Mincho } from "next/font/google";
import { ThemeRegistry } from "@/components/ThemeRegistry";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Mincho serif — seals the serene Japanese look of the PUBLIC world
// (headings/balance). The PRIVATE world uses Geist Mono (terminal/ninja).
const mincho = Shippori_Mincho({
  variable: "--font-mincho",
  subsets: ["latin"],
  weight: ["500", "700"],
});

export const metadata: Metadata = {
  title: "R1DO Wallet",
  description: "R1DO Wallet",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // El PWA (manifest + service worker + iconos) se desactiva en el build de
  // IPFS: un SW sobre un subdomain gateway cachearía contenido ya inmutable
  // por CID y podría servir versiones viejas. Se mantiene en el build normal.
  const pwaEnabled = process.env.NEXT_PUBLIC_IPFS_BUILD !== "1";

  return (
    <html lang="en">
      <head>
        {pwaEnabled && (
          <>
            {/* PWA manifest */}
            <link rel="manifest" href="/manifest.json" />

            {/* iOS support */}
            <link rel="apple-touch-icon" href="/icons/icon-192x192.png" />

            {/* PWA registration script */}
            <script
              dangerouslySetInnerHTML={{
                __html: `
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/sw.js');
                });
              }
            `,
              }}
            />
          </>
        )}

        {/* PWA theme color: adaptive for light and dark mode */}
        <meta
          name="theme-color"
          content="#ffffff"
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content="#1a1a1a"
          media="(prefers-color-scheme: dark)"
        />

        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="R1DO Wallet" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${mincho.variable}`}
      >
        <ThemeRegistry>{children}</ThemeRegistry>
      </body>
    </html>
  );
}
