export const ROLES = ["ADMIN", "GROUP_CRISIS", "SITE_CLC", "SITE_CF", "ACTION_OWNER", "DG", "VIEWER"] as const;
export type Role = (typeof ROLES)[number];

const writeSections: Record<Role, "*" | string[]> = {
  ADMIN: "*",
  GROUP_CRISIS: "*",
  SITE_CLC: ["actions", "simpleChecklists", "entityDecisions", "terrainEvidence", "terrainByZone", "journal", "logistics", "scope", "emergencyOverride", "lastTerrainUpdate", "meteo", "autoWeather", "multiWeather"],
  SITE_CF: ["actions", "simpleChecklists", "entityDecisions", "terrainEvidence", "terrainByZone", "journal", "scope", "emergencyOverride", "lastTerrainUpdate", "meteo", "autoWeather", "multiWeather"],
  ACTION_OWNER: ["actions", "journal"],
  DG: ["deployment", "entityDecisions", "journal", "decisions", "meta"],
  VIEWER: [],
};

export function canWrite(role: Role, section: string) {
  const allowed = writeSections[role];
  return allowed === "*" || allowed.includes(section);
}
