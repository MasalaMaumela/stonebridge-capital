require("dotenv").config();
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const pool = require("./database"); // MySQL pool
const bcrypt = require("bcrypt");
const expressLayouts = require("express-ejs-layouts");
const crypto = require("crypto");
const MySQLStore = require("express-mysql-session")(session);
const app = express();
const PORT = process.env.PORT || 8080;

// --- EJS setup ---

// --- MySQL Session Store ---
const options = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

const sessionStore = new MySQLStore(options);

app.use(
  session({
    key: "sb_sid", // cookie name
    secret: process.env.SESSION_SECRET || "secretkey",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 day
  })
);

// --- Auth Middleware ---
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/login");
}

function ensureAdmin(req, res, next) {
  if (req.session.user && req.session.user.isAdmin) return next();
  res.redirect("/login");
}

// --- Static Plans ---
const plans = [
  { id: 1, name: "Bronze", min_amount_usd: 15, daily_return: 1.3, weekly_return: 9.1, monthly_return: 36.41 },
  { id: 2, name: "Silver", min_amount_usd: 25, daily_return: 1.7, weekly_return: 12.13, monthly_return: 48.55 },
  { id: 3, name: "Gold", min_amount_usd: 50, daily_return: 3.07, weekly_return: 21.5, monthly_return: 86.7 },
  { id: 4, name: "Platinum", min_amount_usd: 100, daily_return: 5.61, weekly_return: 39.3, monthly_return: 157.21 },
  { id: 5, name: "Diamond", min_amount_usd: 200, daily_return: 9.97, weekly_return: 69.83, monthly_return: 279.3 },
  { id: 6, name: "Ruby", min_amount_usd: 400, daily_return: 17.37, weekly_return: 121.6, monthly_return: 486.4 },
  { id: 7, name: "Emerald", min_amount_usd: 500, daily_return: 22.42, weekly_return: 157, monthly_return: 628 },
  { id: 8, name: "Titanium", min_amount_usd: 1000, daily_return: 41.72, weekly_return: 292.1, monthly_return: 1168.4 },
];

// --- Helper Functions ---
async function generateReferralCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function getLevelAndBonus(smallestSideAmount) {
  if (smallestSideAmount >= 150) return { level: 3, bonusPercent: 0.15 };
  if (smallestSideAmount >= 100) return { level: 2, bonusPercent: 0.08 };
  if (smallestSideAmount >= 50) return { level: 1, bonusPercent: 0.04 };
  return { level: 0, bonusPercent: 0 };
}

// --- ROUTES ---
app.get("/", (req, res) => res.redirect("/login"));

// Login / Register Pages
app.get("/login", (req, res) => res.render("login", { error: null, message: null, user: req.session.user }));
app.get("/register", (req, res) =>
  res.render("register", { error: null, message: null, referral: req.query.ref || "", user: req.session.user })
);

