// ========================================================
// server.js — Stonebridge Capital
// ========================================================

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const pool = require("./database"); // MySQL pool (with SSL)
const bcrypt = require("bcrypt");
const expressLayouts = require("express-ejs-layouts");
const crypto = require("crypto");
const MySQLStore = require("express-mysql-session")(session);
const fs = require("fs");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 8080;

// ---------------------- EJS setup ----------------------
app.set("view engine", "ejs");
app.set("views", __dirname + "/views");
app.use(expressLayouts);
app.use(express.static("public"));

// ---------------------- Middleware ----------------------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

// ---------------------- MySQL Session Store ----------------------
let sessionStoreOptions = {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
};
if (process.env.DB_SSL_CA && fs.existsSync(process.env.DB_SSL_CA)) {
  sessionStoreOptions.ssl = { ca: fs.readFileSync(process.env.DB_SSL_CA) };
}
const sessionStore = new MySQLStore(sessionStoreOptions);

app.use(
  session({
    key: "sb_sid",
    secret: process.env.SESSION_SECRET || "secretkey",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

// ---------------------- Auth Middleware ----------------------
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/login");
}
function ensureAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.redirect("/login");
}

// ---------------------- Static Plans ----------------------
// daily_return here is treated as fixed USD per day (not percent)
const plans = [
  { id: 1, name: "Bronze", min_amount_usd: 15, daily_return: 1.3 },
  { id: 2, name: "Silver", min_amount_usd: 25, daily_return: 1.7 },
  { id: 3, name: "Gold", min_amount_usd: 50, daily_return: 3.07 },
  { id: 4, name: "Platinum", min_amount_usd: 100, daily_return: 5.61 },
  { id: 5, name: "Diamond", min_amount_usd: 200, daily_return: 9.97 },
  { id: 6, name: "Ruby", min_amount_usd: 400, daily_return: 17.37 },
  { id: 7, name: "Emerald", min_amount_usd: 500, daily_return: 22.42 },
  { id: 8, name: "Titanium", min_amount_usd: 1000, daily_return: 41.72 },
];

// ---------------------- Helper Functions ----------------------
async function generateReferralCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

// referral percents (one-time, based on deposit amount)
function getReferralPercent(level) {
  if (level === 1) return 0.03; // 3%
  if (level === 2) return 0.05; // 5%
  if (level === 3) return 0.10; // 10%
  return 0;
}

// matching percents (one-time, based on deposit amount)
function getMatchPercent(level) {
  if (level === 1) return 0.04; // 4%
  if (level === 2) return 0.08; // 8%
  if (level === 3) return 0.15; // 15%
  return 0;
}

// =======================================================
// ACTIVATE DEPOSIT (ON ADMIN APPROVAL)
// - marks deposit Active (if not already active)
// - DOES NOT add deposit.amount to user's balance (per request)
// - pays one-time referral bonuses and one-time match bonuses (based on deposit.amount)
// =======================================================
async function activateDeposit(depositId) {
  try {
    const [rows] = await pool.query("SELECT * FROM deposits WHERE id = ?", [depositId]);
    if (!rows.length) return;
    const dep = rows[0];

    // already active? do nothing
    if (dep.status === "Active") {
      console.log(`Deposit ${depositId} already active - skipping activation.`);
      return;
    }

    // mark Active and set last_updated
    await pool.query("UPDATE deposits SET status = 'Active', last_updated = NOW() WHERE id = ?", [depositId]);
    console.log(`✅ Deposit ${depositId} marked Active.`);

    // fetch referrals (upline entries) for this referred_user_id
    const [referrals] = await pool.query("SELECT * FROM referrals WHERE referred_user_id = ?", [dep.user_id]);

    // Pay one-time referral and match bonuses to each referrer in the chain (if present)
    for (const ref of referrals) {
      const refPercent = getReferralPercent(ref.level);
      const matchPercent = getMatchPercent(ref.level);

      if (refPercent > 0) {
        const refBonus = dep.amount * refPercent;
        await pool.query("UPDATE users SET balance = balance + ? WHERE id = ?", [refBonus, ref.referrer_id]);
        console.log(`🎁 Referral bonus $${refBonus.toFixed(2)} -> referrer ${ref.referrer_id} (level ${ref.level})`);
      }

      if (matchPercent > 0) {
        const matchBonus = dep.amount * matchPercent;
        await pool.query("UPDATE users SET balance = balance + ? WHERE id = ?", [matchBonus, ref.referrer_id]);
        console.log(`🎯 Match bonus $${matchBonus.toFixed(2)} -> referrer ${ref.referrer_id} (level ${ref.level})`);
      }
    }

    console.log(`✅ Deposit ${depositId} activated and one-time bonuses paid (if applicable).`);
  } catch (err) {
    console.error("activateDeposit error:", err);
    throw err;
  }
}

// =======================================================
// ROUTES
// =======================================================
app.get("/", (req, res) => res.redirect("/login"));
app.get("/login", (req, res) => res.render("login", { error: null, message: null, user: req.session.user }));
app.get("/register", (req, res) =>
  res.render("register", { error: null, message: null, referral: req.query.ref || "", user: req.session.user })
);

// ---------------------- REGISTER ----------------------
app.post("/register", async (req, res) => {
  const { name, email, password, wallet, referral } = req.body;
  try {
    if (!name || !email || !password || !wallet)
      return res.render("register", { error: "All fields are required", message: null, referral, user: req.session.user });

    const [exists] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if (exists.length)
      return res.render("register", { error: "Email already registered", message: null, referral, user: req.session.user });

    const hash = await bcrypt.hash(password, 10);
    const referralCode = await generateReferralCode();

    const [result] = await pool.query(
      "INSERT INTO users (name,email,password,wallet_address,balance,referral_code) VALUES (?,?,?,?,?,?)",
      [name, email, hash, wallet, 0, referralCode]
    );
    const newUserId = result.insertId;

    // --- 3-Level referral tracking (no bonuses on registration; bonuses apply on deposit activation) ---
    if (referral) {
      const [[referrer]] = await pool.query("SELECT id FROM users WHERE referral_code = ?", [referral]);
      if (referrer) {
        await pool.query("INSERT INTO referrals (referred_user_id, referrer_id, side, level) VALUES (?,?,?,?)", [
          newUserId,
          referrer.id,
          "A",
          1,
        ]);

        const [[second]] = await pool.query("SELECT referrer_id FROM referrals WHERE referred_user_id = ?", [referrer.id]);
        if (second && second.referrer_id) {
          await pool.query("INSERT INTO referrals (referred_user_id, referrer_id, side, level) VALUES (?,?,?,?)", [
            newUserId,
            second.referrer_id,
            "B",
            2,
          ]);

          const [[third]] = await pool.query("SELECT referrer_id FROM referrals WHERE referred_user_id = ?", [
            second.referrer_id,
          ]);
          if (third && third.referrer_id) {
            await pool.query("INSERT INTO referrals (referred_user_id, referrer_id, side, level) VALUES (?,?,?,?)", [
              newUserId,
              third.referrer_id,
              "A",
              3,
            ]);
          }
        }
      }
    }

    res.render("login", { error: null, message: "Registered successfully, login now", user: req.session.user });
  } catch (err) {
    console.error(err);
    res.render("register", { error: "Server error", message: null, referral, user: req.session.user });
  }
});

// ---------------------- LOGIN ----------------------
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      req.session.user = { id: 0, email, username: "Admin", isAdmin: true, balance: 0 };
      return res.redirect("/admin");
    }

    const [rows] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
    if (!rows.length)
      return res.render("login", { error: "Invalid credentials", message: null, user: req.session.user });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.render("login", { error: "Invalid credentials", message: null, user: req.session.user });

    req.session.user = {
      id: user.id,
      username: user.name || user.email,
      email: user.email,
      wallet: user.wallet_address,
      balance: Number(user.balance) || 0,
      referral_code: user.referral_code,
      isAdmin: false,
    };
    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.render("login", { error: "Server error", message: null, user: req.session.user });
  }
});

