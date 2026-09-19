import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, hashPassword } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { getDb } from "@/lib/mongodb";
import { ROLES, type Role } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const user = await getCurrentUser();
  return user?.role === "ADMIN" ? user : null;
}

export async function GET() {
  if (!(await requireAdmin())) return errorResponse("Accès administrateur requis.", 403);
  const db = await getDb();
  const users = await db.collection("users").find({}, { projection: { passwordHash: 0 } }).sort({ displayName: 1 }).toArray();
  return NextResponse.json({ users: users.map((user) => ({ id: user._id.toString(), email: user.email, displayName: user.displayName, role: user.role, entity: user.entity, active: user.active })) });
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return errorResponse("Accès administrateur requis.", 403);
  const body = await request.json().catch(() => null) as { email?: string; password?: string; displayName?: string; role?: Role; entity?: string } | null;
  const email = body?.email?.trim().toLowerCase() || "";
  const password = body?.password || "";
  const displayName = body?.displayName?.trim() || "";
  const role = body?.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errorResponse("Adresse e-mail invalide.");
  if (password.length < 10) return errorResponse("Le mot de passe doit contenir au moins 10 caractères.");
  if (!displayName) return errorResponse("Le nom d'affichage est requis.");
  if (!role || !ROLES.includes(role)) return errorResponse("Rôle invalide.");
  const db = await getDb();
  try {
    const result = await db.collection("users").insertOne({ email, passwordHash: await hashPassword(password), displayName, role, entity: body?.entity?.trim() || "Groupe", active: true, createdAt: new Date(), createdBy: admin._id });
    await db.collection("auditLogs").insertOne({ eventType: "user_created", userId: admin._id, targetUserId: result.insertedId, details: { email, role }, at: new Date() });
    return NextResponse.json({ id: result.insertedId.toString(), email, displayName, role }, { status: 201 });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return errorResponse("Un compte utilise déjà cette adresse e-mail.", 409);
    throw error;
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return errorResponse("Accès administrateur requis.", 403);
  const body = await request.json().catch(() => null) as { id?: string; displayName?: string; role?: Role; entity?: string; active?: boolean; password?: string } | null;
  if (!body?.id || !ObjectId.isValid(body.id)) return errorResponse("Identifiant utilisateur invalide.");
  const updates: Record<string, unknown> = { updatedAt: new Date(), updatedBy: admin._id };
  if (body.displayName !== undefined) updates.displayName = body.displayName.trim();
  if (body.entity !== undefined) updates.entity = body.entity.trim();
  if (body.active !== undefined) updates.active = Boolean(body.active);
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) return errorResponse("Rôle invalide.");
    updates.role = body.role;
  }
  if (body.password !== undefined) {
    if (body.password.length < 10) return errorResponse("Le mot de passe doit contenir au moins 10 caractères.");
    updates.passwordHash = await hashPassword(body.password);
  }
  const db = await getDb();
  const targetId = new ObjectId(body.id);
  const result = await db.collection("users").updateOne({ _id: targetId }, { $set: updates });
  if (!result.matchedCount) return errorResponse("Utilisateur introuvable.", 404);
  await db.collection("auditLogs").insertOne({ eventType: "user_updated", userId: admin._id, targetUserId: targetId, details: { fields: Object.keys(updates) }, at: new Date() });
  return NextResponse.json({ ok: true });
}
