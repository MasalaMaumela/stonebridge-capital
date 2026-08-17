// database-setup.js
require("dotenv").config();

const pool = require("./database");

async function setupDatabase() {
  try {
    console.log("🔄 Creating Stonebridge database tables...");

    // =========================
    // USERS
    // =========================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        wallet_address VARCHAR(255) NOT NULL,
        balance DECIMAL(18,2) DEFAULT 0.00,
        referral_code VARCHAR(50) UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("✅ users table ready");

    // =========================
    // PLANS
    // =========================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id INT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        min_amount_usd DECIMAL(18,2) NOT NULL,
        daily_return DECIMAL(18,2) NOT NULL
      )
    `);

    console.log("✅ plans table ready");

    // =========================
    // DEPOSITS
    // =========================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        plan_id INT NOT NULL,
        amount DECIMAL(18,2) NOT NULL,
        wallet VARCHAR(255) NOT NULL,
        txid VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'Pending',
        daily_gain DECIMAL(18,2) DEFAULT 0.00,
        total_earned DECIMAL(18,2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_updated DATETIME NULL,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (plan_id) REFERENCES plans(id)
      )
    `);

    console.log("✅ deposits table ready");

    // =========================
    // REFERRALS
    // =========================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        referred_user_id INT NOT NULL,
        referrer_id INT NOT NULL,
        side VARCHAR(10) NOT NULL,
        level INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (referred_user_id) REFERENCES users(id),
        FOREIGN KEY (referrer_id) REFERENCES users(id)
      )
    `);

    console.log("✅ referrals table ready");

    // =========================
    // WITHDRAWALS
    // =========================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount DECIMAL(18,2) NOT NULL,
        wallet VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    console.log("✅ withdrawals table ready");

    // =========================
    // PLANS DATA
    // =========================
    await pool.query(`
      INSERT INTO plans
        (id, name, min_amount_usd, daily_return)
      VALUES
        (1, 'Bronze', 15.00, 1.30),
        (2, 'Silver', 25.00, 1.70),
        (3, 'Gold', 50.00, 3.07),
        (4, 'Platinum', 100.00, 5.61),
        (5, 'Diamond', 200.00, 9.97),
        (6, 'Ruby', 400.00, 17.37),
        (7, 'Emerald', 500.00, 22.42),
        (8, 'Titanium', 1000.00, 41.72)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        min_amount_usd = VALUES(min_amount_usd),
        daily_return = VALUES(daily_return)
    `);

    console.log("✅ plans data inserted/updated");

    // =========================
    // SHOW TABLES
    // =========================
    const [tables] = await pool.query("SHOW TABLES");

    console.log("\n📋 Tables currently in the database:");

    for (const table of tables) {
      console.log(" -", Object.values(table)[0]);
    }

    console.log("\n🎉 Stonebridge database setup complete!");

    await pool.end();
    process.exit(0);

  } catch (error) {
    console.error("\n❌ DATABASE SETUP FAILED");
    console.error(error);

    await pool.end();
    process.exit(1);
  }
}

setupDatabase();