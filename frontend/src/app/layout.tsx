import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "RemitMortgage — Remittance-Backed Property Financing on Stellar",
  description:
    "Turn your verified remittance history into a pathway to homeownership. Save, borrow, and build — all settled in USDC on the Stellar network.",
  keywords: [
    "remittance",
    "mortgage",
    "Stellar",
    "Soroban",
    "USDC",
    "DeFi",
    "property financing",
    "diaspora",
  ],
};

import { WalletProvider } from "../context/WalletContext";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} dark`}>
      <body className="min-h-screen bg-[var(--bg-primary)] text-[var(--text-primary)] font-[var(--font-inter)] antialiased">
        <WalletProvider>
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}
