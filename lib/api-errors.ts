import { MongoServerError, MongoServerSelectionError } from "mongodb";
import { errorResponse } from "@/lib/http";

type ApiErrorDetails = {
  message: string;
  code: string;
  status: number;
};

function mongoErrorDetails(error: unknown): ApiErrorDetails | null {
  if (error instanceof Error && error.message === "MONGODB_URI_MISSING") {
    return {
      message: "La connexion MongoDB n’est pas configurée sur le serveur. Ajoutez MONGODB_URI dans les variables d’environnement Vercel, puis redéployez.",
      code: "MONGODB_NOT_CONFIGURED",
      status: 503,
    };
  }

  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (error instanceof MongoServerError && (error.code === 18 || /authentication failed/i.test(text))) {
    return {
      message: "MongoDB a refusé les identifiants. Vérifiez l’utilisateur Atlas et renouvelez MONGODB_URI dans Vercel.",
      code: "MONGODB_AUTH_FAILED",
      status: 503,
    };
  }

  if (error instanceof MongoServerSelectionError || /server selection|econnrefused|timed?\s*out|querysrv|enotfound/i.test(text)) {
    return {
      message: "MongoDB Atlas est injoignable. Vérifiez Network Access dans Atlas et autorisez les connexions du déploiement Vercel.",
      code: "MONGODB_UNREACHABLE",
      status: 503,
    };
  }

  return null;
}

export function apiErrorResponse(error: unknown, context: string) {
  const mongo = mongoErrorDetails(error);
  console.error(`[${context}]`, error);
  if (mongo) return errorResponse(mongo.message, mongo.status, { code: mongo.code });
  return errorResponse("Une erreur serveur inattendue est survenue. Réessayez ou consultez les journaux Vercel.", 500, { code: "INTERNAL_ERROR" });
}
