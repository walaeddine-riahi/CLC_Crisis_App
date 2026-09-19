import { MongoClient, ServerApiVersion } from "mongodb";

const globalForMongo = globalThis as typeof globalThis & { mongoClientPromise?: Promise<MongoClient> };

export async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI_MISSING");
  if (!globalForMongo.mongoClientPromise) {
    globalForMongo.mongoClientPromise = new MongoClient(uri, {
      serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
      maxPoolSize: 10,
      connectTimeoutMS: 8_000,
      serverSelectionTimeoutMS: 8_000,
    }).connect().catch((error) => {
      globalForMongo.mongoClientPromise = undefined;
      throw error;
    });
  }
  const client = await globalForMongo.mongoClientPromise;
  return client.db(process.env.MONGODB_DB || "clc_crisis");
}
