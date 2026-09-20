import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, hashPassword } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-errors";
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
  try {
    const admin = await requireAdmin();
    if (!admin) return errorResponse("Accès administrateur requis.", 403);
    const db = await getDb();
    const now = new Date();
    const [users, sessions] = await Promise.all([
      db.collection("users").find({}, { projection: { passwordHash: 0 } }).sort({ displayName: 1 }).toArray(),
      db.collection("sessions").aggregate<{ _id: ObjectId; count: number }>([
        { $match: { expiresAt: { $gt: now } } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
      ]).toArray(),
    ]);
    const sessionCounts = new Map(sessions.map((row) => [row._id.toString(), row.count]));
    return NextResponse.json({
      currentUserId: admin._id.toString(),
      roles: ROLES,
      users: users.map((user) => ({
        id: user._id.toString(), email: user.email, displayName: user.displayName, role: user.role,
        entity: user.entity, active: user.active, createdAt: user.createdAt || null,
        updatedAt: user.updatedAt || null, lastLoginAt: user.lastLoginAt || null,
        activeSessions: sessionCounts.get(user._id.toString()) || 0,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, "admin/users:GET");
  }
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
  try {
    const db = await getDb();
    const now = new Date();
    const entity = body?.entity?.trim() || "Groupe";
    const result = await db.collection("users").insertOne({ email, passwordHash: await hashPassword(password), displayName, role, entity, active: true, createdAt: now, createdBy: admin._id });
    await db.collection("auditLogs").insertOne({ eventType: "user_created", userId: admin._id, targetUserId: result.insertedId, details: { email, displayName, role, entity }, at: now });
    return NextResponse.json({ id: result.insertedId.toString(), email, displayName, role }, { status: 201 });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return errorResponse("Un compte utilise déjà cette adresse e-mail.", 409);
    return apiErrorResponse(error, "admin/users:POST");
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return errorResponse("Accès administrateur requis.", 403);
  const body = await request.json().catch(() => null) as { id?: string; displayName?: string; role?: Role; entity?: string; active?: boolean; password?: string; revokeSessions?: boolean } | null;
  if (!body?.id || !ObjectId.isValid(body.id)) return errorResponse("Identifiant utilisateur invalide.");
  const targetId = new ObjectId(body.id);
  const isSelf = targetId.equals(admin._id);
  if (isSelf && (body.active === false || (body.role !== undefined && body.role !== "ADMIN"))) {
    return errorResponse("Vous ne pouvez pas désactiver ou retirer votre propre rôle administrateur.", 409);
  }
  try {
    const db = await getDb();
    const users = db.collection("users");
    const target = await users.findOne({ _id: targetId });
    if (!target) return errorResponse("Utilisateur introuvable.", 404);
    const removesAdmin = target.role === "ADMIN" && (body.active === false || (body.role !== undefined && body.role !== "ADMIN"));
    if (removesAdmin) {
      const otherAdmins = await users.countDocuments({ _id: { $ne: targetId }, role: "ADMIN", active: true });
      if (!otherAdmins) return errorResponse("Le dernier administrateur actif ne peut pas être désactivé ou rétrogradé.", 409);
    }
    const updates: Record<string, unknown> = { updatedAt: new Date(), updatedBy: admin._id };
    const changed: string[] = [];
    if (body.displayName !== undefined) {
      const displayName = body.displayName.trim();
      if (!displayName) return errorResponse("Le nom d'affichage est requis.");
      updates.displayName = displayName; changed.push("displayName");
    }
    if (body.entity !== undefined) { updates.entity = body.entity.trim() || "Groupe"; changed.push("entity"); }
    if (body.active !== undefined) { updates.active = Boolean(body.active); changed.push("active"); }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return errorResponse("Rôle invalide.");
      updates.role = body.role; changed.push("role");
    }
    if (body.password !== undefined) {
      if (body.password.length < 10) return errorResponse("Le mot de passe doit contenir au moins 10 caractères.");
      updates.passwordHash = await hashPassword(body.password); changed.push("password");
    }
    if (changed.length) await users.updateOne({ _id: targetId }, { $set: updates });
    const revokeSessions = body.revokeSessions === true || body.active === false || body.password !== undefined;
    if (revokeSessions) await db.collection("sessions").deleteMany({ userId: targetId });
    await db.collection("auditLogs").insertOne({ eventType: revokeSessions && !changed.length ? "sessions_revoked" : "user_updated", userId: admin._id, targetUserId: targetId, details: { fields: changed, revokedSessions: revokeSessions, targetEmail: target.email }, at: new Date() });
    return NextResponse.json({ ok: true, revokedSessions: revokeSessions });
  } catch (error) {
    return apiErrorResponse(error, "admin/users:PATCH");
  }
}
