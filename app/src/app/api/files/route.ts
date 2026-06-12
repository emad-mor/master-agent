import { NextRequest, NextResponse } from "next/server";
import { fileTree } from "@/lib/workspace";

/* The file structure of a project (or the whole workspace).
 *   GET /api/files?project=SLUG  → { root, tree, truncated } */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const slug = new URL(req.url).searchParams.get("project");
  const result = await fileTree(slug);
  return NextResponse.json(result);
}
