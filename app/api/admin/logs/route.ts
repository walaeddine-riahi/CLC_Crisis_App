import { ObjectId } from "mongodb";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { apiErrorResponse } from "@/lib/api-errors";
import { errorResponse } from "@/lib/http";
import { getDb } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENT_TYPES = ["login", "login_failed", "logout", "first_admin_created", "user_created", "user_updated", "sessions_revoked", "workspace_bootstrap", "section_update"];

export async function GET(request: NextRequest) {
  try {
    const admin = await getCurrentUser();
    if (admin?.role !== "ADMIN") return errorResponse("Accès administrateur requis.", 403);
    const params = request.nextUrl.searchParams;
    const page = Math.max(1, Number(params.get("page")) || 1);
    const limit = Math.min(100, Math.max(10, Number(params.get("limit")) || 30));
    const eventType = params.get("eventType")?.trim() || "";
    const search = params.get("search")?.trim().slice(0, 100) || "";
    const from = params.get("from") ? new Date(params.get("from") as string) : null;
    const to = params.get("to") ? new Date(params.get("to") as string) : null;
    const match: Record<string, unknown> = {};
    if (eventType && EVENT_TYPES.includes(eventType)) match.eventType = eventType;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      match.at = { ...(from && !Number.isNaN(from.getTime()) ? { $gte: from } : {}), ...(to && !Number.isNaN(to.getTime()) ? { $lte: to } : {}) };
    }
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match.$or = [
        { eventType: { $regex: escaped, $options: "i" } },
        { sectionKey: { $regex: escaped, $options: "i" } },
        { "details.email": { $regex: escaped, $options: "i" } },
        { "details.targetEmail": { $regex: escaped, $options: "i" } },
      ];
    }
    const db = await getDb();
    if (search) {
      const expression = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const matchedUsers = await db.collection("users").find({ $or: [{ email: expression }, { displayName: expression }] }, { projection: { _id: 1 } }).limit(100).toArray();
      const userIds = matchedUsers.map((user) => user._id);
      if (userIds.length) (match.$or as Record<string, unknown>[]).push({ userId: { $in: userIds } }, { targetUserId: { $in: userIds } });
    }
    const logs = db.collection("auditLogs");
    await Promise.all([logs.createIndex({ at: -1 }), logs.createIndex({ eventType: 1, at: -1 }), logs.createIndex({ userId: 1, at: -1 })]);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [rows, total, totalAll, last24h, activeUsers] = await Promise.all([
      logs.aggregate([
        { $match: match }, { $sort: { at: -1 } }, { $skip: (page - 1) * limit }, { $limit: limit },
        { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "actor" } },
        { $lookup: { from: "users", localField: "targetUserId", foreignField: "_id", as: "target" } },
        { $project: { eventType: 1, sectionKey: 1, details: 1, at: 1, actor: { $first: "$actor" }, target: { $first: "$target" } } },
        { $project: { eventType: 1, sectionKey: 1, details: 1, at: 1, "actor._id": 1, "actor.email": 1, "actor.displayName": 1, "actor.role": 1, "target._id": 1, "target.email": 1, "target.displayName": 1 } },
      ]).toArray(),
      logs.countDocuments(match), logs.estimatedDocumentCount(), logs.countDocuments({ at: { $gte: since24h } }),
      logs.distinct("userId", { at: { $gte: since24h }, userId: { $type: "objectId" } }),
    ]);
    return NextResponse.json({
      logs: rows.map((row) => ({
        id: row._id.toString(), eventType: row.eventType, sectionKey: row.sectionKey || null, details: row.details || {}, at: row.at,
        actor: row.actor ? { id: (row.actor._id as ObjectId).toString(), email: row.actor.email, displayName: row.actor.displayName, role: row.actor.role } : null,
        target: row.target ? { id: (row.target._id as ObjectId).toString(), email: row.target.email, displayName: row.target.displayName } : null,
      })),
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      stats: { total: totalAll, last24h, activeUsers24h: activeUsers.length }, eventTypes: EVENT_TYPES,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, "admin/logs:GET");
  }
}
