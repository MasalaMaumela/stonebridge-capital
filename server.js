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

function ensureAuth(
  req,
  res,
  next
) {

  if (req.session.user) {

    return next();

  }

  res.redirect("/login");

}


function ensureAdmin(
  req,
  res,
  next
) {

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
// REFERRAL PERCENTAGES
// ========================================================
//
// Level 1 = 10%
// Level 2 = 5%
// Level 3 = 2%
//
// IMPORTANT:
// These percentages are calculated against the
// DEPOSIT AMOUNT of the referred user.
//

function getReferralPercent(level) {

  if (Number(level) === 1) {

    return 0.10;

  }

  if (Number(level) === 2) {

    return 0.05;

  }

  if (Number(level) === 3) {

    return 0.02;

  }

  return 0;

}


// ========================================================
// REFERRAL CODE
// ========================================================

async function generateReferralCode() {

  let code;

  let exists = true;


  while (exists) {

    code =
      crypto
        .randomBytes(4)
        .toString("hex")
        .toUpperCase();


    const [rows] =
      await pool.query(
        `
        SELECT id
        FROM users
        WHERE referral_code = ?
        LIMIT 1
        `,
        [code]
      );


    exists =
      rows.length > 0;

  }


  return code;

}


// ========================================================
// GET PLAN
// ========================================================

function getPlanById(planId) {

  return plans.find(
    p =>
      Number(p.id) ===
      Number(planId)
  );

}


// ========================================================
// BUILD REFERRAL CHAIN
// ========================================================
//
// Example:
//
// A refers B
// B refers C
// C refers D
//
// If D deposits:
//
// C = Level 1
// B = Level 2
// A = Level 3
//
// This function walks upward through the actual
// Level 1 referral relationships.
//

async function createReferralChain(
  newUserId,
  directReferrerId
) {

  let currentReferrerId =
    Number(directReferrerId);


  for (
    let level = 1;
    level <= 3;
    level++
  ) {

    if (!currentReferrerId) {

      break;

    }


    // Prevent self-referral
    if (
      Number(currentReferrerId) ===
      Number(newUserId)
    ) {

      break;

    }


    // Check whether this exact
    // referral relationship already exists
    const [existing] =
      await pool.query(
        `
        SELECT id
        FROM referrals
        WHERE referred_user_id = ?
        AND referrer_id = ?
        AND level = ?
        LIMIT 1
        `,
        [
          newUserId,
          currentReferrerId,
          level
        ]
      );


    if (!existing.length) {

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
          currentReferrerId,
          "A",
          level
        ]
      );

    }


    // Find the next person above the
    // current referrer.
    //
    // We specifically look for their Level 1
    // relationship because that represents
    // who directly referred them.

    const [[upline]] =
      await pool.query(
        `
        SELECT referrer_id
        FROM referrals
        WHERE referred_user_id = ?
        AND level = 1
        ORDER BY id ASC
        LIMIT 1
        `,
        [currentReferrerId]
      );


    if (
      !upline ||
      !upline.referrer_id
    ) {

      break;

    }


    currentReferrerId =
      Number(
        upline.referrer_id
      );

  }

}


// ========================================================
// PAY REFERRAL COMMISSIONS
// ========================================================
//
// Paid ONCE when a deposit becomes Active.
//
// The calculation is:
//
// deposit amount × level percentage
//
// Example:
// R5,000 deposit:
//
// Level 1 = R500
// Level 2 = R250
// Level 3 = R100
//
// No additional matching bonus.
//

