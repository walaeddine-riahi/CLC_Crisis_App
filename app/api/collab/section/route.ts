import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { errorResponse, safeJsonSize } from "@/lib/http";
import { getDb } from "@/lib/mongodb";
import { canWrite } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function currentWorkspace() {
  const db = await getDb();
  return db.collection("workspaces").findOne({ code: process.env.CLC_WORKSPACE_CODE || "DELICE-INONDATIONS", isActive: true });
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return errorResponse("Authentification requise.", 401);
  const workspace = await currentWorkspace();
  if (!workspace) return errorResponse("Workspace introuvable.", 404);
  const after = request.nextUrl.searchParams.get("after");
  const query: Record<string, unknown> = { workspaceId: workspace._id };
  if (after) {
    const date = new Date(after);
    if (!Number.isNaN(date.getTime())) query.updatedAt = { $gt: date };
  }
  const db = await getDb();
  const rows = await db.collection("sections").find(query).sort({ updatedAt: 1 }).toArray();
  return NextResponse.json({ serverTime: new Date().toISOString(), sections: rows.map((row) => ({ sectionKey: row.sectionKey, payload: row.payload, version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedBy?.toString() })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return errorResponse("Authentification requise.", 401);
  const body = await request.json().catch(() => null) as { sectionKey?: string; payload?: unknown; baseVersion?: number } | null;
  const sectionKey = body?.sectionKey?.trim() || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sectionKey)) return errorResponse("Clé de section invalide.");
  if (!canWrite(user.role, sectionKey)) return errorResponse(`Votre rôle ne permet pas de modifier « ${sectionKey} ».`, 403);
  if (!safeJsonSize(body?.payload)) return errorResponse("Section trop volumineuse.", 413);
  const workspace = await currentWorkspace();
  if (!workspace) return errorResponse("Workspace introuvable.", 404);
  const db = await getDb();
  const sections = db.collection("sections");
  const existing = await sections.findOne({ workspaceId: workspace._id, sectionKey });
  if (!existing) return errorResponse("Section centrale absente.", 404);
  if (Number(body?.baseVersion) !== Number(existing.version)) {
    return errorResponse("Conflit de version.", 409, { current: { sectionKey, payload: existing.payload, version: existing.version, updatedAt: existing.updatedAt } });
  }
  const now = new Date();
  const nextVersion = Number(existing.version) + 1;
  const result = await sections.findOneAndUpdate(
    { _id: existing._id, version: existing.version },
    { $set: { payload: body?.payload, version: nextVersion, updatedAt: now, updatedBy: user._id } },
    { returnDocument: "after" },
  );
  if (!result) return errorResponse("Conflit de version.", 409);
  await db.collection("auditLogs").insertOne({ workspaceId: workspace._id, userId: user._id, eventType: "section_update", sectionKey, details: { version: nextVersion, role: user.role, entity: user.entity }, at: now });
  return NextResponse.json({ sectionKey, payload: result.payload, version: result.version, updatedAt: result.updatedAt });
}
