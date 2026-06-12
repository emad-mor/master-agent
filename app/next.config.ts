import type { NextConfig } from "next";

/* Aria is a local-only tool. Route handlers spawn the `claude` CLI and the
 * local voice binaries, and read/write project folders in ../workspace.
 * Nothing here is meant to be deployed to a multi-tenant host. */
const config: NextConfig = {
  eslint: { ignoreDuringBuilds: false },
};

export default config;
