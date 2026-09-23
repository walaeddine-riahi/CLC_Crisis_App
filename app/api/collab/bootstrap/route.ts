import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, publicUser } from "@/lib/auth";
import { errorResponse, safeJsonSize } from "@/lib/http";
import { getDb } from "@/lib/mongodb";
import { scopeActionPayload } from "@/lib/action-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const workspaceCode = () => process.env.CLC_WORKSPACE_CODE || "DELICE-INONDATIONS";

async function ensureWorkspace() {
  const db = await getDb();
  const code = workspaceCode();
  await db.collection("workspaces").updateOne(
    { code },
    { $setOnInsert: { code, name: "PCA Inondations — Groupe Délice", isActive: true, createdAt: new Date() } },
    { upsert: true },
  );
  return db.collection("workspaces").findOne({ code, isActive: true });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return errorResponse("Authentification requise.", 401);
  const workspace = await ensureWorkspace();
  if (!workspace) return errorResponse("Workspace introuvable.", 404);
  const db = await getDb();
  const rows = await db.collection("sections").find({ workspaceId: workspace._id }).sort({ sectionKey: 1 }).toArray();
  return NextResponse.json({
    user: publicUser(user),
    workspace: { id: workspace._id.toString(), code: workspace.code, name: workspace.name },
    sections: rows.map((row) => ({ sectionKey: row.sectionKey, payload: scopeActionPayload(row.sectionKey, row.payload, user.role, user.roleDefinition.actionScope, user.entity, user.displayName, user.actionAccess), version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedBy?.toString() })),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return errorResponse("Authentification requise.", 401);
  if (user.role !== "ADMIN") return errorResponse("Seul un administrateur peut initialiser la situation.", 403);
  const body = await request.json().catch(() => null) as { initialState?: Record<string, unknown> } | null;
  if (!body?.initialState || typeof body.initialState !== "object" || !safeJsonSize(body.initialState)) return errorResponse("État initial invalide ou trop volumineux.");
  const workspace = await ensureWorkspace();
  if (!workspace) return errorResponse("Workspace introuvable.", 404);
  const db = await getDb();
  const sections = db.collection("sections");
  await sections.createIndex({ workspaceId: 1, sectionKey: 1 }, { unique: true });
  if (await sections.countDocuments({ workspaceId: workspace._id })) return errorResponse("La situation centrale est déjà initialisée.", 409);
  const now = new Date();
  const docs = Object.entries(body.initialState).map(([sectionKey, payload]) => ({ workspaceId: workspace._id, sectionKey, payload, version: 1, updatedAt: now, updatedBy: user._id }));
  if (docs.length) await sections.insertMany(docs, { ordered: false });
  await db.collection("auditLogs").insertOne({ workspaceId: workspace._id, userId: user._id, eventType: "workspace_bootstrap", details: { sections: docs.length }, at: now });
  return NextResponse.json({ ok: true, sections: docs.length }, { status: 201 });
}
