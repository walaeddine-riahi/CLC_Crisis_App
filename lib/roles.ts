export const ROLES = ["ADMIN", "GROUP_CRISIS", "SITE_CLC", "SITE_CF", "ACTION_OWNER", "DG", "VIEWER"] as const;
export type BuiltInRole = (typeof ROLES)[number];
export type Role = string;
export type ActionScope = "ALL" | "ENTITY" | "ASSIGNED" | "GRANTED_ONLY";

export type RoleDefinition = {
  code: string;
  name: string;
  description: string;
  builtIn: boolean;
  privileges: string[];
  writeSections: "*" | string[];
  actionScope: ActionScope;
};

export const ROLE_PRIVILEGES = [
  { code: "SITUATION_WRITE", name: "Gérer la situation", description: "Situation de crise, activation, périmètre et état des sites.", sections: ["crisis", "deployment", "meta", "scope", "emergencyOverride", "lastTerrainUpdate", "siteSituation", "entities", "v20"] },
  { code: "ACTIONS_WRITE", name: "Gérer les actions", description: "Créer et mettre à jour les actions dans le périmètre autorisé.", sections: ["actions", "simpleChecklists"] },
  { code: "DECISIONS_WRITE", name: "Gérer les décisions", description: "Décisions Groupe et décisions par entité.", sections: ["decisions", "entityDecisions"] },
  { code: "WEATHER_WRITE", name: "Actualiser météo / hydro", description: "Données météo, prévisions automatiques et hydrologie.", sections: ["meteo", "autoWeather", "multiWeather", "forecasts", "hydro"] },
  { code: "TERRAIN_WRITE", name: "Mettre à jour le terrain", description: "Preuves terrain, état par zone et situation locale.", sections: ["terrainEvidence", "terrainByZone", "siteSituation", "lastTerrainUpdate"] },
  { code: "JOURNAL_WRITE", name: "Écrire dans le journal", description: "Ajouter des notes et événements au journal de crise.", sections: ["journal"] },
  { code: "LOGISTICS_WRITE", name: "Gérer la logistique", description: "Moyens, besoins et suivi logistique.", sections: ["logistics"] },
] as const;

export const ACTION_SCOPE_OPTIONS: Array<{ code: Exclude<ActionScope, "ALL">; name: string; description: string }> = [
  { code: "ENTITY", name: "Toute son entité", description: "Consulte les actions de son entité et les accès supplémentaires accordés par l’admin." },
  { code: "ASSIGNED", name: "Actions affectées", description: "Consulte ses actions affectées et les accès supplémentaires en lecture seule." },
  { code: "GRANTED_ONLY", name: "Autorisations uniquement", description: "Consulte uniquement les actions explicitement accordées par l’admin." },
];

const builtIn: Record<BuiltInRole, RoleDefinition> = {
  ADMIN: { code: "ADMIN", name: "Administrateur", description: "Accès complet à la plateforme et à son administration.", builtIn: true, privileges: [], writeSections: "*", actionScope: "ALL" },
  GROUP_CRISIS: { code: "GROUP_CRISIS", name: "Cellule Groupe", description: "Pilotage complet de la crise dans son périmètre.", builtIn: true, privileges: [], writeSections: "*", actionScope: "ENTITY" },
  SITE_CLC: { code: "SITE_CLC", name: "Cellule CLC", description: "Coordination opérationnelle du site CLC.", builtIn: true, privileges: [], writeSections: ["actions", "simpleChecklists", "entityDecisions", "terrainEvidence", "terrainByZone", "journal", "logistics", "scope", "emergencyOverride", "lastTerrainUpdate", "meteo", "autoWeather", "multiWeather"], actionScope: "ENTITY" },
  SITE_CF: { code: "SITE_CF", name: "Cellule CF", description: "Coordination opérationnelle du site CF.", builtIn: true, privileges: [], writeSections: ["actions", "simpleChecklists", "entityDecisions", "terrainEvidence", "terrainByZone", "journal", "scope", "emergencyOverride", "lastTerrainUpdate", "meteo", "autoWeather", "multiWeather"], actionScope: "ENTITY" },
  ACTION_OWNER: { code: "ACTION_OWNER", name: "Responsable d’action", description: "Mise à jour de ses propres actions.", builtIn: true, privileges: [], writeSections: ["actions", "simpleChecklists", "journal"], actionScope: "ASSIGNED" },
  DG: { code: "DG", name: "Direction Générale", description: "Décisions, journal et suivi de crise.", builtIn: true, privileges: [], writeSections: ["crisis", "deployment", "entityDecisions", "journal", "decisions", "meta"], actionScope: "ENTITY" },
  VIEWER: { code: "VIEWER", name: "Lecture seule", description: "Consultation sans modification.", builtIn: true, privileges: [], writeSections: [], actionScope: "ENTITY" },
};

export const BUILT_IN_ROLE_DEFINITIONS = ROLES.map((code) => builtIn[code]);

export function isBuiltInRole(role: string): role is BuiltInRole {
  return ROLES.includes(role as BuiltInRole);
}

export function builtInRoleDefinition(role: string) {
  return isBuiltInRole(role) ? builtIn[role] : null;
}

export function sectionsForPrivileges(privileges: unknown): string[] {
  const selected = new Set(Array.isArray(privileges) ? privileges.filter((item): item is string => typeof item === "string") : []);
  return [...new Set(ROLE_PRIVILEGES.filter((item) => selected.has(item.code)).flatMap((item) => [...item.sections]))];
}

export function validPrivileges(privileges: unknown): string[] | null {
  if (!Array.isArray(privileges)) return null;
  const allowed = new Set<string>(ROLE_PRIVILEGES.map((item) => item.code));
  const unique = [...new Set(privileges.filter((item): item is string => typeof item === "string"))];
  return unique.every((item) => allowed.has(item)) ? unique : null;
}

export function canWrite(role: RoleDefinition, section: string) {
  return role.writeSections === "*" || role.writeSections.includes(section);
}
