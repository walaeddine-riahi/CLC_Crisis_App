import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-errors";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    const users = await db.collection("users").estimatedDocumentCount();
    return NextResponse.json(
      { status: "ok", database: "connected", bootstrapAvailable: users === 0 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error, "health:GET");
  }
}
