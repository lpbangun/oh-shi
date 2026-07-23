import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const protocol = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "OH SHI - Startup Hiring Intelligence";
  const description = "A public, agent-readable source of truth for startup companies, hiring signals, and verified open jobs.";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: { icon: "/og.png", shortcut: "/og.png" },
    openGraph: { title, description, type: "website", url: origin, images: [{ url: `${origin}/og.png`, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <header className="site-header">
          <Link href="/" className="brand" aria-label="OH SHI home">
            <span className="brand-mark">OH SHI!</span>
            <span className="brand-expansion">Startup Hiring Intelligence</span>
          </Link>
          <nav className="header-nav" aria-label="Primary navigation">
            <Link href="/#jobs">Jobs</Link>
            <Link href="/#companies">Companies</Link>
            <Link href="/#changes">Changes</Link>
            <Link href="/api/v1/jobs" className="agent-link">For agents</Link>
          </nav>
        </header>
        {children}
        <footer className="site-footer">
          <div>
            <span className="brand-mark brand-mark-small">OH SHI!</span>
            <p>Startup hiring facts for humans and agents.</p>
          </div>
          <div className="footer-links">
            <Link href="/api/v1/companies">Companies JSON</Link>
            <Link href="/api/v1/jobs">Jobs JSON</Link>
            <Link href="/api/v1/changes">Changes feed</Link>
            <Link href="/llms.txt">llms.txt</Link>
          </div>
          <p className="legal-note">MIT software / CC BY 4.0 project-owned data / Third-party rights remain with their owners.</p>
        </footer>
      </body>
    </html>
  );
}
