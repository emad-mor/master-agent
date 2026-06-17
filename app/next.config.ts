import type { NextConfig } from "next";

/* Aria is a local-only tool. Route handlers spawn the `claude` CLI and the
 * local voice binaries, and read/write project folders in ../workspace.
 * Nothing here is meant to be deployed to a multi-tenant host. */
const config: NextConfig = {
  // Pin the project root to THIS app dir. Without it, Turbopack walks up looking
  // for a lockfile and can pick a stray ~/package-lock.json as the workspace
  // root (some machines have one in $HOME) — which triggers a noisy warning and
  // can mis-scope file tracing.
  turbopack: { root: __dirname },
  eslint: { ignoreDuringBuilds: false },
};

export default config;
