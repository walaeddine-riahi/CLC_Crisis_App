import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { createSession, destroySession, getCurrentUser, hashPassword, publicUser, verifyPassword, type AppUser } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { apiErrorResponse } from "@/lib/api-errors";
import { resolveRoleDefinition } from "@/lib/role-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getCurrentUser();
    return NextResponse.json({ authenticated: Boolean(user), user: user ? publicUser(user) : null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, "auth/session:GET");
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
  const email = body?.email?.trim().toLowerCase() || "";
  const password = body?.password || "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errorResponse("Adresse e-mail invalide.");
  if (password.length < 10) return errorResponse("Le mot de passe doit contenir au moins 10 caractères.");

  try {
    const db = await getDb();
    type UserRecord = Omit<AppUser, "_id" | "roleDefinition"> & { _id?: ObjectId; passwordHash: string; createdAt: Date; lastLoginAt?: Date };
    const users = db.collection<UserRecord>("users");
    await users.createIndex({ email: 1 }, { unique: true });
    let user = await users.findOne({ email });
    let bootstrapped = false;

    if (!user && (await users.estimatedDocumentCount()) === 0) {
      try {
        await db.collection("systemLocks").insertOne({ _id: "first-admin" as never, createdAt: new Date() });
        const passwordHash = await hashPassword(password);
        const result = await users.insertOne({
          email,
          passwordHash,
          displayName: email.split("@")[0].replace(/[._-]+/g, " "),
          role: "ADMIN",
          entity: "Groupe",
          active: true,
          createdAt: new Date(),
        });
        user = await users.findOne({ _id: result.insertedId });
        bootstrapped = true;
      } catch (error) {
        user = await users.findOne({ email });
        if (!user) throw error;
      }
    }

    if (!user || !user._id || user.active === false || !(await verifyPassword(password, user.passwordHash))) {
      await db.collection("auditLogs").insertOne({ eventType: "login_failed", ...(user?._id ? { userId: user._id } : {}), details: { email, reason: user?.active === false ? "inactive_account" : "invalid_credentials" }, at: new Date() });
      return errorResponse("E-mail ou mot de passe incorrect.", 401);
    }
    const roleDefinition = await resolveRoleDefinition(db, user.role);
    if (!roleDefinition) return errorResponse("Le rôle de ce compte n’est plus disponible. Contactez un administrateur.", 403);
    await createSession(user._id);
    const loginAt = new Date();
    await Promise.all([
      users.updateOne({ _id: user._id }, { $set: { lastLoginAt: loginAt } }),
      db.collection("auditLogs").insertOne({ eventType: bootstrapped ? "first_admin_created" : "login", userId: user._id, at: loginAt }),
    ]);
    return NextResponse.json({ authenticated: true, bootstrapped, user: publicUser({ ...user, roleDefinition } as AppUser) });
  } catch (error) {
    return apiErrorResponse(error, "auth/session:POST");
  }
}

export async function DELETE() {
  try {
    const user = await getCurrentUser();
    await destroySession();
    if (user) {
      const db = await getDb();
      await db.collection("auditLogs").insertOne({ eventType: "logout", userId: user._id, at: new Date() });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, "auth/session:DELETE");
  }
}
