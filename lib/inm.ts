const INM_ORIGIN = "https://www.meteo.tn";

const COLOR_STATUS: Record<string, "Vert" | "Jaune" | "Orange" | "Rouge"> = {
  "#63bb2c": "Vert",
  "#008000": "Vert",
  "#ffff3f": "Jaune",
  "#ffff00": "Jaune",
  "#f7931e": "Orange",
  "#f7941d": "Orange",
  "#ff8c00": "Orange",
  "#ffa500": "Orange",
  "#ed1c24": "Rouge",
  "#e30613": "Rouge",
  "#ff0000": "Rouge",
};

function decodeHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function parseTunisiaDate(value: string) {
  const normalized = value.trim().replace(" ", "T");
  const parsed = new Date(`${normalized}:00+01:00`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Date INM invalide : ${value}`);
  return parsed.toISOString();
}

function requiredMatch(html: string, expression: RegExp, label: string) {
  const value = html.match(expression)?.[1];
  if (!value) throw new Error(`Champ INM introuvable : ${label}`);
  return decodeHtml(value);
}

function zoneAnchor(html: string, zone: string) {
  const escaped = zone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = html.match(new RegExp(`<a[^>]+xlink:title=["']${escaped}["'][^>]*>[\\s\\S]*?<\\/a>`, "i"))?.[0];
  if (!block) throw new Error(`Zone INM introuvable : ${zone}`);
  return block;
}

export type InmOverview = {
  zone: string;
  status: "Vert" | "Jaune" | "Orange" | "Rouge";
  diffusion: string;
  validUntil: string;
  description: string;
  detailUrl: string;
  sourceUrl: string;
  color: string;
};

export function parseInmOverview(html: string, zone = "Nabeul"): InmOverview {
  const anchor = zoneAnchor(html, zone);
  const color = requiredMatch(anchor, /\sfill=["'](#[0-9a-f]{6})["']/i, "couleur").toLowerCase();
  const status = COLOR_STATUS[color];
  if (!status) throw new Error(`Couleur INM non reconnue : ${color}`);
  const href = requiredMatch(anchor, /xlink:href=["']([^"']+)["']/i, "lien détail");
  const diffusionText = requiredMatch(html, /class=["']date-diffusion["'][^>]*>([\s\S]*?)<\/p>/i, "diffusion");
  const validityText = requiredMatch(html, /class=["']date-validite["'][^>]*>([\s\S]*?)<\/p>/i, "validité");
  const description = requiredMatch(html, /Description de la situation météorologique<\/h3>[\s\S]*?<p>([\s\S]*?)<\/p>/i, "description");
  return {
    zone,
    status,
    diffusion: parseTunisiaDate(diffusionText),
    validUntil: parseTunisiaDate(validityText),
    description,
    detailUrl: new URL(href, INM_ORIGIN).toString(),
    sourceUrl: `${INM_ORIGIN}/fr/vigilance-meterologique`,
    color,
  };
}

const PHENOMENA: Record<string, string> = {
  "pluie-inondation": "Pluie / Inondation",
  orages: "Orages",
  "vent violent": "Vent violent",
  "vent de sable": "Vent de sable",
  neige: "Neige",
  "vague de chaleur": "Vague de chaleur",
  canicule: "Vague de chaleur",
};

export function parseInmPhenomena(html: string) {
  const found = new Set<string>();
  for (const match of html.matchAll(/<p>\s*([^<]{2,50})\s*<\/p>\s*<\/div>/gi)) {
    const label = decodeHtml(match[1]).toLowerCase();
    const mapped = PHENOMENA[label];
    if (mapped) found.add(mapped);
  }
  return [...found];
}

export function buildInmRecord(overview: InmOverview, detailHtml: string, checkedAt = new Date().toISOString()) {
  const phenomena = parseInmPhenomena(detailHtml);
  return {
    status: overview.status,
    phenomena: phenomena.length ? phenomena : ["Phénomène météorologique"],
    zones: [overview.zone],
    validFrom: overview.diffusion,
    validUntil: overview.validUntil,
    checkedAt,
    sourceUrl: overview.sourceUrl,
    detailUrl: overview.detailUrl,
    bulletinRef: `INM ${overview.zone} — ${overview.diffusion}`,
    note: overview.description,
    verifiedBy: "Collecte automatique — INM",
    validated: true,
    mode: "automatic",
    provider: "Institut National de la Météorologie",
    sourceColor: overview.color,
    updated: checkedAt,
  };
}
