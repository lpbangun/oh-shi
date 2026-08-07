import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import { headers } from "next/headers";
import Link from "next/link";
import "./globals.css";
import { ThemeToggle } from "./components/ThemeToggle";

const archivo = Archivo({ variable: "--font-archivo", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin"], weight: ["400", "500", "600"] });

/** Applied before first paint so the chosen theme never flashes. */
const themeBootstrap = `(function(){try{var t=localStorage.getItem('ohshi-theme');if(!t)t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const protocol = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "OH SHI - Startup Hiring Intelligence";
  const description = "Operational Headquarters for Startup Hiring Intelligence. Verified startup jobs, directional hiring momentum, and evidence confidence from canonical career sources refreshed every two hours.";
  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: {
      icon: [{ url: "/favicon.png", type: "image/png", sizes: "512x512" }],
      shortcut: "/favicon.png",
      apple: [{ url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" }],
    },
    openGraph: { title, description, type: "website", url: origin, images: [{ url: `${origin}/og.png`, width: 1200, height: 630 }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

function BrandExpansion({ className }: { className: string }) {
  return (
    <p className={className}>
      <b>O</b>perational <b>H</b>eadquarters for <b>S</b>tartup <b>H</b>iring <b>I</b>ntelligence
    </p>
  );
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className={`${archivo.variable} ${plexMono.variable}`}>
        <header className="site-header">
          <div className="wrap">
            <Link href="/" className="brand-mark" aria-label="OH SHI home">OH SHI<em>!</em></Link>
            <BrandExpansion className="brand-expansion" />
            <nav className="header-nav" aria-label="Primary navigation">
              <Link href="/about" className="nav-link">About</Link>
              <ThemeToggle />
            </nav>
          </div>
        </header>

        {children}

        <footer className="site-footer">
          <div className="wrap footer-top">
            <div>
              <span className="brand-mark">OH SHI<em>!</em></span>
              <BrandExpansion className="footer-expansion" />
              <p className="brand-blurb">
                Startup hiring facts for humans and agents. We store concise factual fields and link you to the canonical source.
              </p>
            </div>
            <div className="footer-links">
              <Link href="/api/v1/companies">companies.json</Link>
              <Link href="/api/v1/jobs">jobs.json</Link>
              <Link href="/api/v1/changes">changes</Link>
              <Link href="/exports/jobs.jsonl">jobs.jsonl</Link>
              <Link href="/exports/daily-changes.json">daily-changes export</Link>
              <Link href="/llms.txt">llms.txt</Link>
            </div>
          </div>
          <div className="legal-note">
            <div className="wrap">
              <p>
                Software licensed <b>MIT</b><i>/</i>Project-owned data <b>CC BY 4.0</b><i>/</i>
                Company names and logos are trademarks of their respective owners
                <span className="long">, shown here to identify the employer whose posting we link to</span>
                <span className="long"><i>/</i>Third-party job descriptions and source content remain with their owners</span>
                <span className="long"><i>/</i>Nothing on this page is an endorsement by, or affiliation with, the companies named</span>
                <i>/</i>Hiring signal is a directional momentum score, not a probability; evidence confidence measures verification quality.
              </p>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
