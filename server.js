// ========================================================
// server.js — Stonebridge Capital
// ========================================================

require("dotenv").config();

const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const pool = require("./database");
const bcrypt = require("bcrypt");
const expressLayouts = require("express-ejs-layouts");
const crypto = require("crypto");
const MySQLStore = require("express-mysql-session")(session);
const fs = require("fs");
const cron = require("node-cron");

const app = express();

const PORT = process.env.PORT || 8080;


// ========================================================
// EJS
// ========================================================

app.set("view engine", "ejs");

app.set(
  "views",
  __dirname + "/views"
);

app.use(expressLayouts);

app.use(express.static("public"));


// ========================================================
// MIDDLEWARE
// ========================================================

app.use(
  bodyParser.urlencoded({
    extended: true
  })
);

app.use(express.json());


// ========================================================
// MYSQL SESSION
// ========================================================

const sessionStoreOptions = {

  host: process.env.DB_HOST,

  port:
    Number(process.env.DB_PORT) ||
    3306,

  user: process.env.DB_USER,

  password: process.env.DB_PASS,

  database: process.env.DB_NAME

};


if (
  process.env.DB_SSL_CA &&
  fs.existsSync(process.env.DB_SSL_CA)
) {

  sessionStoreOptions.ssl = {
    ca: fs.readFileSync(
      process.env.DB_SSL_CA
    )
  };

}


const sessionStore =
  new MySQLStore(
    sessionStoreOptions
  );


app.use(
  session({

    key: "sb_sid",

    secret:
      process.env.SESSION_SECRET ||
      "secretkey",

    store: sessionStore,

    resave: false,

    saveUninitialized: false,

    cookie: {

      maxAge:
        1000 *
        60 *
        60 *
        24

    }

  })
);


// ========================================================
// AUTH
// ========================================================

function ensureAuth(req, res, next) {

  if (req.session.user) {
    return next();
  }

  res.redirect("/login");

}


function ensureAdmin(req, res, next) {

  if (
    req.session.user &&
    req.session.user.isAdmin
  ) {

    return next();

  }

  res.redirect("/login");

}


// ========================================================
// INVESTMENT PLANS
// ========================================================

const plans = [

  {
    id: 1,
    name: "Bronze",
    min_amount_zar: 300,
    daily_return: 12
  },

  {
    id: 2,
    name: "Silver",
    min_amount_zar: 900,
    daily_return: 20
  },

  {
    id: 3,
    name: "Gold",
    min_amount_zar: 1500,
    daily_return: 40
  },

  {
    id: 4,
    name: "Platinum",
    min_amount_zar: 2500,
    daily_return: 77
  },

  {
    id: 5,
    name: "Diamond",
    min_amount_zar: 5000,
    daily_return: 200
  },

  {
    id: 6,
    name: "Ruby",
    min_amount_zar: 8000,
    daily_return: 300
  },

  {
    id: 7,
    name: "Emerald",
    min_amount_zar: 12000,
    daily_return: 400
  }

];


// ========================================================
// REFERRAL HELPERS
// ========================================================

async function generateReferralCode() {

  return crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();

}


function getReferralPercent(level) {

  if (level === 1) return 0.03;

  if (level === 2) return 0.05;

  if (level === 3) return 0.10;

  return 0;

}


function getMatchPercent(level) {

  if (level === 1) return 0.04;

  if (level === 2) return 0.08;

  if (level === 3) return 0.15;

  return 0;

}


// ========================================================
// ACTIVATE DEPOSIT
//
// IMPORTANT:
// The original investment amount is NOT added to balance.
//
// When admin activates a deposit:
// 1. Deposit becomes Active.
// 2. First daily gain is awarded immediately.
// 3. Investment amount remains the investment amount.
// 4. Future gains are awarded once per day.
// ========================================================

