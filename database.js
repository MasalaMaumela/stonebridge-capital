const mysql = require("mysql2");

const connection = mysql.createConnection({
  host: process.env.DB_HOST || "stonebridge-managemasala-aa59.j.aivencloud.com",
  user: process.env.DB_USER || "avnadmin",
  password: process.env.DB_PASS || "AVNS_1ieieeBFNwPbG6BWXw9",
  database: process.env.DB_NAME || "stonebridge",
  port: 3306
});

connection.connect(err => {
  if (err) {
    console.error("❌ Database connection failed:", err);
  } else {
    console.log("✅ Connected to Aiven MySQL!");
  }
});

module.exports = connection;