// ---------------------- DASHBOARD ----------------------
app.get("/dashboard", ensureAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [userRows] = await pool.query(
      "SELECT id, name AS username, email, wallet_address AS wallet, balance, referral_code FROM users WHERE id = ?",
      [userId]
    );
    if (!userRows.length) return res.redirect("/login");
    const user = userRows[0];

    user.balance = Number(user.balance || 0);
    user.referral_link = `${process.env.APP_URL}/register?ref=${user.referral_code}`;

    const [deposits] = await pool.query(
      `SELECT d.*, p.name AS plan_name
       FROM deposits d
       LEFT JOIN plans p ON d.plan_id = p.id
       WHERE d.user_id = ?
       ORDER BY d.id DESC`,
      [userId]
    );

    const [referrals] = await pool.query(
      `SELECT r.*, u.name AS referred_name, u.email AS referred_email
       FROM referrals r
       LEFT JOIN users u ON r.referred_user_id = u.id
       WHERE r.referrer_id = ?
       ORDER BY r.side, r.id ASC`,
      [userId]
    );

    const referralsA = referrals.filter((r) => (r.side || "").toUpperCase() === "A");
    const referralsB = referrals.filter((r) => (r.side || "").toUpperCase() === "B");

    res.render("dashboard", { user, deposits, referralsA, referralsB });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Error loading dashboard");
  }
});

