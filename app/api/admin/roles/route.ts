import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-errors";
import { errorResponse } from "@/lib/http";
import { getDb } from "@/lib/mongodb";
import { listRoleDefinitions } from "@/lib/role-store";
import { ACTION_SCOPE_OPTIONS, ROLE_PRIVILEGES, validPrivileges, type ActionScope } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireAdmin() {
  const user = await getCurrentUser();
  return user?.role === "ADMIN" ? user : null;
}

function validActionScope(value: unknown): value is Exclude<ActionScope, "ALL"> {
  return ACTION_SCOPE_OPTIONS.some((item) => item.code === value);
}

function roleCode(name: string) {
  const slug = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "ROLE";
  return `CUSTOM_${slug}_${randomBytes(2).toString("hex").toUpperCase()}`;
}

export async function GET() {
  try {
    const admin = await requireAdmin();
    if (!admin) return errorResponse("Accès administrateur requis.", 403);
    const db = await getDb();
    return NextResponse.json({ roles: await listRoleDefinitions(db), privileges: ROLE_PRIVILEGES, actionScopes: ACTION_SCOPE_OPTIONS }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, "admin/roles:GET");
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return errorResponse("Accès administrateur requis.", 403);
  const body = await request.json().catch(() => null) as { name?: string; description?: string; privileges?: string[]; actionScope?: string } | null;
  const name = body?.name?.trim() || "";
  const description = body?.description?.trim().slice(0, 300) || "";
  const privileges = validPrivileges(body?.privileges);
  if (name.length < 2 || name.length > 80) return errorResponse("Le nom du rôle doit contenir entre 2 et 80 caractères.");
  if (!privileges) return errorResponse("La liste des privilèges est invalide.");
  if (!validActionScope(body?.actionScope)) return errorResponse("La portée des actions est invalide.");
  try {
    const db = await getDb();
    const roles = db.collection("customRoles");
    await roles.createIndex({ code: 1 }, { unique: true });
    await roles.createIndex({ nameKey: 1 }, { unique: true });
    const now = new Date();
    const code = roleCode(name);
    await roles.insertOne({ code, name, nameKey: name.toLocaleLowerCase("fr"), description, privileges, actionScope: body.actionScope, active: true, createdAt: now, createdBy: admin._id, updatedAt: now, updatedBy: admin._id });
    await db.collection("auditLogs").insertOne({ eventType: "role_created", userId: admin._id, details: { code, name, privileges, actionScope: body.actionScope }, at: now });
    return NextResponse.json({ code, name }, { status: 201 });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return errorResponse("Un rôle porte déjà ce nom.", 409);
    return apiErrorResponse(error, "admin/roles:POST");
  }
}

export async function PATCH(request: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return errorResponse("Accès administrateur requis.", 403);
  const body = await request.json().catch(() => null) as { code?: string; name?: string; description?: string; privileges?: string[]; actionScope?: string } | null;
  const code = body?.code?.trim() || "";
  const name = body?.name?.trim() || "";
  const description = body?.description?.trim().slice(0, 300) || "";
  const privileges = validPrivileges(body?.privileges);
  if (!/^CUSTOM_[A-Z0-9_]{1,60}$/.test(code)) return errorResponse("Rôle personnalisé invalide.");
  if (name.length < 2 || name.length > 80) return errorResponse("Le nom du rôle doit contenir entre 2 et 80 caractères.");
  if (!privileges) return errorResponse("La liste des privilèges est invalide.");
  if (!validActionScope(body?.actionScope)) return errorResponse("La portée des actions est invalide.");
  try {
    const db = await getDb();
    const now = new Date();
    const result = await db.collection("customRoles").updateOne({ code, active: { $ne: false } }, { $set: { name, nameKey: name.toLocaleLowerCase("fr"), description, privileges, actionScope: body.actionScope, updatedAt: now, updatedBy: admin._id } });
    if (!result.matchedCount) return errorResponse("Rôle personnalisé introuvable.", 404);
    const affectedUsers = await db.collection("users").find({ role: code }, { projection: { _id: 1 } }).toArray();
    if (affectedUsers.length) await db.collection("sessions").deleteMany({ userId: { $in: affectedUsers.map((user) => user._id) } });
    await db.collection("auditLogs").insertOne({ eventType: "role_updated", userId: admin._id, details: { code, name, privileges, actionScope: body.actionScope, affectedUsers: affectedUsers.length }, at: now });
    return NextResponse.json({ ok: true, affectedUsers: affectedUsers.length });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return errorResponse("Un rôle porte déjà ce nom.", 409);
    return apiErrorResponse(error, "admin/roles:PATCH");
  }
}
