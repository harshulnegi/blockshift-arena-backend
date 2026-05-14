import pg from "pg";

const connectionString = process.env.DATABASE_URL;
const sslRequired = process.env.DATABASE_SSL === "true" || /[?&]sslmode=require\b/i.test(connectionString || "");

export const pool = new pg.Pool({
  connectionString,
  ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30000
});

export async function query(text, params = []) {
  return pool.query(text, params);
}