// ---------------------- ADMIN ----------------------
app.get("/admin", ensureAdmin, async (req, res) => {
  try {
    const [users] = await pool.query("SELECT * FROM users");
    const [deposits] = await pool.query(
      `SELECT d.*, u.name AS user_name, u.email AS user_email, p.name AS plan_name
       FROM deposits d
       LEFT JOIN users u ON d.user_id = u.id
       LEFT JOIN plans p ON d.plan_id = p.id
       ORDER BY d.id DESC`
    );
    const [withdrawals] = await pool.query(
      `SELECT w.*, u.name AS user_name, u.email AS user_email
       FROM withdrawals w
       LEFT JOIN users u ON w.user_id = u.id
       ORDER BY w.id DESC`
    );
    const [referrals] = await pool.query(
      `SELECT r.*, u1.name AS referrer_name, u2.name AS referred_name, u2.email AS referred_email
       FROM referrals r
       LEFT JOIN users u1 ON r.referrer_id = u1.id
       LEFT JOIN users u2 ON r.referred_user_id = u2.id
       ORDER BY r.referrer_id, r.side, r.id ASC`
    );

    res.render("admin", { user: req.session.user, users, deposits, withdrawals, referrals });
  } catch (err) {
    console.error("Admin error:", err);
    res.status(500).send("Error loading admin dashboard");
  }
});

// ---------------------- Admin Deposit Approval ----------------------
app.post("/admin/deposit/:id/:action", ensureAdmin, async (req, res) => {
  try {
    const { id, action } = req.params;
    if (!["approve", "reject"].includes(action)) return res.status(400).send("Invalid action");

    if (action === "approve") {
      // activateDeposit will check status and only run once per deposit
      await activateDeposit(id);
    } else {
      await pool.query("UPDATE deposits SET status = 'Rejected' WHERE id = ?", [id]);
    }

    res.redirect("/admin");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating deposit");
  }
});

// ---------------------- Admin Withdraw Approval ----------------------
app.post("/admin/withdraw/:id/:action", ensureAdmin, async (req, res) => {
  try {
    const { id, action } = req.params;
    if (!["approve", "reject"].includes(action)) return res.status(400).send("Invalid action");

    const status = action === "approve" ? "Approved" : "Rejected";
    await pool.query("UPDATE withdrawals SET status = ? WHERE id = ?", [status, id]);
    res.redirect("/admin");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating withdrawal");
  }
});

// ---------------------- Deposit / Withdraw ----------------------
app.get("/deposit", ensureAuth, (req, res) => res.render("deposit", { user: req.session.user, plans }));
app.post("/deposit", ensureAuth, async (req, res) => {
  try {
    const { plan_id, amount, wallet, txid } = req.body;
    const userId = req.session.user.id;
    if (!plan_id || !amount || !wallet || !txid)
      return res.render("deposit", { user: req.session.user, plans, error: "All fields required" });

    await pool.query(
      "INSERT INTO deposits (user_id, plan_id, amount, wallet, txid, status, created_at) VALUES (?,?,?,?,?,?,NOW())",
      [userId, plan_id, amount, wallet, txid, "Pending"]
    );

    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.render("deposit", { user: req.session.user, plans, error: "Server error" });
  }
});

app.get("/withdraw", ensureAuth, (req, res) => res.render("withdraw", { user: req.session.user }));
app.post("/withdraw", ensureAuth, async (req, res) => {
  try {
    const { amount, wallet } = req.body;
    const userId = req.session.user.id;
    if (!amount || !wallet) return res.render("withdraw", { user: req.session.user, error: "All fields required" });

    await pool.query("INSERT INTO withdrawals (user_id, amount, wallet, status, created_at) VALUES (?,?,?,?,NOW())", [
      userId,
      amount,
      wallet,
      "Pending",
    ]);
    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.render("withdraw", { user: req.session.user, error: "Server error" });
  }
});

// =======================================================
// 🕒 Cron Job — Runs every minute, adds daily USD gain (fixed)
// =======================================================
cron.schedule("* * * * *", async () => {
  console.log("⏳ Running daily gains updater...");
  try {
    const [deposits] = await pool.query(`
      SELECT id, user_id, amount, status, plan_id, last_updated
      FROM deposits
      WHERE status = 'Active'
    `);

    const now = new Date();

    for (const dep of deposits) {
      const [plan] = await pool.query("SELECT daily_return FROM plans WHERE id = ?", [dep.plan_id]);
      if (!plan.length) continue;

      const dailyGainUSD = plan[0].daily_return; // fixed USD/day
      const lastUpdated = dep.last_updated ? new Date(dep.last_updated) : null;
      const daysPassed = lastUpdated ? Math.floor((now - lastUpdated) / (1000 * 60 * 60 * 24)) : 1;

      if (daysPassed >= 1) {
        const gain = dailyGainUSD * daysPassed;

        // update deposit totals
        await pool.query(
          `UPDATE deposits 
           SET daily_gain = ?, total_earned = IFNULL(total_earned, 0) + ?, last_updated = ? 
           WHERE id = ?`,
          [dailyGainUSD, gain, now, dep.id]
        );

        // add gain to user's balance
        await pool.query("UPDATE users SET balance = balance + ? WHERE id = ?", [gain, dep.user_id]);
        console.log(`✅ Added $${gain.toFixed(2)} gain to user ${dep.user_id}`);
      }
    }

    console.log("✅ Daily gains update complete.");
  } catch (err) {
    console.error("❌ Error updating gains:", err);
  }
});

// =======================================================SELECT * FROM deposits;
// SERVER START
// =======================================================
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
