// Root HTML shell: fonts, metadata, and full-viewport dark styling for the app.

import type { Metadata } from "next";
import type { ReactElement, ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CueMind — Live Meeting Copilot",
  description: "Real-time meeting transcription, suggestions, and follow-ups",
};

interface RootLayoutProps {
  readonly children: ReactNode;
}

export default function RootLayout({
  children,
}: Readonly<RootLayoutProps>): ReactElement {
  return (
    <html lang="en" className="h-full">
      <body
        className={`${geistSans.variable} ${geistMono.variable} h-full overflow-hidden bg-[#0a0a0a] font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