async function payReferralCommissions(
  deposit
) {

  const depositAmount =
    Number(deposit.amount || 0);


  if (
    depositAmount <= 0
  ) {

    return;

  }


  const [referrals] =
    await pool.query(
      `
      SELECT
        id,
        referrer_id,
        referred_user_id,
        level

      FROM referrals

      WHERE referred_user_id = ?

      AND level IN (1, 2, 3)

      ORDER BY level ASC
      `,
      [deposit.user_id]
    );


  for (
    const referral of referrals
  ) {

    const level =
      Number(
        referral.level
      );


    const percentage =
      getReferralPercent(
        level
      );


    if (
      percentage <= 0
    ) {

      continue;

    }


    const bonus =
      depositAmount *
      percentage;


    await pool.query(
      `
      UPDATE users

      SET balance =
        COALESCE(balance, 0) + ?

      WHERE id = ?
      `,
      [
        bonus,
        referral.referrer_id
      ]
    );


    console.log(
      `🎁 Level ${level} referral commission R${bonus.toFixed(2)} paid to user ${referral.referrer_id} from R${depositAmount.toFixed(2)} deposit`
    );

  }

}


// ========================================================
// ACTIVATE DEPOSIT
// ========================================================
//
// IMPORTANT BEHAVIOR:
//
// When admin approves:
//
// 1. Deposit becomes Active.
// 2. Original investment amount is NOT added
//    to user balance.
// 3. The plan's daily gain is immediately awarded.
// 4. total_earned starts with that daily gain.
// 5. last_updated becomes NOW().
// 6. Referral commissions are paid once.
//
// Example:
//
// Bronze = R12/day
//
// User invests R300.
//
// Upon activation:
// Balance gets +R12
// Investment amount R300 is NOT added.
//
// At the next calendar day:
// Another R12 is added.
//

