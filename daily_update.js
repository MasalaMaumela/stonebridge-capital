// daily_update.js
const db = require("./database");

(async function run() {
  try {
    const [investments] = await db.query("SELECT * FROM investments WHERE active = 1");
    for (const inv of investments) {
      const amount = parseFloat(inv.amount);
      let reward = 0;

      // Tiers (interpretation): thresholds are minimums
      if (amount >= 800) reward = 240;
      else if (amount >= 700) reward = 180;
      else if (amount >= 600) reward = 130;
      else if (amount >= 500) reward = 110;
      else if (amount >= 400) reward = 80;
      else if (amount >= 200) reward = 40;
      else if (amount >= 100) reward = 20;
      else if (amount >= 50) reward = 10;
      else if (amount >= 25) reward = 5;
      else if (amount >= 15) {
        // award 3 every 2 days (we award on odd days starting day=1)
        reward = (inv.day % 2 === 1) ? 3 : 0;
      }

      // add reward
      if (reward > 0) {
        await db.query("UPDATE investments SET total_earned = total_earned + ?, day = day + 1 WHERE id = ?", [reward, inv.id]);
        await db.query("UPDATE users SET balance = balance + ? WHERE id = ?", [reward, inv.user_id]);
      } else {
        // still increment day if reward = 0 (for 15 tier off-day)
        await db.query("UPDATE investments SET day = day + 1 WHERE id = ?", [inv.id]);
      }

      // fetch new day value to check completion (or calculate by inv.day + 1)
      const newDay = (inv.day || 1) + 1;
      if (newDay > 30) {
        await db.query("UPDATE investments SET active = 0 WHERE id = ?", [inv.id]);
      }
    }

    console.log("✅ Daily update complete.");
    process.exit(0);
  } catch (err) {
    console.error("Daily update error:", err);
    process.exit(1);
  }
})();
