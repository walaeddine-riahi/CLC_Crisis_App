import { NextResponse } from "next/server";

export function errorResponse(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function safeJsonSize(value: unknown, maxBytes = 2_500_000) {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes;
}
