import type { ReactNode } from "react";

export const metadata = {
  title: "Devin Outpost on Vercel",
  description: "Cloud-hosted Devin Outposts orchestration on Vercel",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          margin: "0 auto",
          maxWidth: 760,
          padding: "64px 24px",
          lineHeight: 1.5,
        }}
      >
        {children}
      </body>
    </html>
  );
}
