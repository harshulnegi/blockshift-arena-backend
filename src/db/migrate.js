import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "./pool.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = process.env.SCHEMA_PATH || path.resolve(dirname, "../../schema.sql");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required before running migrations");
  process.exitCode = 1;
} else {
  try {
    const schema = await fs.readFile(schemaPath, "utf8");
    await query(schema);
    console.log("BlockShift database schema is ready");
  } catch (error) {
    console.error("BlockShift database migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

