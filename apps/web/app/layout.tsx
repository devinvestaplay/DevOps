import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Investaplay DevOps",
  description: "Multi-project DevOps management platform",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
