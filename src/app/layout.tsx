import type { Metadata } from "next";
import { Geist, Geist_Mono, Shippori_Mincho } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import { ThemeRegistry } from "@/components/ThemeRegistry";
// Beta banner scaffolding ready but hidden — uncomment import + usage below.
// import { BetaBanner } from "@/components/BetaBanner";
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
  return (
    <html lang="en">
      <head>
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
        {/* Beta disclaimer banner — scaffolding ready (BetaBanner + the .onLogin
            class in page.module.css) but HIDDEN for now. Uncomment to enable. */}
        {/* <BetaBanner /> */}
        <ThemeRegistry>{children}</ThemeRegistry>
        {/* Vercel Web Analytics — privacy-friendly (no cookies, no PII), served
            same-origin from /_vercel/insights. */}
        <Analytics />
      </body>
    </html>
  );
}
