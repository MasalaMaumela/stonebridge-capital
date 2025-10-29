// fix_deposits.js — Correct total_earned & user balances
require("dotenv").config();
const pool = require("./database"); // Your MySQL pool

async function fixDeposits() {
  try {
    const [deposits] = await pool.query(`
      SELECT d.id, d.user_id, d.plan_id, d.total_earned, d.last_updated, d.created_at, d.status,
             p.daily_return
      FROM deposits d
      JOIN plans p ON d.plan_id = p.id
      WHERE d.status = 'Active'
    `);

    for (const dep of deposits) {
      const now = new Date();
      const lastUpdated = dep.last_updated ? new Date(dep.last_updated) : new Date(dep.created_at);
      const daysPassed = Math.floor((now - lastUpdated) / (1000 * 60 * 60 * 24)) || 0;

      const gain = dep.daily_return * daysPassed;

      // Update deposit's total_earned and last_updated
      await pool.query(
        `UPDATE deposits 
         SET total_earned = IFNULL(total_earned, 0) + ?, 
             last_updated = NOW()
         WHERE id = ?`,
        [gain, dep.id]
      );

      // Update user's balance
      if (gain > 0) {
        await pool.query(
          `UPDATE users 
           SET balance = balance + ? 
           WHERE id = ?`,
          [gain, dep.user_id]
        );
      }

      console.log(`✅ Deposit ${dep.id} corrected: +$${gain.toFixed(2)} for user ${dep.user_id}`);
    }

    console.log("🎯 All active deposits fixed successfully.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error fixing deposits:", err);
    process.exit(1);
  }
}

fixDeposits();