async function activateDeposit(
  depositId
) {

  const connection =
    await pool.getConnection();


  try {

    await connection.beginTransaction();


    // ====================================================
    // LOCK DEPOSIT
    // ====================================================

    const [rows] =
      await connection.query(
        `
        SELECT *
        FROM deposits
        WHERE id = ?
        FOR UPDATE
        `,
        [depositId]
      );


    if (!rows.length) {

      await connection.rollback();

      return;

    }


    const dep =
      rows[0];


    // Already active
    if (
      String(dep.status)
        .toLowerCase() ===
      "active"
    ) {

      await connection.rollback();

      console.log(
        `Deposit ${depositId} already active - skipping.`
      );

      return;

    }


    const plan =
      getPlanById(
        dep.plan_id
      );


    if (!plan) {

      await connection.rollback();

      throw new Error(
        `Plan ${dep.plan_id} does not exist`
      );

    }


    const dailyGain =
      Number(
        plan.daily_return
      );


    if (
      !Number.isFinite(
        dailyGain
      ) ||
      dailyGain <= 0
    ) {

      await connection.rollback();

      throw new Error(
        `Invalid daily gain for plan ${plan.name}`
      );

    }


    // ====================================================
    // ACTIVATE DEPOSIT
    // ====================================================
    //
    // The original deposit amount remains the
    // investment amount.
    //
    // Only the daily gain is credited.
    //

    await connection.query(
      `
      UPDATE deposits

      SET
        status = 'Active',
        daily_gain = ?,
        total_earned =
          COALESCE(total_earned, 0) + ?,
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
    // AWARD IMMEDIATE DAILY GAIN
    // ====================================================

    await connection.query(
      `
      UPDATE users

      SET balance =
        COALESCE(balance, 0) + ?

      WHERE id = ?
      `,
      [
        dailyGain,
        dep.user_id
      ]
    );


    // ====================================================
    // REFERRAL COMMISSIONS
    // ====================================================
    //
    // Use the original deposit amount.
    //
    // NOT the daily gain.
    //

    const [referrals] =
      await connection.query(
        `
        SELECT
          id,
          referrer_id,
          referred_user_id,
          level

        FROM referrals

        WHERE referred_user_id = ?

        AND level IN (1, 2, 3)

        ORDER BY level ASC
        `,
        [dep.user_id]
      );


    const depositAmount =
      Number(
        dep.amount || 0
      );


    for (
      const referral of referrals
    ) {

      const level =
        Number(
          referral.level
        );


      const percentage =
        getReferralPercent(
          level
        );


      if (
        percentage <= 0
      ) {

        continue;

      }


      const bonus =
        depositAmount *
        percentage;


      await connection.query(
        `
        UPDATE users

        SET balance =
          COALESCE(balance, 0) + ?

        WHERE id = ?
        `,
        [
          bonus,
          referral.referrer_id
        ]
      );


      console.log(
        `🎁 Level ${level}: R${bonus.toFixed(2)} paid to referrer ${referral.referrer_id}`
      );

    }


    await connection.commit();


    console.log(
      `✅ Deposit ${depositId} activated. Immediate daily gain R${dailyGain.toFixed(2)} awarded.`
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

app.get(
  "/",
  (req, res) => {

    res.redirect("/login");

  }
);


// ========================================================
// LOGIN PAGE
// ========================================================

app.get(
  "/login",
  (req, res) => {

    res.render(
      "login",
      {
        error: null,
        message: null,
        user:
          req.session.user
      }
    );

  }
);


// ========================================================
// REGISTER PAGE
// ========================================================

app.get(
  "/register",
  (req, res) => {

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

  }
);


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
          LIMIT 1
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


      // ==================================================
      // FIND DIRECT REFERRER
      // ==================================================

      let directReferrerId =
        null;


      if (referral) {

        const [[referrer]] =
          await pool.query(
            `
            SELECT id
            FROM users
            WHERE referral_code = ?
            LIMIT 1
            `,
            [referral]
          );


        if (referrer) {

          directReferrerId =
            Number(
              referrer.id
            );

        }

      }


      // ==================================================
      // CREATE USER
      // ==================================================

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
      // BUILD 3-LEVEL REFERRAL CHAIN
      // ==================================================

      if (
        directReferrerId &&
        directReferrerId !==
          Number(newUserId)
      ) {

        await createReferralChain(
          newUserId,
          directReferrerId
        );

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

      console.error(
        "Registration error:",
        err
      );


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

          username:
            "Admin",

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
          LIMIT 1
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

        id:
          user.id,

        username:
          user.name ||
          user.email,

        email:
          user.email,

        wallet:
          user.wallet_address,

        balance:
          Number(
            user.balance || 0
          ),

        referral_code:
          user.referral_code,

        isAdmin:
          false

      };


      res.redirect(
        "/dashboard"
      );


    } catch (err) {

      console.error(
        "Login error:",
        err
      );


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
      // USER
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
      // INVESTMENTS
      // ==================================================

      const [deposits] =
        await pool.query(
          `
          SELECT
            d.*,
            p.name AS db_plan_name

          FROM deposits d

          LEFT JOIN plans p
            ON d.plan_id = p.id

          WHERE d.user_id = ?

          ORDER BY d.id DESC
          `,
          [userId]
        );


      // Use the static plans if the DB plans table
      // does not contain the name.

      deposits.forEach(
        deposit => {

          const plan =
            getPlanById(
              deposit.plan_id
            );


          deposit.plan_name =
            plan
              ? plan.name
              : (
                  deposit.db_plan_name ||
                  "N/A"
                );

        }
      );


      // ==================================================
      // REFERRALS
      // ==================================================

      const [referrals] =
        await pool.query(
          `
          SELECT
            r.id,
            r.referred_user_id,
            r.referrer_id,
            r.side,
            r.level

          FROM referrals r

          WHERE r.referrer_id = ?

          ORDER BY
            r.level ASC,
            r.id ASC
          `,
          [userId]
        );


      const referralsA =
        referrals.filter(
          r =>
            Number(r.level) === 1
        );


      const referralsB =
        referrals.filter(
          r =>
            Number(r.level) === 2 ||
            Number(r.level) === 3
        );


      // ==================================================
      // WITHDRAWALS
      // ==================================================

      const [withdrawals] =
        await pool.query(
          `
          SELECT
            id,
            amount,
            wallet,
            status,
            created_at

          FROM withdrawals

          WHERE user_id = ?

          ORDER BY id DESC
          `,
          [userId]
        );


      // Calculate fee and net amount for display.

      withdrawals.forEach(
        withdrawal => {

          const requestedAmount =
            Number(
              withdrawal.amount || 0
            );


          const fee =
            requestedAmount *
            0.10;


          const net =
            requestedAmount -
            fee;


          withdrawal.requested_amount =
            requestedAmount;

          withdrawal.fee =
            fee;

          withdrawal.net_amount =
            net;

        }
      );


      // ==================================================
      // PENDING WITHDRAWALS
      // ==================================================

      const pendingWithdrawals =
        withdrawals.filter(
          withdrawal =>
            String(
              withdrawal.status
            ).toLowerCase() ===
            "pending"
        );


      const pendingWithdrawalTotal =
        pendingWithdrawals.reduce(
          (
            total,
            withdrawal
          ) =>
            total +
            Number(
              withdrawal.requested_amount ||
              0
            ),
          0
        );


      const availableBalance =
        user.balance -
        pendingWithdrawalTotal;


      // ==================================================
      // RENDER
      // ==================================================

      res.render(
        "dashboard",
        {
          user,

          deposits,

          referralsA,

          referralsB,

          referrals,

          withdrawals,

          pendingWithdrawals,

          pendingWithdrawalTotal,

          availableBalance

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
// ADMIN
// ========================================================

app.get(
  "/admin",
  ensureAdmin,
  async (req, res) => {

    try {

      // ==================================================
      // USERS
      // ==================================================

      const [users] =
        await pool.query(
          "SELECT * FROM users"
        );


      // ==================================================
      // DEPOSITS
      // ==================================================

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


      // ==================================================
      // WITHDRAWALS
      // ==================================================

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


      // Add fee/net values for admin display.

      withdrawals.forEach(
        withdrawal => {

          const amount =
            Number(
              withdrawal.amount || 0
            );


          withdrawal.fee =
            amount * 0.10;


          withdrawal.net_amount =
            amount -
            withdrawal.fee;

        }
      );


      // ==================================================
      // REFERRALS
      // ==================================================

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
            r.level,
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
        ![
          "approve",
          "reject"
        ].includes(action)
      ) {

        return res
          .status(400)
          .send(
            "Invalid action"
          );

      }


      if (
        action ===
        "approve"
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

      console.error(
        "Deposit approval error:",
        err
      );


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
        ![
          "approve",
          "reject"
        ].includes(action)
      ) {

        return res
          .status(400)
          .send(
            "Invalid action"
          );

      }


      await connection.beginTransaction();


      // ==================================================
      // LOCK WITHDRAWAL
      // ==================================================

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


      if (
        !withdrawalRows.length
      ) {

        await connection.rollback();

        return res
          .status(404)
          .send(
            "Withdrawal not found"
          );

      }


      const withdrawal =
        withdrawalRows[0];


      if (
        String(
          withdrawal.status
        ).toLowerCase() !==
        "pending"
      ) {

        await connection.rollback();

        return res
          .status(400)
          .send(
            `Withdrawal is already ${withdrawal.status}`
          );

      }


      const requestedAmount =
        Number(
          withdrawal.amount || 0
        );


      const fee =
        requestedAmount *
        0.10;


      const netAmount =
        requestedAmount -
        fee;


      // ==================================================
      // APPROVE
      // ==================================================
      //
      // The requested amount was already reserved
      // from the user's balance when the withdrawal
      // was created.
      //
      // On approval:
      //
      // Requested: R5,000
      // Fee: R500
      // Net: R4,500
      //
      // No money is returned to the user.
      //

      if (
        action ===
        "approve"
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
          `✅ Withdrawal ${id} approved. Requested R${requestedAmount.toFixed(2)}, fee R${fee.toFixed(2)}, net R${netAmount.toFixed(2)}`
        );

      }


      // ==================================================
      // REJECT
      // ==================================================
      //
      // Return the FULL requested amount because it
      // was reserved from the balance.
      //

      else {

        await connection.query(
          `
          UPDATE users

          SET balance =
            COALESCE(balance, 0) + ?

          WHERE id = ?
          `,
          [
            requestedAmount,
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
          `❌ Withdrawal ${id} rejected. R${requestedAmount.toFixed(2)} returned.`
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


      res
        .status(500)
        .send(
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
// DEPOSIT
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
        getPlanById(
          plan_id
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
              `Minimum deposit for ${selectedPlan.name} is R${selectedPlan.min_amount_zar.toFixed(2)}`

          }
        );

      }


      // ==================================================
      // CREATE PENDING DEPOSIT
      // ==================================================

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
          created_at
        )

        VALUES
        (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          NOW()
        )
        `,
        [
          userId,
          plan_id,
          depositAmount,
          wallet,
          txid,
          "Pending",
          0,
          0
        ]
      );


      res.redirect(
        "/dashboard"
      );


    } catch (err) {

      console.error(
        "Deposit error:",
        err
      );


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

      const userId =
        req.session.user.id;


      const [[user]] =
        await pool.query(
          `
          SELECT balance
          FROM users
          WHERE id = ?
          `,
          [userId]
        );


      const [pendingRows] =
        await pool.query(
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


      const balance =
        Number(
          user?.balance || 0
        );


      const pending =
        Number(
          pendingRows[0]
            ?.pending_amount || 0
        );


      const availableBalance =
        balance -
        pending;


      res.render(
        "withdraw",
        {
          user:
            req.session.user,

          error: null,

          availableBalance,

          pendingWithdrawal:
            pending

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
            "Unable to load withdrawal page",

          availableBalance: 0,

          pendingWithdrawal: 0

        }
      );

    }

  }
);


