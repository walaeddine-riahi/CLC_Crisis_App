import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { errorResponse, safeJsonSize } from "@/lib/http";
import { getDb } from "@/lib/mongodb";
import { canWrite } from "@/lib/roles";
import { canAccessActionSection, mergeScopedActionPayload, scopeActionPayload } from "@/lib/action-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function currentWorkspace() {
  const db = await getDb();
  return db.collection("workspaces").findOne({ code: process.env.CLC_WORKSPACE_CODE || "DELICE-INONDATIONS", isActive: true });
}

type ActionRecord = Record<string, unknown>;

const actionOwnerFields = new Set(["status", "progress", "difficulty"]);

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedIdentity(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]+/g, " ").trim()
    : "";
}

function isAssignedTo(action: ActionRecord, identities: string[]) {
  const owner = normalizedIdentity(action.owner);
  return Boolean(owner && identities.some((identity) => identity.length >= 3 && (owner.includes(identity) || identity.includes(owner))));
}

function isAllowedActionUpdate(previous: unknown, next: unknown, identities: string[]) {
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) || Array.isArray(next)) return false;
  const before = previous as ActionRecord;
  const after = next as ActionRecord;
  if (String(before.id ?? "") !== String(after.id ?? "")) return false;
  if (!isAssignedTo(before, identities)) return sameJson(before, after);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!actionOwnerFields.has(key) && !sameJson(before[key], after[key])) return false;
  }
  return true;
}

function isAllowedActionArray(previous: unknown, next: unknown, identities: string[]) {
  if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) return false;
  return previous.every((action, index) => isAllowedActionUpdate(action, next[index], identities));
}

function isAllowedOwnerPayload(sectionKey: string, previous: unknown, next: unknown, displayName: string, entity: string) {
  const genericEntities = new Set(["groupe", "clc", "cf", "cln", "clsb", "sbc", "sdem"]);
  const identities = [displayName, entity].map(normalizedIdentity).filter((identity) => identity && !genericEntities.has(identity));
  if (sectionKey === "actions") return isAllowedActionArray(previous, next, identities);
  if (sectionKey !== "simpleChecklists" || !previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) || Array.isArray(next)) return false;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].every((key) => key in before && key in after && isAllowedActionArray(before[key], after[key], identities));
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
  return NextResponse.json({ serverTime: new Date().toISOString(), sections: rows.map((row) => ({ sectionKey: row.sectionKey, payload: scopeActionPayload(row.sectionKey, row.payload, user.role, user.entity, user.displayName, user.actionAccess), version: row.version, updatedAt: row.updatedAt, updatedBy: row.updatedBy?.toString() })) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return errorResponse("Authentification requise.", 401);
  const body = await request.json().catch(() => null) as { sectionKey?: string; payload?: unknown; baseVersion?: number } | null;
  const sectionKey = body?.sectionKey?.trim() || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sectionKey)) return errorResponse("Clé de section invalide.");
  if (!canWrite(user.role, sectionKey)) return errorResponse(`Votre rôle ne permet pas de modifier « ${sectionKey} ».`, 403);
  if (!canAccessActionSection(sectionKey, user.role, user.entity)) return errorResponse("Vous pouvez uniquement gérer les actions de votre entité.", 403);
  if (!safeJsonSize(body?.payload)) return errorResponse("Section trop volumineuse.", 413);
  const workspace = await currentWorkspace();
  if (!workspace) return errorResponse("Workspace introuvable.", 404);
  const db = await getDb();
  const sections = db.collection("sections");
  const existing = await sections.findOne({ workspaceId: workspace._id, sectionKey });
  if (!existing) return errorResponse("Section centrale absente.", 404);
  const previousPayload = scopeActionPayload(sectionKey, existing.payload, user.role, user.entity, user.displayName, user.actionAccess);
  if (user.role === "ACTION_OWNER" && sectionKey !== "journal" && !isAllowedOwnerPayload(sectionKey, previousPayload, body?.payload, user.displayName, user.entity)) {
    return errorResponse("Vous pouvez uniquement mettre à jour l’état, l’avancement et la difficulté de vos actions affectées.", 403);
  }
  if (Number(body?.baseVersion) !== Number(existing.version)) {
    return errorResponse("Conflit de version.", 409, { current: { sectionKey, payload: previousPayload, version: existing.version, updatedAt: existing.updatedAt } });
  }
  const now = new Date();
  const nextVersion = Number(existing.version) + 1;
  const nextPayload = mergeScopedActionPayload(sectionKey, existing.payload, body?.payload, user.role, user.entity);
  const result = await sections.findOneAndUpdate(
    { _id: existing._id, version: existing.version },
    { $set: { payload: nextPayload, version: nextVersion, updatedAt: now, updatedBy: user._id } },
    { returnDocument: "after" },
  );
  if (!result) {
    const current = await sections.findOne({ _id: existing._id });
    return errorResponse("Conflit de version.", 409, current ? { current: { sectionKey, payload: scopeActionPayload(sectionKey, current.payload, user.role, user.entity, user.displayName, user.actionAccess), version: current.version, updatedAt: current.updatedAt } } : undefined);
  }
  await db.collection("auditLogs").insertOne({ workspaceId: workspace._id, userId: user._id, eventType: "section_update", sectionKey, details: { version: nextVersion, role: user.role, entity: user.entity }, at: now });
  return NextResponse.json({ sectionKey, payload: scopeActionPayload(sectionKey, result.payload, user.role, user.entity, user.displayName, user.actionAccess), version: result.version, updatedAt: result.updatedAt });
}
