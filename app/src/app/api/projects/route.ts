import { NextResponse } from "next/server";
import { listProjects, WORKSPACE_DIR, WORKSPACE_KEY } from "@/lib/workspace";

/* GET /api/projects → the folders Aria can work in.
 * Each is a top-level directory in the workspace (../workspace by default, or
 * $WORKSPACE_DIR). The widget's project picker uses this. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const projects = await listProjects();
  return NextResponse.json({ workspaceDir: WORKSPACE_DIR, workspaceKey: WORKSPACE_KEY, projects });
}
