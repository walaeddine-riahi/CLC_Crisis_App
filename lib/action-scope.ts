import type { Role } from "@/lib/roles";

export const ACTION_ENTITIES = ["CLC", "SBC", "Delta Plastic", "CF", "Boucharray", "Atig"] as const;

export type ActionEntity = (typeof ACTION_ENTITIES)[number];

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

function visibleActions(payload: unknown, role: Role, displayName: unknown, entity: unknown) {
  if (!Array.isArray(payload)) return [];
  return role === "ACTION_OWNER" ? payload.filter((action) => actionIsAssignedTo(action, displayName, entity)) : payload;
}

export function scopeActionPayload(sectionKey: string, payload: unknown, role: Role, entity: unknown, displayName?: unknown) {
  if (role === "ADMIN") return payload;
  const actionEntity = actionEntityFor(entity);
  if (sectionKey === "actions") return actionEntity === "CLC" ? visibleActions(payload, role, displayName, entity) : [];
  if (sectionKey === "simpleChecklists") {
    if (!actionEntity || actionEntity === "CLC" || !isRecord(payload)) return {};
    return { [actionEntity]: visibleActions(payload[actionEntity], role, displayName, entity) };
  }
  return payload;
}

export function canAccessActionSection(sectionKey: string, role: Role, entity: unknown) {
  if (role === "ADMIN") return true;
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

export function mergeScopedActionPayload(sectionKey: string, current: unknown, submitted: unknown, role: Role, entity: unknown) {
  if (role === "ADMIN" || !["actions", "simpleChecklists"].includes(sectionKey)) return submitted;
  const actionEntity = actionEntityFor(entity);
  if (sectionKey === "actions") {
    if (actionEntity !== "CLC" || !Array.isArray(submitted)) return current;
    return role === "ACTION_OWNER" ? mergeResponsibleActions(current, submitted) : submitted;
  }
  if (!actionEntity || actionEntity === "CLC") return current;
  const currentByEntity = isRecord(current) ? current : {};
  const submittedByEntity = isRecord(submitted) ? submitted : {};
  return {
    ...currentByEntity,
    [actionEntity]: role === "ACTION_OWNER"
      ? mergeResponsibleActions(currentByEntity[actionEntity], submittedByEntity[actionEntity])
      : Array.isArray(submittedByEntity[actionEntity]) ? submittedByEntity[actionEntity] : [],
  };
}
