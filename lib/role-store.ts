import type { Db } from "mongodb";
import { ACTION_SCOPE_OPTIONS, BUILT_IN_ROLE_DEFINITIONS, builtInRoleDefinition, sectionsForPrivileges, type ActionScope, type RoleDefinition } from "@/lib/roles";

type CustomRoleDocument = { code: string; name: string; description?: string; privileges?: string[]; actionScope?: ActionScope; active?: boolean };

export function customRoleDefinition(document: CustomRoleDocument): RoleDefinition {
  const scope = ACTION_SCOPE_OPTIONS.some((item) => item.code === document.actionScope) ? document.actionScope! : "ENTITY";
  const privileges = Array.isArray(document.privileges) ? document.privileges : [];
  return { code: document.code, name: document.name, description: document.description || "Rôle personnalisé", builtIn: false, privileges, writeSections: sectionsForPrivileges(privileges), actionScope: scope };
}

export async function resolveRoleDefinition(db: Db, code: string): Promise<RoleDefinition | null> {
  const fixed = builtInRoleDefinition(code);
  if (fixed) return fixed;
  const custom = await db.collection<CustomRoleDocument>("customRoles").findOne({ code, active: { $ne: false } });
  return custom ? customRoleDefinition(custom) : null;
}

export async function listRoleDefinitions(db: Db): Promise<RoleDefinition[]> {
  const custom = await db.collection<CustomRoleDocument>("customRoles").find({ active: { $ne: false } }).sort({ name: 1 }).toArray();
  return [...BUILT_IN_ROLE_DEFINITIONS, ...custom.map(customRoleDefinition)];
}
