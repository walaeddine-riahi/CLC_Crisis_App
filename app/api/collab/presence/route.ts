import { NextResponse } from "next/server";
import { getCurrentUser, publicUser } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function context() {
  const user = await getCurrentUser();
  if (!user) return null;
  const db = await getDb();
  const workspace = await db.collection("workspaces").findOne({ code: process.env.CLC_WORKSPACE_CODE || "DELICE-INONDATIONS", isActive: true });
  return workspace ? { user, db, workspace } : null;
}

export async function GET() {
  const ctx = await context();
  if (!ctx) return errorResponse("Authentification requise.", 401);
  const threshold = new Date(Date.now() - 45000);
  const rows = await ctx.db.collection("presence").find({ workspaceId: ctx.workspace._id, lastSeenAt: { $gt: threshold } }).sort({ displayName: 1 }).toArray();
  return NextResponse.json({ users: rows.map((row) => ({ id: row.userId.toString(), email: row.email, displayName: row.displayName, role: row.role, entity: row.entity, onlineAt: row.lastSeenAt })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST() {
  const ctx = await context();
  if (!ctx) return errorResponse("Authentification requise.", 401);
  const user = publicUser(ctx.user);
  await ctx.db.collection("presence").updateOne(
    { workspaceId: ctx.workspace._id, userId: ctx.user._id },
    { $set: { ...user, userId: ctx.user._id, workspaceId: ctx.workspace._id, lastSeenAt: new Date() } },
    { upsert: true },
  );
  return NextResponse.json({ ok: true });
}
