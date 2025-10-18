// database.js
const mysql = require("mysql2/promise");
const fs = require("fs");
require("dotenv").config();

let sslConfig = undefined;
if (process.env.DB_SSL_CA && fs.existsSync(process.env.DB_SSL_CA)) {
  sslConfig = { ca: fs.readFileSync(process.env.DB_SSL_CA) };
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: sslConfig,
});

async function testConnection() {
  try {
    const conn = await pool.getConnection();
    console.log("✅ Connected to DB");
    conn.release();
  } catch (err) {
    console.error("❌ DB connection failed:", err.message);
  }
}

testConnection();

module.exports = pool;
