// scripts/db-setup.js
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const dotenv = require("dotenv");

// Allow: node scripts/db-setup.js .env.remote   (or .env)
const envPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(".env");
dotenv.config({ path: envPath });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing in", envPath);
  process.exit(1);
}

// Force SSL for cloud DBs (Render, etc.)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  const seed = fs.readFileSync(path.join(__dirname, "..", "db", "seed.sql"), "utf8");

  console.log("Connecting to:", process.env.DATABASE_URL.replace(/:\/\/.*@/, "://***@"));
  const client = await pool.connect();
  try {
    console.log("Running schema.sql...");
    await client.query(schema);
    console.log("Running seed.sql...");
    await client.query(seed);
    const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM products");
    console.log("Products seeded:", rows[0].count);
  } finally {
    client.release();
    await pool.end();
  }
}

run()
  .then(() => console.log("Done."))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
