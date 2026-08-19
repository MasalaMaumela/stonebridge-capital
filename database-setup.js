// database-setup.js
require("dotenv").config();

const pool = require("./database");

async function setupDatabase() {
  try {
    console.log("🔄 Recreating Stonebridge database tables...");

    // =====================================================
    // REMOVE OLD TABLES
    // =====================================================

    await pool.query("SET FOREIGN_KEY_CHECKS = 0");

    await pool.query("DROP TABLE IF EXISTS referrals");
    await pool.query("DROP TABLE IF EXISTS withdrawals");
    await pool.query("DROP TABLE IF EXISTS deposits");
    await pool.query("DROP TABLE IF EXISTS plans");
    await pool.query("DROP TABLE IF EXISTS users");

    await pool.query("SET FOREIGN_KEY_CHECKS = 1");

    console.log("🗑️ Old tables removed");

    // =====================================================
    // USERS
    // =====================================================

    await pool.query(`
      CREATE TABLE users (
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

    console.log("✅ users table created");

    // =====================================================
    // PLANS
    // =====================================================

    await pool.query(`
      CREATE TABLE plans (
        id INT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        min_amount_zar DECIMAL(18,2) NOT NULL,
        daily_return DECIMAL(18,2) NOT NULL
      )
    `);

    console.log("✅ plans table created");

    // =====================================================
    // DEPOSITS
    // =====================================================

    await pool.query(`
      CREATE TABLE deposits (
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

    console.log("✅ deposits table created");

    // =====================================================
    // REFERRALS
    // =====================================================

    await pool.query(`
      CREATE TABLE referrals (
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

    console.log("✅ referrals table created");

    // =====================================================
    // WITHDRAWALS
    // =====================================================

    await pool.query(`
      CREATE TABLE withdrawals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount DECIMAL(18,2) NOT NULL,
        wallet VARCHAR(255) NOT NULL,
        status VARCHAR(50) DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    console.log("✅ withdrawals table created");

    // =====================================================
    // INSERT 7 ZAR PLANS
    // =====================================================

    await pool.query(`
      INSERT INTO plans
        (id, name, min_amount_zar, daily_return)
      VALUES
        (1, 'Bronze', 300.00, 12.00),
        (2, 'Silver', 900.00, 20.00),
        (3, 'Gold', 1500.00, 40.00),
        (4, 'Platinum', 2500.00, 77.00),
        (5, 'Diamond', 5000.00, 200.00),
        (6, 'Ruby', 8000.00, 300.00),
        (7, 'Emerald', 12000.00, 400.00)
    `);

    console.log("✅ 7 ZAR plans inserted");

    // =====================================================
    // SHOW TABLES
    // =====================================================

    const [tables] = await pool.query("SHOW TABLES");

    console.log("\n📋 Tables currently in database:");

    for (const table of tables) {
      console.log(" -", Object.values(table)[0]);
    }

    // =====================================================
    // SHOW PLANS
    // =====================================================

    const [plans] = await pool.query(`
      SELECT id, name, min_amount_zar, daily_return
      FROM plans
      ORDER BY id
    `);

    console.log("\n💰 Current ZAR plans:");

    for (const plan of plans) {
      console.log(
        ` - ${plan.id}. ${plan.name}: Minimum R${plan.min_amount_zar}, Daily R${plan.daily_return}`
      );
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