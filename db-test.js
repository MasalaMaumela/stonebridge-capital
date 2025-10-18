const mysql = require("mysql2");
const fs = require("fs");
require("dotenv").config();

console.log("🔹 Starting DB test...");

const sslConfig = fs.existsSync(process.env.DB_SSL_CA)
  ? { ca: fs.readFileSync(process.env.DB_SSL_CA) }
  : undefined;

console.log("🔹 SSL config loaded:", !!sslConfig);

const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT),
  ssl: sslConfig
});

connection.connect(err => {
  if (err) return console.error("❌ DB connection failed:", err.message);
  console.log("✅ DB connected!");
  connection.end(() => console.log("🔹 Connection closed."));
});

