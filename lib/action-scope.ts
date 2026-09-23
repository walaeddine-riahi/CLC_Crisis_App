import type { ActionScope } from "@/lib/roles";

export const ACTION_ENTITIES = ["CLC", "SBC", "Delta Plastic", "CF", "Boucharray", "Atig"] as const;

export type ActionEntity = (typeof ACTION_ENTITIES)[number];

export function actionReference(entity: unknown, actionId: unknown) {
  const canonicalEntity = actionEntityFor(entity);
  const id = String(actionId ?? "").trim();
  return canonicalEntity && id ? `${canonicalEntity}::${id}` : "";
}

function normalize(value: unknown) {
  return typeof value === "string"
    ? value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]+/g, " ").trim()
    : "";
}

const genericResponsibleNames = new Set(["groupe", "clc", "cf", "cln", "clsb", "sbc", "sdem"]);

export function actionIsAssignedTo(action: unknown, displayName: unknown, entity: unknown) {
  if (!isRecord(action)) return false;
  const owner = normalize(action.owner);
  const identities = [displayName, entity]
    .map(normalize)
    .filter((identity) => identity.length >= 3 && !genericResponsibleNames.has(identity));
  return Boolean(owner && identities.some((identity) => owner.includes(identity) || identity.includes(owner)));
}

const entityAliases = new Map<string, ActionEntity>([
  ["clc", "CLC"],
  ["centrale laitiere du cap bon", "CLC"],
  ["sbc", "SBC"],
  ["societe des boissons du cap bon", "SBC"],
  ["delta plastic", "Delta Plastic"],
  ["delta plastics", "Delta Plastic"],
  ["cf", "CF"],
  ["compagnie fromagere", "CF"],
  ["compagnie fromagere borj cedria", "CF"],
  ["boucharray", "Boucharray"],
  ["atig", "Atig"],
]);

export function actionEntityFor(entity: unknown): ActionEntity | null {
  return entityAliases.get(normalize(entity)) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function accessSet(actionAccess: unknown) {
  return new Set(Array.isArray(actionAccess) ? actionAccess.filter((item): item is string => typeof item === "string") : []);
}

function visibleActions(payload: unknown, payloadEntity: ActionEntity, role: string, actionScope: ActionScope, displayName: unknown, entity: unknown, actionAccess: unknown) {
  if (!Array.isArray(payload)) return [];
  const ownEntity = actionEntityFor(entity);
  const grants = accessSet(actionAccess);
  return payload.filter((action) => {
    const granted = isRecord(action) && grants.has(actionReference(payloadEntity, action.id));
    if (granted) return true;
    if (actionScope === "GRANTED_ONLY" || payloadEntity !== ownEntity) return false;
    return actionScope !== "ASSIGNED" || actionIsAssignedTo(action, displayName, entity);
  });
}

export function scopeActionPayload(sectionKey: string, payload: unknown, role: string, actionScope: ActionScope, entity: unknown, displayName?: unknown, actionAccess?: unknown) {
  if (role === "ADMIN" || actionScope === "ALL") return payload;
  const actionEntity = actionEntityFor(entity);
  if (sectionKey === "actions") return visibleActions(payload, "CLC", role, actionScope, displayName, entity, actionAccess);
  if (sectionKey === "simpleChecklists") {
    if (!isRecord(payload)) return {};
    const scoped: Record<string, unknown> = {};
    for (const candidate of ACTION_ENTITIES) {
      if (candidate === "CLC") continue;
      const rows = visibleActions(payload[candidate], candidate, role, actionScope, displayName, entity, actionAccess);
      if (rows.length || candidate === actionEntity) scoped[candidate] = rows;
    }
    return scoped;
  }
  return payload;
}

export function canAccessActionSection(sectionKey: string, role: string, actionScope: ActionScope, entity: unknown) {
  if (role === "ADMIN" || actionScope === "ALL") return true;
  if (actionScope === "GRANTED_ONLY" && ["actions", "simpleChecklists"].includes(sectionKey)) return false;
  const actionEntity = actionEntityFor(entity);
  if (sectionKey === "actions") return actionEntity === "CLC";
  if (sectionKey === "simpleChecklists") return Boolean(actionEntity && actionEntity !== "CLC");
  return true;
}

function mergeResponsibleActions(current: unknown, submitted: unknown) {
  if (!Array.isArray(current) || !Array.isArray(submitted)) return current;
  const submittedById = new Map(submitted.map((action) => [isRecord(action) ? String(action.id ?? "") : "", action]));
  return current.map((action) => {
    const id = isRecord(action) ? String(action.id ?? "") : "";
    return id && submittedById.has(id) ? submittedById.get(id) : action;
  });
}

export function mergeScopedActionPayload(sectionKey: string, current: unknown, submitted: unknown, role: string, actionScope: ActionScope, entity: unknown) {
  if (role === "ADMIN" || actionScope === "ALL" || !["actions", "simpleChecklists"].includes(sectionKey)) return submitted;
  const actionEntity = actionEntityFor(entity);
  if (sectionKey === "actions") {
    if (actionEntity !== "CLC" || !Array.isArray(submitted)) return current;
    return actionScope === "ASSIGNED" ? mergeResponsibleActions(current, submitted) : submitted;
  }
  if (!actionEntity || actionEntity === "CLC") return current;
  const currentByEntity = isRecord(current) ? current : {};
  const submittedByEntity = isRecord(submitted) ? submitted : {};
  return {
    ...currentByEntity,
    [actionEntity]: actionScope === "ASSIGNED"
      ? mergeResponsibleActions(currentByEntity[actionEntity], submittedByEntity[actionEntity])
      : Array.isArray(submittedByEntity[actionEntity]) ? submittedByEntity[actionEntity] : [],
  };
}
