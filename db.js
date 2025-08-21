// db.js
const { Pool } = require("pg");

const isProd = process.env.NODE_ENV === "production";
const connectionString = process.env.DATABASE_URL;

const pool = new Pool(
  isProd
    ? { connectionString, ssl: { rejectUnauthorized: false } } // needed on Render/most clouds
    : { connectionString } // local dev
);

module.exports = { pool };
