import { cookies } from "next/headers";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongodb";
import type { Role } from "@/lib/roles";

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "clc_session_v2";
const LEGACY_COOKIE_NAME = "clc_session";
const SESSION_DAYS = 7;

export type AppUser = {
  _id: ObjectId;
  email: string;
  displayName: string;
  role: Role;
  entity: string;
  actionAccess?: string[];
  active: boolean;
};

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: ObjectId) {
  const db = await getDb();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection("sessions").insertOne({ tokenHash: tokenHash(token), userId, createdAt: new Date(), expiresAt });
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
  jar.delete(LEGACY_COOKIE_NAME);
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (token) {
    const db = await getDb();
    await db.collection("sessions").deleteOne({ tokenHash: tokenHash(token) });
  }
  jar.delete(COOKIE_NAME);
  jar.delete(LEGACY_COOKIE_NAME);
}

export async function getCurrentUser(): Promise<AppUser | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  const db = await getDb();
  const session = await db.collection("sessions").findOne({ tokenHash: tokenHash(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  return db.collection<AppUser>("users").findOne({ _id: session.userId as ObjectId, active: true });
}

export function publicUser(user: AppUser) {
  return { id: user._id.toHexString(), email: user.email, displayName: user.displayName, role: user.role, entity: user.entity, actionAccess: Array.isArray(user.actionAccess) ? user.actionAccess : [] };
}
