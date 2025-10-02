const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const connection = require("./database"); // DB connection

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(
  session({
    secret: "stonebridge_secret_key",
    resave: false,
    saveUninitialized: false,
  })
);

// Authentication middleware
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  res.redirect("/login");
}

// ADMIN login check
function ensureAdmin(req, res, next) {
  if (req.session.user && req.session.user.email === "stonebridge499@gmail.com" && req.session.user.password === "Agrippine2017") {
    return next();
  }
  res.redirect("/login");
}

// Routes
app.get("/", (req, res) => {
  res.redirect("/login");
});

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", (req, res) => {
  const { email, password } = req.body;
  if (email === "stonebridge499@gmail.com" && password === "Agrippine2017") {
    req.session.user = { email, password, username: "Admin" };
    return res.redirect("/admin");
  }

  connection.query(
    "SELECT * FROM users WHERE email = ? AND password = ?",
    [email, password],
    (err, results) => {
      if (err) throw err;
      if (results.length > 0) {
        req.session.user = results[0];
        res.redirect("/dashboard");
      } else {
        res.render("login", { error: "Invalid credentials" });
      }
    }
  );
});

app.get("/register", (req, res) => {
  res.render("register");
});

app.post("/register", (req, res) => {
  const { username, email, password, wallet } = req.body;
  connection.query(
    "INSERT INTO users (username, email, password, wallet, balance) VALUES (?, ?, ?, ?, 0)",
    [username, email, password, wallet],
    (err) => {
      if (err) throw err;
      res.redirect("/login");
    }
  );
});

app.get("/dashboard", ensureAuth, (req, res) => {
  connection.query(
    "SELECT * FROM deposits WHERE user_id = ?",
    [req.session.user.id],
    (err, deposits) => {
      if (err) throw err;
      res.render("dashboard", { user: req.session.user, deposits });
    }
  );
});

app.get("/deposit", ensureAuth, (req, res) => {
  res.render("deposit");
});

app.post("/deposit", ensureAuth, (req, res) => {
  const { amount, wallet } = req.body;
  connection.query(
    "INSERT INTO deposits (user_id, amount, wallet, status) VALUES (?, ?, ?, 'Pending')",
    [req.session.user.id, amount, wallet],
    (err) => {
      if (err) throw err;
      res.redirect("/dashboard");
    }
  );
});

app.get("/withdraw", ensureAuth, (req, res) => {
  res.render("withdraw");
});

app.post("/withdraw", ensureAuth, (req, res) => {
  const { amount, wallet } = req.body;
  connection.query(
    "INSERT INTO withdrawals (user_id, amount, wallet, status) VALUES (?, ?, ?, 'Pending')",
    [req.session.user.id, amount, wallet],
    (err) => {
      if (err) throw err;
      res.redirect("/dashboard");
    }
  );
});

app.get("/admin", ensureAdmin, (req, res) => {
  connection.query("SELECT * FROM users", (err, users) => {
    if (err) throw err;
    connection.query("SELECT * FROM deposits", (err, deposits) => {
      if (err) throw err;
      connection.query("SELECT * FROM withdrawals", (err, withdrawals) => {
        if (err) throw err;
        res.render("admin", { users, deposits, withdrawals });
      });
    });
  });
});

// Approve/reject deposits
app.get("/admin/approveDeposit/:id", ensureAdmin, (req, res) => {
  connection.query(
    "UPDATE deposits SET status='Approved' WHERE id=?",
    [req.params.id],
    (err) => {
      if (err) throw err;
      res.redirect("/admin");
    }
  );
});

app.get("/admin/rejectDeposit/:id", ensureAdmin, (req, res) => {
  connection.query(
    "UPDATE deposits SET status='Rejected' WHERE id=?",
    [req.params.id],
    (err) => {
      if (err) throw err;
      res.redirect("/admin");
    }
  );
});

// Approve/reject withdrawals
app.get("/admin/approveWithdrawal/:id", ensureAdmin, (req, res) => {
  connection.query(
    "UPDATE withdrawals SET status='Approved' WHERE id=?",
    [req.params.id],
    (err) => {
      if (err) throw err;
      res.redirect("/admin");
    }
  );
});

app.get("/admin/rejectWithdrawal/:id", ensureAdmin, (req, res) => {
  connection.query(
    "UPDATE withdrawals SET status='Rejected' WHERE id=?",
    [req.params.id],
    (err) => {
      if (err) throw err;
      res.redirect("/admin");
    }
  );
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
