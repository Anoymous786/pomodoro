import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Toaster from "@/components/Toaster";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Pomodoro Focus & Productivity Dashboard",
  description:
    "A focus timer, task manager, and productivity dashboard built with Next.js.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.className} font-sans`}>
        {children}
        <Toaster />
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}