async function activateDeposit(depositId) {

  const connection =
    await pool.getConnection();

  try {

    await connection.beginTransaction();


    const [rows] =
      await connection.query(
        `
        SELECT
          d.*,
          p.daily_return
        FROM deposits d
        LEFT JOIN plans p
          ON d.plan_id = p.id
        WHERE d.id = ?
        FOR UPDATE
        `,
        [depositId]
      );


    if (!rows.length) {

      await connection.rollback();

      return;

    }


    const dep = rows[0];


    if (dep.status === "Active") {

      await connection.rollback();

      console.log(
        `Deposit ${depositId} already active - skipping activation.`
      );

      return;

    }


    if (dep.status === "Rejected") {

      await connection.rollback();

      console.log(
        `Deposit ${depositId} is rejected - cannot activate.`
      );

      return;

    }


    const dailyGain =
      Number(dep.daily_return || 0);


    // ====================================================
    // ACTIVATE DEPOSIT
    // ====================================================

    await connection.query(
      `
      UPDATE deposits

      SET
        status = 'Active',
        daily_gain = ?,
        total_earned = ?,
        last_updated = NOW()

      WHERE id = ?
      `,
      [
        dailyGain,
        dailyGain,
        depositId
      ]
    );


    // ====================================================
    // AWARD FIRST DAILY GAIN IMMEDIATELY
    //
    // IMPORTANT:
    // Only daily gain is added.
    // The investment amount is NOT added.
    // ====================================================

    if (dailyGain > 0) {

      await connection.query(
        `
        UPDATE users

        SET balance =
          balance + ?

        WHERE id = ?
        `,
        [
          dailyGain,
          dep.user_id
        ]
      );

    }


    console.log(
      `✅ Deposit ${depositId} activated. First daily gain R${dailyGain.toFixed(2)} awarded to user ${dep.user_id}.`
    );


    // ====================================================
    // REFERRAL BONUSES
    // ====================================================

    const [referrals] =
      await connection.query(
        `
        SELECT *
        FROM referrals
        WHERE referred_user_id = ?
        `,
        [dep.user_id]
      );


    for (const ref of referrals) {

      const refPercent =
        getReferralPercent(
          Number(ref.level)
        );


      const matchPercent =
        getMatchPercent(
          Number(ref.level)
        );


      // -----------------------------------------------
      // REFERRAL BONUS
      // -----------------------------------------------

      if (refPercent > 0) {

        const refBonus =
          Number(dep.amount) *
          refPercent;


        await connection.query(
          `
          UPDATE users

          SET balance =
            balance + ?

          WHERE id = ?
          `,
          [
            refBonus,
            ref.referrer_id
          ]
        );


        console.log(
          `🎁 Referral bonus R${refBonus.toFixed(2)} -> referrer ${ref.referrer_id}`
        );

      }


      // -----------------------------------------------
      // MATCH BONUS
      // -----------------------------------------------

      if (matchPercent > 0) {

        const matchBonus =
          Number(dep.amount) *
          matchPercent;


        await connection.query(
          `
          UPDATE users

          SET balance =
            balance + ?

          WHERE id = ?
          `,
          [
            matchBonus,
            ref.referrer_id
          ]
        );


        console.log(
          `🎯 Match bonus R${matchBonus.toFixed(2)} -> referrer ${ref.referrer_id}`
        );

      }

    }


    await connection.commit();


    console.log(
      `✅ Deposit ${depositId} fully activated.`
    );


  } catch (err) {

    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error(
        "Rollback error:",
        rollbackError
      );
    }

    console.error(
      "activateDeposit error:",
      err
    );

    throw err;

  } finally {

    connection.release();

  }

}


// ========================================================
// HOME
// ========================================================

app.get("/", (req, res) => {

  res.redirect("/login");

});


// ========================================================
// LOGIN PAGE
// ========================================================

app.get("/login", (req, res) => {

  res.render(
    "login",
    {
      error: null,
      message: null,
      user: req.session.user
    }
  );

});


// ========================================================
// REGISTER PAGE
// ========================================================

app.get("/register", (req, res) => {

  res.render(
    "register",
    {
      error: null,
      message: null,
      referral:
        req.query.ref || "",
      user:
        req.session.user
    }
  );

});


