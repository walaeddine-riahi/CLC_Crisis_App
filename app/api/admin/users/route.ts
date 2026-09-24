import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, hashPassword } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-errors";
import { errorResponse } from "@/lib/http";
import { getDb } from "@/lib/mongodb";
import { listRoleDefinitions, resolveRoleDefinition } from "@/lib/role-store";
import { actionEntityFor, actionReference, ACTION_ENTITIES } from "@/lib/action-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const user = await getCurrentUser();
  return user?.role === "ADMIN" ? user : null;
}

type ActionCatalogItem = { ref: string; entity: string; id: string; label: string; owner: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function loadActionCatalog(db: Awaited<ReturnType<typeof getDb>>): Promise<ActionCatalogItem[]> {
  const workspace = await db.collection("workspaces").findOne({ code: process.env.CLC_WORKSPACE_CODE || "DELICE-INONDATIONS", isActive: true });
  if (!workspace) return [];
  const sections = await db.collection("sections").find({ workspaceId: workspace._id, sectionKey: { $in: ["actions", "simpleChecklists"] } }).toArray();
  const catalog: ActionCatalogItem[] = [];
  const add = (entity: string, action: unknown) => {
    const item = record(action);
    const id = String(item?.id ?? "").trim();
    const ref = actionReference(entity, id);
    if (!item || !ref) return;
    catalog.push({ ref, entity, id, label: String(item.object || item.action || `Action ${id}`), owner: String(item.owner || "Non affecté") });
  };
  for (const section of sections) {
    if (section.sectionKey === "actions" && Array.isArray(section.payload)) section.payload.forEach((action) => add("CLC", action));
    if (section.sectionKey === "simpleChecklists") {
      const byEntity = record(section.payload);
      for (const entity of ACTION_ENTITIES) {
        if (entity !== "CLC" && Array.isArray(byEntity?.[entity])) (byEntity[entity] as unknown[]).forEach((action) => add(entity, action));
      }
    }
  }
  return catalog.sort((left, right) => left.entity.localeCompare(right.entity, "fr") || left.label.localeCompare(right.label, "fr"));
}

function validatedActionAccess(value: unknown, catalog: ActionCatalogItem[]) {
  if (!Array.isArray(value) || value.length > 250) return null;
  const allowed = new Set(catalog.map((item) => item.ref));
  const selected = [...new Set(value.filter((item): item is string => typeof item === "string"))];
  return selected.every((item) => allowed.has(item)) ? selected : null;
}

export async function GET() {
  try {
    const admin = await requireAdmin();
    if (!admin) return errorResponse("Accès administrateur requis.", 403);
    const db = await getDb();
    const now = new Date();
    const [users, sessions, actionCatalog, roles] = await Promise.all([
      db.collection("users").find({}, { projection: { passwordHash: 0 } }).sort({ displayName: 1 }).toArray(),
      db.collection("sessions").find(
        { expiresAt: { $gt: now }, userId: { $exists: true } },
        { projection: { userId: 1 } },
      ).toArray(),
      loadActionCatalog(db),
      listRoleDefinitions(db),
    ]);
    const sessionCounts = new Map<string, number>();
    for (const session of sessions) {
      if (!(session.userId instanceof ObjectId)) continue;
      const userId = session.userId.toHexString();
      sessionCounts.set(userId, (sessionCounts.get(userId) || 0) + 1);
    }
    return NextResponse.json({
      currentUserId: admin._id.toString(),
      roles,
      users: users.map((user) => ({
        id: user._id.toString(), email: user.email, displayName: user.displayName, role: user.role,
        entity: user.entity || "Groupe", actionAccess: Array.isArray(user.actionAccess) ? user.actionAccess : [], active: user.active !== false, createdAt: user.createdAt || null,
        updatedAt: user.updatedAt || null, lastLoginAt: user.lastLoginAt || null,
        activeSessions: sessionCounts.get(user._id.toString()) || 0,
      })), actionCatalog,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, "admin/users:GET");
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return errorResponse("Accès administrateur requis.", 403);
  const body = await request.json().catch(() => null) as { email?: string; password?: string; displayName?: string; role?: string; entity?: string; actionAccess?: string[] } | null;
  const email = body?.email?.trim().toLowerCase() || "";
  const password = body?.password || "";
  const displayName = body?.displayName?.trim() || "";
  const role = body?.role;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errorResponse("Adresse e-mail invalide.");
  if (password.length < 10) return errorResponse("Le mot de passe doit contenir au moins 10 caractères.");
  if (!displayName) return errorResponse("Le nom d'affichage est requis.");
  if (!role) return errorResponse("Rôle invalide.");
  try {
    const db = await getDb();
    if (!await resolveRoleDefinition(db, role)) return errorResponse("Rôle invalide.");
    const now = new Date();
    const requestedEntity = body?.entity?.trim() || "";
    const entity = role === "ADMIN" ? (requestedEntity || "Groupe") : actionEntityFor(requestedEntity);
    if (!entity) return errorResponse("Attribuez une entité valide à ce compte.");
    const actionAccess = validatedActionAccess(body?.actionAccess ?? [], await loadActionCatalog(db));
    if (!actionAccess) return errorResponse("La liste des accès supplémentaires contient une action invalide.");
    const result = await db.collection("users").insertOne({ email, passwordHash: await hashPassword(password), displayName, role, entity, actionAccess, active: true, createdAt: now, createdBy: admin._id });
    await db.collection("auditLogs").insertOne({ eventType: "user_created", userId: admin._id, targetUserId: result.insertedId, details: { email, displayName, role, entity, additionalActionAccess: actionAccess.length }, at: now });
    return NextResponse.json({ id: result.insertedId.toString(), email, displayName, role }, { status: 201 });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return errorResponse("Un compte utilise déjà cette adresse e-mail.", 409);
    return apiErrorResponse(error, "admin/users:POST");
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return errorResponse("Accès administrateur requis.", 403);
  const body = await request.json().catch(() => null) as { id?: string; displayName?: string; role?: string; entity?: string; actionAccess?: string[]; active?: boolean; password?: string; revokeSessions?: boolean } | null;
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
    const nextRole = body.role ?? String(target.role);
    if (!await resolveRoleDefinition(db, nextRole)) return errorResponse("Rôle invalide.");
    const requestedEntity = body.entity !== undefined ? body.entity.trim() : String(target.entity || "");
    const nextEntity = nextRole === "ADMIN" ? (requestedEntity || "Groupe") : actionEntityFor(requestedEntity);
    if (!nextEntity) return errorResponse("Attribuez une entité valide à ce compte.");
    if (body.displayName !== undefined) {
      const displayName = body.displayName.trim();
      if (!displayName) return errorResponse("Le nom d'affichage est requis.");
      updates.displayName = displayName; changed.push("displayName");
    }
    if (body.entity !== undefined && nextEntity !== target.entity) { updates.entity = nextEntity; changed.push("entity"); }
    if (body.active !== undefined) { updates.active = Boolean(body.active); changed.push("active"); }
    if (body.role !== undefined) {
      if (body.role !== target.role) { updates.role = body.role; changed.push("role"); }
    }
    if (body.actionAccess !== undefined) {
      const actionAccess = validatedActionAccess(body.actionAccess, await loadActionCatalog(db));
      if (!actionAccess) return errorResponse("La liste des accès supplémentaires contient une action invalide.");
      const previous = Array.isArray(target.actionAccess) ? target.actionAccess : [];
      if (JSON.stringify([...previous].sort()) !== JSON.stringify([...actionAccess].sort())) { updates.actionAccess = actionAccess; changed.push("actionAccess"); }
    }
    if (body.password !== undefined) {
      if (body.password.length < 10) return errorResponse("Le mot de passe doit contenir au moins 10 caractères.");
      updates.passwordHash = await hashPassword(body.password); changed.push("password");
    }
    if (changed.length) await users.updateOne({ _id: targetId }, { $set: updates });
    const revokeSessions = body.revokeSessions === true || body.active === false || body.password !== undefined || changed.includes("role") || changed.includes("entity") || changed.includes("actionAccess");
    if (revokeSessions) await db.collection("sessions").deleteMany({ userId: targetId });
    await db.collection("auditLogs").insertOne({ eventType: revokeSessions && !changed.length ? "sessions_revoked" : "user_updated", userId: admin._id, targetUserId: targetId, details: { fields: changed, revokedSessions: revokeSessions, targetEmail: target.email }, at: new Date() });
    return NextResponse.json({ ok: true, revokedSessions: revokeSessions });
  } catch (error) {
    return apiErrorResponse(error, "admin/users:PATCH");
  }
}

export async function DELETE(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return errorResponse("Accès administrateur requis.", 403);
  const body = await request.json().catch(() => null) as { ids?: string[] } | null;
  const ids = [...new Set(Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [])];
  if (!ids.length || ids.length > 100 || ids.some((id) => !ObjectId.isValid(id))) {
    return errorResponse("Sélection d’utilisateurs invalide.");
  }
  const targetIds = ids.map((id) => new ObjectId(id));
  if (targetIds.some((id) => id.equals(admin._id))) {
    return errorResponse("Vous ne pouvez pas supprimer votre propre compte administrateur.", 409);
  }
  try {
    const db = await getDb();
    const users = db.collection("users");
    const targets = await users.find({ _id: { $in: targetIds } }, { projection: { email: 1, displayName: 1, role: 1, active: 1 } }).toArray();
    if (targets.length !== targetIds.length) return errorResponse("Un ou plusieurs utilisateurs sont introuvables.", 404);
    const removesActiveAdmin = targets.some((user) => user.role === "ADMIN" && user.active !== false);
    if (removesActiveAdmin) {
      const remainingAdmins = await users.countDocuments({ _id: { $nin: targetIds }, role: "ADMIN", active: true });
      if (!remainingAdmins) return errorResponse("Le dernier administrateur actif ne peut pas être supprimé.", 409);
    }
    await Promise.all([
      db.collection("sessions").deleteMany({ userId: { $in: targetIds } }),
      db.collection("presence").deleteMany({ userId: { $in: targetIds } }),
    ]);
    const result = await users.deleteMany({ _id: { $in: targetIds } });
    const deletedUsers = targets.map((user) => ({ id: user._id.toString(), email: user.email, displayName: user.displayName, role: user.role }));
    await db.collection("auditLogs").insertOne({ eventType: "users_deleted", userId: admin._id, details: { count: result.deletedCount, users: deletedUsers }, at: new Date() });
    return NextResponse.json({ ok: true, deletedCount: result.deletedCount });
  } catch (error) {
    return apiErrorResponse(error, "admin/users:DELETE");
  }
}
