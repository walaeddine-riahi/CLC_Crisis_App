import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongodb";
import { createSession, destroySession, getCurrentUser, hashPassword, publicUser, verifyPassword, type AppUser } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  return NextResponse.json({ authenticated: Boolean(user), user: user ? publicUser(user) : null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
  const email = body?.email?.trim().toLowerCase() || "";
  const password = body?.password || "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errorResponse("Adresse e-mail invalide.");
  if (password.length < 10) return errorResponse("Le mot de passe doit contenir au moins 10 caractères.");

  const db = await getDb();
  type UserRecord = Omit<AppUser, "_id"> & { _id?: ObjectId; passwordHash: string; createdAt: Date };
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
    } catch {
      user = await users.findOne({ email });
    }
  }

  if (!user || !user._id || !(await verifyPassword(password, user.passwordHash))) {
    return errorResponse("E-mail ou mot de passe incorrect.", 401);
  }
  await createSession(user._id);
  await db.collection("auditLogs").insertOne({ eventType: bootstrapped ? "first_admin_created" : "login", userId: user._id, at: new Date() });
  return NextResponse.json({ authenticated: true, bootstrapped, user: publicUser(user as AppUser) });
}

export async function DELETE() {
  await destroySession();
  return NextResponse.json({ ok: true });
}