// --- REGISTER POST ---
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

    // --- Handle 3-Level Referral System ---
    if (referral) {
      const [[referrer]] = await pool.query("SELECT id FROM users WHERE referral_code = ?", [referral]);
      if (referrer) {
        await pool.query("INSERT INTO referrals (user_id, referrer_id, side, level) VALUES (?,?,?,?)", [
          newUserId,
          referrer.id,
          "A",
          1,
        ]);

        const [[secondLevel]] = await pool.query("SELECT referrer_id FROM referrals WHERE user_id = ?", [referrer.id]);
        if (secondLevel && secondLevel.referrer_id) {
          await pool.query("INSERT INTO referrals (user_id, referrer_id, side, level) VALUES (?,?,?,?)", [
            newUserId,
            secondLevel.referrer_id,
            "B",
            2,
          ]);

          const [[thirdLevel]] = await pool.query("SELECT referrer_id FROM referrals WHERE user_id = ?", [
            secondLevel.referrer_id,
          ]);
          if (thirdLevel && thirdLevel.referrer_id) {
            await pool.query("INSERT INTO referrals (user_id, referrer_id, side, level) VALUES (?,?,?,?)", [
              newUserId,
              thirdLevel.referrer_id,
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

// --- LOGIN POST ---
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    // Hardcoded admin
    if (email === "stonebridge499@gmail.com" && password === "Agrippine2017") {
      req.session.user = { id: 0, email, username: "Admin", isAdmin: true, balance: 0 };
      return res.redirect("/admin");
    }

    // Normal users
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

// --- DASHBOARD ---
app.get("/dashboard", ensureAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [userRows] = await pool.query(
      "SELECT id, name AS username, email, wallet_address AS wallet, balance, referral_code FROM users WHERE id = ?",
      [userId]
    );
    if (!userRows.length) return res.redirect("/login");

    let user = userRows[0];
    user.balance = Number(user.balance || 0);
    user.referral_link = `${process.env.BASE_URL}/register?ref=${user.referral_code}`;

    const [deposits] = await pool.query(
      `SELECT d.id, d.amount, d.wallet, d.txid, d.status, p.name AS plan_name, p.daily_return, p.weekly_return, p.monthly_return
       FROM deposits d
       LEFT JOIN plans p ON d.plan_id = p.id
       WHERE d.user_id = ?
       ORDER BY d.id DESC`,
      [userId]
    );

    const depositsWithGains = (deposits || []).map((dep) => ({
      ...dep,
      daily_gain: Number(dep.daily_return || 0),
      weekly_gain: Number(dep.weekly_return || 0),
      monthly_gain: Number(dep.monthly_return || 0),
    }));

    const totalMonthlyGain = depositsWithGains.reduce((sum, d) => sum + d.monthly_gain, 0);
    user.balance += totalMonthlyGain;

    const [referrals] = await pool.query(
      `SELECT r.*, u.name AS referred_name, u.email AS referred_email
       FROM referrals r
       LEFT JOIN users u ON r.referred_user_id = u.id
       WHERE r.referrer_id = ?
       ORDER BY r.side, r.id ASC`,
      [userId]
    );

    const sideTotals = { A: 0, B: 0 };
    (referrals || []).forEach((r) => {
      const amount = Number(r.matched_amount || 0);
      const side = (r.side || "").toUpperCase();
      if (side === "A" || side === "B") sideTotals[side] += amount;
    });

    const smallestSide = Math.min(sideTotals.A, sideTotals.B);
    const { level, bonusPercent } = getLevelAndBonus(smallestSide);
    const matchingBonus = smallestSide * bonusPercent;

    user.sideTotals = sideTotals;
    user.matchedLevel = level;
    user.matchingBonus = matchingBonus.toFixed(2);

    const referralsA = (referrals || []).filter((r) => (r.side || "").toUpperCase() === "A");
    const referralsB = (referrals || []).filter((r) => (r.side || "").toUpperCase() === "B");

    res.render("dashboard", { user, deposits: depositsWithGains, referralsA, referralsB });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).send("Error loading dashboard");
  }
});

// --- ADMIN DASHBOARD ---
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

// --- LOGOUT ---
app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// --- DEPOSIT ---
app.get("/deposit", ensureAuth, (req, res) => res.render("deposit", { user: req.session.user, plans }));
app.post("/deposit", ensureAuth, async (req, res) => {
  try {
    const { plan_id, amount, wallet, txid } = req.body;
    const userId = req.session.user.id;
    if (!plan_id || !amount || !wallet || !txid)
      return res.render("deposit", { user: req.session.user, plans, error: "All fields required" });

    await pool.query(
      "INSERT INTO deposits (user_id, plan_id, amount, wallet, txid, status) VALUES (?,?,?,?,?,?)",
      [userId, plan_id, amount, wallet, txid, "Pending"]
    );
    res.redirect("/dashboard");
  } catch (err) {
    console.error(err);
    res.render("deposit", { user: req.session.user, plans, error: "Server error" });
  }
});

// --- WITHDRAW ---
app.get("/withdraw", ensureAuth, (req, res) => res.render("withdraw", { user: req.session.user }));
app.post("/withdraw", ensureAuth, async (req, res) => {
  try {
    const { amount, wallet } = req.body;
    const userId = req.session.user.id;
    if (!amount || !wallet) return res.render("withdraw", { user: req.session.user, error: "All fields required" });

    await pool.query("INSERT INTO withdrawals (user_id, amount, wallet, status) VALUES (?,?,?,?)", [
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

// --- SERVER ---
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
