import type { Metadata } from "next";
import "./globals.css";
import { PersonaWidget } from "@/components/persona/persona-widget";

export const metadata: Metadata = {
  title: "Aria — local agent",
  description: "A local, voice-driven Claude Code agent with layered per-project memory.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        {/* DARK IS THE DEFAULT and is baked into the SSR markup above — so even
            if React recovers from a hydration error by client-re-rendering (which
            rewrites <html>'s attributes), the page stays dark. The pre-paint
            script below only handles the explicit LIGHT opt-out (key
            'aria.theme'; bumped from 'theme' so stale pre-dark-default values
            are ignored). OS preference is intentionally not consulted. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{if(localStorage.getItem('aria.theme')==='light')document.documentElement.classList.remove('dark');}catch(e){}})();`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="app-glow" aria-hidden />
        <div className="relative z-10">{children}</div>
        {/* Aria is available on every page (Ctrl/⌘+K). */}
        <PersonaWidget />
      </body>
    </html>
  );
}