// ========================================================
// WITHDRAW
// ========================================================
//
// Withdrawal fee:
//
// 10%
//
// Example:
//
// Requested = R5,000
// Fee       = R500
// Net       = R4,500
//
// The full R5,000 is reserved from the balance.
// If approved, R500 is retained as the fee.
// If rejected, the full R5,000 is returned.
//

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
              "All fields are required",

            availableBalance: 0,

            pendingWithdrawal: 0

          }
        );

      }


      // ==================================================
      // VALIDATE AMOUNT
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
              "Enter a valid withdrawal amount",

            availableBalance: 0,

            pendingWithdrawal: 0

          }
        );

      }


      // ==================================================
      // MINIMUM WITHDRAWAL
      // ==================================================

      const MIN_WITHDRAWAL =
        100;


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
              "Minimum withdrawal amount is R100.00",

            availableBalance: 0,

            pendingWithdrawal: 0

          }
        );

      }


      // ==================================================
      // FEE
      // ==================================================

      const withdrawalFee =
        withdrawalAmount *
        0.10;


      const netAmount =
        withdrawalAmount -
        withdrawalFee;


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
              "User account not found",

            availableBalance: 0,

            pendingWithdrawal: 0

          }
        );

      }


      const currentBalance =
        Number(
          userRows[0].balance ||
          0
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
            ?.pending_amount || 0
        );


      // ==================================================
      // AVAILABLE BALANCE
      // ==================================================

      const availableBalance =
        currentBalance -
        pendingAmount;


      // ==================================================
      // CHECK BALANCE
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
              req.session.user,

            error:
              `Insufficient available balance. Your available balance is R${availableBalance.toFixed(2)}.`,

            availableBalance,

            pendingWithdrawal:
              pendingAmount

          }
        );

      }


      // ==================================================
      // RESERVE FULL REQUESTED AMOUNT
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
      // CREATE PENDING WITHDRAWAL
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
          ?,
          NOW()
        )
        `,
        [
          userId,
          withdrawalAmount,
          wallet,
          "Pending"
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
        `💸 Withdrawal requested: R${withdrawalAmount.toFixed(2)} | Fee: R${withdrawalFee.toFixed(2)} | Net: R${netAmount.toFixed(2)} | User: ${userId}`
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
            "Unable to process withdrawal",

          availableBalance: 0,

          pendingWithdrawal: 0

        }
      );


    } finally {

      connection.release();

    }

  }
);


// ========================================================
// DAILY GAINS
// ========================================================
//
// Runs every minute so the application does not need
// to remain running exactly at midnight.
//
// The actual payout happens only when the calendar date
// has changed since last_updated.
//
// IMPORTANT:
//
// Activation:
//
// Bronze R12/day
//
// Immediately:
// +R12
//
// last_updated = activation time
//
// At midnight / first cron run after midnight:
// +R12
//
// The investment amount is NEVER added to balance.
//
// ========================================================

cron.schedule(
  "* * * * *",
  async () => {

    console.log(
      "⏳ Checking daily gains..."
    );


    try {

      const [deposits] =
        await pool.query(
          `
          SELECT
            id,
            user_id,
            amount,
            status,
            plan_id,
            last_updated

          FROM deposits

          WHERE status = 'Active'
          `
        );


      for (
        const dep of deposits
      ) {

        const plan =
          getPlanById(
            dep.plan_id
          );


        if (!plan) {

          console.error(
            `❌ Plan ${dep.plan_id} not found for deposit ${dep.id}`
          );

          continue;

        }


        const dailyGain =
          Number(
            plan.daily_return
          );


        if (
          !Number.isFinite(
            dailyGain
          ) ||
          dailyGain <= 0
        ) {

          continue;

        }


        // ==================================================
        // CHECK WHETHER A NEW CALENDAR DAY HAS STARTED
        // ==================================================

        if (!dep.last_updated) {

          // Safety fallback.
          //
          // Do NOT pay here because activation should
          // already have awarded the initial gain.

          await pool.query(
            `
            UPDATE deposits

            SET last_updated = NOW()

            WHERE id = ?
            `,
            [dep.id]
          );


          continue;

        }


        const [dateRows] =
          await pool.query(
            `
            SELECT
              DATE(?) AS last_date,
              CURDATE() AS current_date
            `,
            [
              dep.last_updated
            ]
          );


        const lastDate =
          dateRows[0]
            ?.last_date;


        const currentDate =
          dateRows[0]
            ?.current_date;


        // Same calendar day = no payout.
        if (
          String(lastDate) ===
          String(currentDate)
        ) {

          continue;

        }


        // ==================================================
        // PAY ONE DAILY GAIN
        // ==================================================

        const connection =
          await pool.getConnection();


        try {

          await connection.beginTransaction();


          // Lock deposit again to avoid duplicate
          // payout if multiple cron executions overlap.

          const [lockedRows] =
            await connection.query(
              `
              SELECT
                id,
                user_id,
                status,
                last_updated

              FROM deposits

              WHERE id = ?

              FOR UPDATE
              `,
              [dep.id]
            );


          if (
            !lockedRows.length
          ) {

            await connection.rollback();

            connection.release();

            continue;

          }


          const lockedDeposit =
            lockedRows[0];


          if (
            lockedDeposit.status !==
            "Active"
          ) {

            await connection.rollback();

            connection.release();

            continue;

          }


          // Check again after locking.

          const [checkRows] =
            await connection.query(
              `
              SELECT
                DATE(?) AS last_date,
                CURDATE() AS current_date
              `,
              [
                lockedDeposit.last_updated
              ]
            );


          if (
            String(
              checkRows[0].last_date
            ) ===
            String(
              checkRows[0].current_date
            )
          ) {

            await connection.rollback();

            connection.release();

            continue;

          }


          // ==================================================
          // UPDATE DEPOSIT
          // ==================================================

          await connection.query(
            `
            UPDATE deposits

            SET
              daily_gain = ?,

              total_earned =
                COALESCE(
                  total_earned,
                  0
                ) + ?,

              last_updated = NOW()

            WHERE id = ?
            `,
            [
              dailyGain,
              dailyGain,
              dep.id
            ]
          );


          // ==================================================
          // UPDATE USER BALANCE
          // ==================================================

          await connection.query(
            `
            UPDATE users

            SET balance =
              COALESCE(balance, 0) + ?

            WHERE id = ?
            `,
            [
              dailyGain,
              dep.user_id
            ]
          );


          await connection.commit();


          console.log(
            `✅ Daily gain R${dailyGain.toFixed(2)} added to user ${dep.user_id} for deposit ${dep.id}`
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
            `❌ Gain update failed for deposit ${dep.id}:`,
            err
          );


        } finally {

          connection.release();

        }

      }


      console.log(
        "✅ Daily gains check complete."
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