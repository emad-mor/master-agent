import { NextRequest, NextResponse } from "next/server";
import { readProjectFile } from "@/lib/workspace";

/* The content of a single project file, for preview.
 *   GET /api/files/content?project=SLUG&path=REL/PATH
 *     → { path, content, size, truncated, binary, tooLarge }
 *     → 400 { error } if the path is missing / escapes the project / not found */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("project");
  const path = url.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "Missing path" }, { status: 400 });

  const result = await readProjectFile(slug, path);
  if ("error" in result) return NextResponse.json(result, { status: 400 });
  return NextResponse.json(result);
}
