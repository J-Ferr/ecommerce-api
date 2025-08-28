// db.js
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL || "";

// turn on SSL in the cloud (Render, etc.)
const needsSSL =
  /render\.com/.test(connectionString) || process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString,
  ...(needsSSL ? { ssl: { rejectUnauthorized: false } } : {}),
});

module.exports = { pool };
