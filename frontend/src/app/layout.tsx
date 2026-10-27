import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { Shell } from "@/components/Shell";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", weight: ["400", "500", "600", "700"] });
const jetbrains = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "BundoPay",
  description: "Know what you can spend. Bundo fills your tax, dispute and ad jars and handles PayPal disputes, within limits you set.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <head>
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block"
        />
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
