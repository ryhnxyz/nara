import dotenv from "dotenv";
import { resolve } from "node:path";

// Load root .env regardless of where this script is invoked from.
dotenv.config({ path: resolve(process.cwd(), ".env") });
dotenv.config({ path: resolve(process.cwd(), "../../.env") });

import { initDb, openDb, databasePath } from "./index";

const db = openDb();
initDb(db);
console.log(`Initialized SQLite database at ${databasePath()}`);
