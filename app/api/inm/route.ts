import { NextResponse } from "next/server";
import { buildInmRecord, parseInmOverview } from "@/lib/inm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCE_URL = "https://www.meteo.tn/fr/vigilance-meterologique";
const REQUEST_HEADERS = {
  Accept: "text/html,application/xhtml+xml",
  "Accept-Language": "fr-FR,fr;q=0.9",
  "User-Agent": "CLC-Crisis-App/4.0 (+official-INM-monitoring)",
};

async function fetchOfficialPage(url: string) {
  const response = await fetch(url, {
    headers: REQUEST_HEADERS,
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`INM HTTP ${response.status}`);
  return response.text();
}

export async function GET() {
  try {
    const overviewHtml = await fetchOfficialPage(SOURCE_URL);
    const overview = parseInmOverview(overviewHtml, "Nabeul");
    const detailHtml = await fetchOfficialPage(overview.detailUrl);
    const record = buildInmRecord(overview, detailHtml);
    return NextResponse.json(
      { ok: true, source: "INM", zone: "Nabeul", record },
      { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } },
    );
  } catch (error) {
    console.error("[inm:GET]", error);
    return NextResponse.json(
      { ok: false, error: "La vigilance officielle INM est temporairement indisponible. La dernière donnée valide est conservée jusqu’à son expiration." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
