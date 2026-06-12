"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

/* Light/dark toggle. Persists to localStorage('aria.theme'); the pre-paint
 * script in layout.tsx reads it on load to avoid a flash of the wrong mode.
 * Default is DARK — only an explicit light choice here opts out. */
export function ThemeToggle() {
  const [dark, setDark] = useState(true);   // matches the pre-paint dark default

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("aria.theme", next ? "dark" : "light"); } catch {}
  };

  return (
    <button
      onClick={toggle}
      className="grid place-items-center w-9 h-9 rounded-lg border border-line text-mid hover:text-ink hover:border-mid/50 transition-colors"
      title={dark ? "Switch to light" : "Switch to dark"}
      aria-label="Toggle theme"
    >
      {dark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