// ========================================================
// REGISTER
// ========================================================

app.post(
  "/register",
  async (req, res) => {

    const {
      name,
      email,
      password,
      wallet,
      referral
    } = req.body;


    try {

      if (
        !name ||
        !email ||
        !password ||
        !wallet
      ) {

        return res.render(
          "register",
          {
            error:
              "All fields are required",
            message: null,
            referral,
            user:
              req.session.user
          }
        );

      }


      const [exists] =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE email = ?
          `,
          [email]
        );


      if (exists.length) {

        return res.render(
          "register",
          {
            error:
              "Email already registered",
            message: null,
            referral,
            user:
              req.session.user
          }
        );

      }


      const hash =
        await bcrypt.hash(
          password,
          10
        );


      const referralCode =
        await generateReferralCode();


      const [result] =
        await pool.query(
          `
          INSERT INTO users
          (
            name,
            email,
            password,
            wallet_address,
            balance,
            referral_code
          )

          VALUES
          (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
          )
          `,
          [
            name,
            email,
            hash,
            wallet,
            0,
            referralCode
          ]
        );


      const newUserId =
        result.insertId;


      // ==================================================
      // REFERRAL LEVEL 1
      // ==================================================

      if (referral) {

        const [[referrer]] =
          await pool.query(
            `
            SELECT id
            FROM users
            WHERE referral_code = ?
            `,
            [referral]
          );


        if (referrer) {

          await pool.query(
            `
            INSERT INTO referrals
            (
              referred_user_id,
              referrer_id,
              side,
              level
            )

            VALUES
            (
              ?,
              ?,
              ?,
              ?
            )
            `,
            [
              newUserId,
              referrer.id,
              "A",
              1
            ]
          );


          // ==============================================
          // REFERRAL LEVEL 2
          // ==============================================

          const [[second]] =
            await pool.query(
              `
              SELECT referrer_id
              FROM referrals
              WHERE referred_user_id = ?
              LIMIT 1
              `,
              [referrer.id]
            );


          if (
            second &&
            second.referrer_id
          ) {

            await pool.query(
              `
              INSERT INTO referrals
              (
                referred_user_id,
                referrer_id,
                side,
                level
              )

              VALUES
              (
                ?,
                ?,
                ?,
                ?
              )
              `,
              [
                newUserId,
                second.referrer_id,
                "B",
                2
              ]
            );


            // ============================================
            // REFERRAL LEVEL 3
            // ============================================

            const [[third]] =
              await pool.query(
                `
                SELECT referrer_id
                FROM referrals
                WHERE referred_user_id = ?
                LIMIT 1
                `,
                [
                  second.referrer_id
                ]
              );


            if (
              third &&
              third.referrer_id
            ) {

              await pool.query(
                `
                INSERT INTO referrals
                (
                  referred_user_id,
                  referrer_id,
                  side,
                  level
                )

                VALUES
                (
                  ?,
                  ?,
                  ?,
                  ?
                )
                `,
                [
                  newUserId,
                  third.referrer_id,
                  "A",
                  3
                ]
              );

            }

          }

        }

      }


      res.render(
        "login",
        {
          error: null,
          message:
            "Registered successfully, login now",
          user:
            req.session.user
        }
      );


    } catch (err) {

      console.error(err);


      res.render(
        "register",
        {
          error:
            "Server error",
          message: null,
          referral,
          user:
            req.session.user
        }
      );

    }

  }
);


// ========================================================
// LOGIN
// ========================================================

app.post(
  "/login",
  async (req, res) => {

    const {
      email,
      password
    } = req.body;


    try {

      // ==================================================
      // ADMIN LOGIN
      // ==================================================

      if (
        email ===
          process.env.ADMIN_EMAIL &&
        password ===
          process.env.ADMIN_PASSWORD
      ) {

        req.session.user = {

          id: 0,

          email,

          username: "Admin",

          isAdmin: true,

          balance: 0

        };


        return res.redirect(
          "/admin"
        );

      }


      // ==================================================
      // USER LOGIN
      // ==================================================

      const [rows] =
        await pool.query(
          `
          SELECT *
          FROM users
          WHERE email = ?
          `,
          [email]
        );


      if (!rows.length) {

        return res.render(
          "login",
          {
            error:
              "Invalid credentials",
            message: null,
            user:
              req.session.user
          }
        );

      }


      const user =
        rows[0];


      const match =
        await bcrypt.compare(
          password,
          user.password
        );


      if (!match) {

        return res.render(
          "login",
          {
            error:
              "Invalid credentials",
            message: null,
            user:
              req.session.user
          }
        );

      }


      req.session.user = {

        id: user.id,

        username:
          user.name ||
          user.email,

        email:
          user.email,

        wallet:
          user.wallet_address,

        balance:
          Number(user.balance) ||
          0,

        referral_code:
          user.referral_code,

        isAdmin: false

      };


      res.redirect(
        "/dashboard"
      );


    } catch (err) {

      console.error(err);


      res.render(
        "login",
        {
          error:
            "Server error",
          message: null,
          user:
            req.session.user
        }
      );

    }

  }
);


// ========================================================
// DASHBOARD
// ========================================================

app.get(
  "/dashboard",
  ensureAuth,
  async (req, res) => {

    try {

      const userId =
        req.session.user.id;


      // ==================================================
      // USER INFORMATION
      // ==================================================

      const [userRows] =
        await pool.query(
          `
          SELECT
            id,
            name AS username,
            email,
            wallet_address AS wallet,
            balance,
            referral_code

          FROM users

          WHERE id = ?
          `,
          [userId]
        );


      if (!userRows.length) {

        return res.redirect(
          "/login"
        );

      }


      const user =
        userRows[0];


      user.balance =
        Number(
          user.balance || 0
        );


      user.referral_link =
        `${process.env.APP_URL}/register?ref=${user.referral_code}`;


      // ==================================================
      // USER INVESTMENTS
      // ==================================================

      const [deposits] =
        await pool.query(
          `
          SELECT
            d.*,
            p.name AS plan_name,
            p.daily_return

          FROM deposits d

          LEFT JOIN plans p
            ON d.plan_id = p.id

          WHERE d.user_id = ?

          ORDER BY d.id DESC
          `,
          [userId]
        );


      // ==================================================
      // USER WITHDRAWALS
      //
      // Fee = 10%
      // Net amount = 90%
      //
      // These values are calculated for display and do
      // not require changes to the withdrawals table.
      // ==================================================

      const [withdrawals] =
        await pool.query(
          `
          SELECT
            id,
            amount,
            wallet,
            status,
            created_at,

            ROUND(
              amount * 0.10,
              2
            ) AS withdrawal_fee,

            ROUND(
              amount * 0.90,
              2
            ) AS net_amount

          FROM withdrawals

          WHERE user_id = ?

          ORDER BY id DESC
          `,
          [userId]
        );


      // ==================================================
      // REFERRALS
      // ==================================================

      const [referrals] =
        await pool.query(
          `
          SELECT
            r.*,
            u.name AS referred_name,
            u.email AS referred_email

          FROM referrals r

          LEFT JOIN users u
            ON r.referred_user_id = u.id

          WHERE r.referrer_id = ?

          ORDER BY r.side, r.id ASC
          `,
          [userId]
        );


      const referralsA =
        referrals.filter(
          r =>
            (r.side || "")
              .toUpperCase() === "A"
        );


      const referralsB =
        referrals.filter(
          r =>
            (r.side || "")
              .toUpperCase() === "B"
        );


      // ==================================================
      // RENDER DASHBOARD
      // ==================================================

      res.render(
        "dashboard",
        {
          user,
          deposits,
          withdrawals,
          referralsA,
          referralsB
        }
      );


    } catch (err) {

      console.error(
        "Dashboard error:",
        err
      );


      res.status(500).send(
        "Error loading dashboard"
      );

    }

  }
);


// ========================================================
// ADMIN DASHBOARD
// ========================================================

app.get(
  "/admin",
  ensureAdmin,
  async (req, res) => {

    try {

      const [users] =
        await pool.query(
          "SELECT * FROM users"
        );


      const [deposits] =
        await pool.query(
          `
          SELECT
            d.*,
            u.name AS user_name,
            u.email AS user_email,
            p.name AS plan_name

          FROM deposits d

          LEFT JOIN users u
            ON d.user_id = u.id

          LEFT JOIN plans p
            ON d.plan_id = p.id

          ORDER BY d.id DESC
          `
        );


      const [withdrawals] =
        await pool.query(
          `
          SELECT
            w.*,
            u.name AS user_name,
            u.email AS user_email

          FROM withdrawals w

          LEFT JOIN users u
            ON w.user_id = u.id

          ORDER BY w.id DESC
          `
        );


      const [referrals] =
        await pool.query(
          `
          SELECT
            r.*,
            u1.name AS referrer_name,
            u2.name AS referred_name,
            u2.email AS referred_email

          FROM referrals r

          LEFT JOIN users u1
            ON r.referrer_id = u1.id

          LEFT JOIN users u2
            ON r.referred_user_id = u2.id

          ORDER BY
            r.referrer_id,
            r.side,
            r.id ASC
          `
        );


      res.render(
        "admin",
        {
          user:
            req.session.user,
          users,
          deposits,
          withdrawals,
          referrals
        }
      );


    } catch (err) {

      console.error(
        "Admin error:",
        err
      );


      res.status(500).send(
        "Error loading admin dashboard"
      );

    }

  }
);


// ========================================================
// ADMIN DEPOSIT APPROVAL
// ========================================================

app.post(
  "/admin/deposit/:id/:action",
  ensureAdmin,
  async (req, res) => {

    try {

      const {
        id,
        action
      } = req.params;


      if (
        !["approve", "reject"]
          .includes(action)
      ) {

        return res.status(400).send(
          "Invalid action"
        );

      }


      if (
        action === "approve"
      ) {

        await activateDeposit(
          id
        );

      } else {

        await pool.query(
          `
          UPDATE deposits

          SET status = 'Rejected'

          WHERE id = ?

          AND status = 'Pending'
          `,
          [id]
        );

      }


      res.redirect(
        "/admin"
      );


    } catch (err) {

      console.error(err);


      res.status(500).send(
        "Error updating deposit"
      );

    }

  }
);


// ========================================================
// ADMIN WITHDRAWAL APPROVAL
// ========================================================

app.post(
  "/admin/withdraw/:id/:action",
  ensureAdmin,
  async (req, res) => {

    const connection =
      await pool.getConnection();


    try {

      const {
        id,
        action
      } = req.params;


      if (
        !["approve", "reject"]
          .includes(action)
      ) {

        return res.status(400).send(
          "Invalid action"
        );

      }


      await connection.beginTransaction();


      const [withdrawalRows] =
        await connection.query(
          `
          SELECT *
          FROM withdrawals
          WHERE id = ?
          FOR UPDATE
          `,
          [id]
        );


      if (!withdrawalRows.length) {

        await connection.rollback();

        return res.status(404).send(
          "Withdrawal not found"
        );

      }


      const withdrawal =
        withdrawalRows[0];


      if (
        withdrawal.status !==
        "Pending"
      ) {

        await connection.rollback();

        return res.status(400).send(
          `Withdrawal is already ${withdrawal.status}`
        );

      }


      // ==================================================
      // APPROVE
      //
      // Money was already reserved when withdrawal
      // was created, therefore DO NOT deduct again.
      // ==================================================

      if (
        action === "approve"
      ) {

        await connection.query(
          `
          UPDATE withdrawals

          SET status = 'Approved'

          WHERE id = ?
          `,
          [id]
        );


        console.log(
          `✅ Withdrawal ${id} approved`
        );

      }


      // ==================================================
      // REJECT
      //
      // Return reserved amount to balance.
      // ==================================================

      else {

        await connection.query(
          `
          UPDATE users

          SET balance =
            balance + ?

          WHERE id = ?
          `,
          [
            Number(
              withdrawal.amount
            ),
            withdrawal.user_id
          ]
        );


        await connection.query(
          `
          UPDATE withdrawals

          SET status = 'Rejected'

          WHERE id = ?
          `,
          [id]
        );


        console.log(
          `❌ Withdrawal ${id} rejected. ` +
          `R${Number(
            withdrawal.amount
          ).toFixed(2)} returned.`
        );

      }


      await connection.commit();


      res.redirect(
        "/admin"
      );


    } catch (err) {

      try {

        await connection.rollback();

      } catch (rollbackError) {

        console.error(
          "Rollback error:",
          rollbackError
        );

      }


      console.error(
        "Admin withdrawal error:",
        err
      );


      res.status(500).send(
        "Error updating withdrawal"
      );


    } finally {

      connection.release();

    }

  }
);


// ========================================================
// DEPOSIT PAGE
// ========================================================

app.get(
  "/deposit",
  ensureAuth,
  (req, res) => {

    res.render(
      "deposit",
      {
        user:
          req.session.user,

        plans,

        error: null
      }
    );

  }
);


// ========================================================
// CREATE DEPOSIT
// ========================================================

app.post(
  "/deposit",
  ensureAuth,
  async (req, res) => {

    try {

      const {
        plan_id,
        amount,
        wallet,
        txid
      } = req.body;


      const userId =
        req.session.user.id;


      if (
        !plan_id ||
        !amount ||
        !wallet ||
        !txid
      ) {

        return res.render(
          "deposit",
          {
            user:
              req.session.user,

            plans,

            error:
              "All fields are required"
          }
        );

      }


      const selectedPlan =
        plans.find(
          p =>
            Number(p.id) ===
            Number(plan_id)
        );


      if (!selectedPlan) {

        return res.render(
          "deposit",
          {
            user:
              req.session.user,

            plans,

            error:
              "Invalid plan selected"
          }
        );

      }


      const depositAmount =
        Number(amount);


      if (
        !Number.isFinite(
          depositAmount
        ) ||
        depositAmount <
          selectedPlan.min_amount_zar
      ) {

        return res.render(
          "deposit",
          {
            user:
              req.session.user,

            plans,

            error:
              `Minimum investment for ${selectedPlan.name} is R${selectedPlan.min_amount_zar.toFixed(2)}`
          }
        );

      }


      await pool.query(
        `
        INSERT INTO deposits
        (
          user_id,
          plan_id,
          amount,
          wallet,
          txid,
          status,
          daily_gain,
          total_earned,
          created_at,
          last_updated
        )

        VALUES
        (
          ?,
          ?,
          ?,
          ?,
          ?,
          'Pending',
          0,
          0,
          NOW(),
          NULL
        )
        `,
        [
          userId,
          plan_id,
          depositAmount,
          wallet,
          txid
        ]
      );


      res.redirect(
        "/dashboard"
      );


    } catch (err) {

      console.error(err);


      res.render(
        "deposit",
        {
          user:
            req.session.user,

          plans,

          error:
            "Server error"
        }
      );

    }

  }
);


// ========================================================
// WITHDRAW PAGE
// ========================================================

app.get(
  "/withdraw",
  ensureAuth,
  async (req, res) => {

    try {

      const [rows] =
        await pool.query(
          `
          SELECT
            balance
          FROM users
          WHERE id = ?
          `,
          [req.session.user.id]
        );


      const balance =
        rows.length
          ? Number(rows[0].balance || 0)
          : 0;


      res.render(
        "withdraw",
        {
          user: {
            ...req.session.user,
            balance
          },

          error: null
        }
      );


    } catch (err) {

      console.error(
        "Withdraw page error:",
        err
      );


      res.render(
        "withdraw",
        {
          user:
            req.session.user,

          error:
            "Unable to load withdrawal page"
        }
      );

    }

  }
);


// ========================================================
// CREATE WITHDRAWAL
// ========================================================

app.post(
  "/withdraw",
  ensureAuth,
  async (req, res) => {

    const connection =
      await pool.getConnection();


    try {

      const {
        amount,
        wallet
      } = req.body;


      const userId =
        req.session.user.id;


      // ==================================================
      // REQUIRED FIELDS
      // ==================================================

      if (
        !amount ||
        !wallet
      ) {

        await connection.rollback();

        return res.render(
          "withdraw",
          {
            user:
              req.session.user,

            error:
              "All fields are required"
          }
        );

      }


      // ==================================================
      // NUMBER VALIDATION
      // ==================================================

      const withdrawalAmount =
        Number(amount);


      if (
        !Number.isFinite(
          withdrawalAmount
        ) ||
        withdrawalAmount <= 0
      ) {

        return res.render(
          "withdraw",
          {
            user:
              req.session.user,

            error:
              "Enter a valid withdrawal amount"
          }
        );

      }


      // ==================================================
      // MINIMUM WITHDRAWAL
      // ==================================================

      const MIN_WITHDRAWAL = 100;


      if (
        withdrawalAmount <
        MIN_WITHDRAWAL
      ) {

        return res.render(
          "withdraw",
          {
            user:
              req.session.user,

            error:
              "Minimum withdrawal amount is R100.00"
          }
        );

      }


      // ==================================================
      // START TRANSACTION
      // ==================================================

      await connection.beginTransaction();


      // ==================================================
      // LOCK USER
      // ==================================================

      const [userRows] =
        await connection.query(
          `
          SELECT balance
          FROM users
          WHERE id = ?
          FOR UPDATE
          `,
          [userId]
        );


      if (!userRows.length) {

        await connection.rollback();

        return res.render(
          "withdraw",
          {
            user:
              req.session.user,

            error:
              "User account not found"
          }
        );

      }


      const currentBalance =
        Number(
          userRows[0].balance || 0
        );


      // ==================================================
      // PENDING WITHDRAWALS
      // ==================================================

      const [pendingRows] =
        await connection.query(
          `
          SELECT
            COALESCE(
              SUM(amount),
              0
            ) AS pending_amount

          FROM withdrawals

          WHERE user_id = ?

          AND status = 'Pending'
          `,
          [userId]
        );


      const pendingAmount =
        Number(
          pendingRows[0]
            .pending_amount || 0
        );


      // ==================================================
      // AVAILABLE BALANCE
      //
      // Since pending withdrawals are already reserved
      // from the balance, do not subtract them again.
      // ==================================================

      const availableBalance =
        currentBalance;


      // ==================================================
      // BALANCE CHECK
      // ==================================================

      if (
        withdrawalAmount >
        availableBalance
      ) {

        await connection.rollback();

        return res.render(
          "withdraw",
          {
            user:
              {
                ...req.session.user,
                balance:
                  currentBalance
              },

            error:
              `Insufficient available balance. Your available balance is R${availableBalance.toFixed(2)}.`
          }
        );

      }


      // ==================================================
      // RESERVE FUNDS
      // ==================================================

      await connection.query(
        `
        UPDATE users

        SET balance =
          balance - ?

        WHERE id = ?
        `,
        [
          withdrawalAmount,
          userId
        ]
      );


      // ==================================================
      // CREATE WITHDRAWAL
      // ==================================================

      await connection.query(
        `
        INSERT INTO withdrawals
        (
          user_id,
          amount,
          wallet,
          status,
          created_at
        )

        VALUES
        (
          ?,
          ?,
          ?,
          'Pending',
          NOW()
        )
        `,
        [
          userId,
          withdrawalAmount,
          wallet
        ]
      );


      // ==================================================
      // COMMIT
      // ==================================================

      await connection.commit();


      req.session.user.balance =
        currentBalance -
        withdrawalAmount;


      console.log(
        `💸 Withdrawal R${withdrawalAmount.toFixed(2)} created for user ${userId}`
      );


      res.redirect(
        "/dashboard"
      );


    } catch (err) {

      try {

        await connection.rollback();

      } catch (rollbackError) {

        console.error(
          "Rollback error:",
          rollbackError
        );

      }


      console.error(
        "❌ Withdrawal error:",
        err
      );


      res.render(
        "withdraw",
        {
          user:
            req.session.user,

          error:
            "Unable to process withdrawal"
        }
      );


    } finally {

      connection.release();

    }

  }
);


// ========================================================
// DAILY GAINS
//
// Runs every minute to check whether a full day has passed.
//
// Activation behavior:
// - Activation immediately awards the first daily gain.
// - last_updated is set to activation time.
// - The next daily gain is awarded after 24 hours.
// - Investment amount is NEVER added to balance.
// ========================================================

cron.schedule(
  "* * * * *",
  async () => {

    console.log(
      "⏳ Running daily gains updater..."
    );


    try {

      const [deposits] =
        await pool.query(
          `
          SELECT
            id,
            user_id,
            status,
            plan_id,
            last_updated

          FROM deposits

          WHERE status = 'Active'
          `
        );


      const now =
        new Date();


      for (
        const dep of deposits
      ) {

        const [planRows] =
          await pool.query(
            `
            SELECT
              daily_return

            FROM plans

            WHERE id = ?
            `,
            [dep.plan_id]
          );


        if (!planRows.length) {
          continue;
        }


        const dailyGainZAR =
          Number(
            planRows[0].daily_return || 0
          );


        if (dailyGainZAR <= 0) {
          continue;
        }


        const lastUpdated =
          dep.last_updated
            ? new Date(
                dep.last_updated
              )
            : null;


        // If an active deposit somehow has no
        // last_updated value, initialize it now.
        // DO NOT award an extra initial amount here.
        if (!lastUpdated) {

          await pool.query(
            `
            UPDATE deposits

            SET last_updated = ?

            WHERE id = ?
            `,
            [
              now,
              dep.id
            ]
          );

          continue;

        }


        const millisecondsPerDay =
          1000 *
          60 *
          60 *
          24;


        const daysPassed =
          Math.floor(
            (
              now -
              lastUpdated
            ) /
            millisecondsPerDay
          );


        if (
          daysPassed < 1
        ) {
          continue;
        }


        const gain =
          dailyGainZAR *
          daysPassed;


        // ==================================================
        // UPDATE DEPOSIT
        // ==================================================

        await pool.query(
          `
          UPDATE deposits

          SET

            daily_gain = ?,

            total_earned =
              IFNULL(
                total_earned,
                0
              ) + ?,

            last_updated =
              DATE_ADD(
                last_updated,
                INTERVAL ? DAY
              )

          WHERE id = ?

          AND status = 'Active'
          `,
          [
            dailyGainZAR,
            gain,
            daysPassed,
            dep.id
          ]
        );


        // ==================================================
        // UPDATE USER BALANCE
        // ==================================================

        await pool.query(
          `
          UPDATE users

          SET balance =
            balance + ?

          WHERE id = ?
          `,
          [
            gain,
            dep.user_id
          ]
        );


        console.log(
          `✅ Added R${gain.toFixed(2)} gain to user ${dep.user_id} for ${daysPassed} day(s).`
        );

      }


      console.log(
        "✅ Daily gains update complete."
      );


    } catch (err) {

      console.error(
        "❌ Error updating gains:",
        err
      );

    }

  }
);


// ========================================================
// LOGOUT
// ========================================================

app.get(
  "/logout",
  (req, res) => {

    req.session.destroy(
      (err) => {

        if (err) {

          console.error(
            "Logout error:",
            err
          );

          return res
            .status(500)
            .send(
              "Unable to logout"
            );

        }


        res.clearCookie(
          "sb_sid"
        );


        res.redirect(
          "/login"
        );

      }
    );

  }
);


// ========================================================
// SERVER
// ========================================================

app.listen(
  PORT,
  () => {

    console.log(
      `🚀 Server running on port ${PORT}`
    );

  }
);