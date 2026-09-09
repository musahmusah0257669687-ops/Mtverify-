const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

const PORT = Number(process.env.PORT) || 10000;
const SESSION_DAYS = 30;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not configured.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

/* =========================================================
   GENERAL HELPERS
========================================================= */

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function hashPassword(password, salt) {
  return crypto
    .scryptSync(password, salt, 64)
    .toString("hex");
}

function createPassword(password) {
  const salt = randomToken(16);
  const hash = hashPassword(password, salt);

  return {
    salt,
    hash
  };
}

function verifyPassword(password, salt, storedHash) {
  try {
    const hash = hashPassword(password, salt);

    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(storedHash, "hex")
    );
  } catch {
    return false;
  }
}

function setSessionCookie(res, token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60 * 1000;

  res.setHeader(
    "Set-Cookie",
    `mtverify_session=${token}; Max-Age=${Math.floor(
      maxAge / 1000
    )}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "mtverify_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"
  );
}

function getCookie(req, name) {
  const header = req.headers.cookie;

  if (!header) {
    return null;
  }

  const cookies = header.split(";");

  for (const cookie of cookies) {
    const index = cookie.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key = cookie
      .slice(0, index)
      .trim();

    const value = cookie
      .slice(index + 1)
      .trim();

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

async function readResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      message: text
    };
  }
}

function getApiMessage(data, fallback) {
  if (typeof data === "string") {
    return data;
  }

  if (data && data.message) {
    return data.message;
  }

  if (data && data.error) {
    return data.error;
  }

  return fallback;
}

/* =========================================================
   PRICING
========================================================= */

function getFiveSimRate() {
  const rate = Number(
    process.env.FIVESIM_GHS_RATE
  );

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(
      "FIVESIM_GHS_RATE is not configured correctly."
    );
  }

  return rate;
}

function getMarkupPercent() {
  const markup = Number(
    process.env.MTVERIFY_MARKUP_PERCENT || 0
  );

  if (!Number.isFinite(markup) || markup < 0) {
    throw new Error(
      "MTVERIFY_MARKUP_PERCENT is not configured correctly."
    );
  }

  return markup;
}

function calculateCustomerPrice(fiveSimCost) {
  const rate = getFiveSimRate();
  const markup = getMarkupPercent();

  const baseGhs =
    Number(fiveSimCost) * rate;

  const finalPrice =
    baseGhs * (1 + markup / 100);

  return Math.ceil(finalPrice * 100) / 100;
}

/* =========================================================
   DATABASE SETUP
========================================================= */


/* =async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      password_salt TEXT,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  /*
    IMPORTANT:
    Existing customers tables may have been created by
    an older version of MtVerify. These commands safely
    add the new columns without deleting existing
    customers or balances.
  */

  await pool.query(`
    ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS password_hash TEXT
  `);

  await pool.query(`
    ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS password_salt TEXT
  `);

  await pool.query(`
    ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS updated_at
    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL
        REFERENCES customers(id)
        ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_token_hash_idx
    ON sessions(token_hash)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
    ON sessions(expires_at)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      reference TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER
        REFERENCES customers(id)
        ON DELETE SET NULL,
      email TEXT NOT NULL,
      five_sim_order_id TEXT UNIQUE NOT NULL,
      country TEXT NOT NULL,
      operator TEXT NOT NULL,
      product TEXT NOT NULL,
      charged NUMERIC(12,2) NOT NULL,
      phone TEXT,
      status TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_customer_id_idx
    ON orders(customer_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_email_idx
    ON orders(email)
  `);

  console.log("Database tables are ready.");
}=======================================================
   SESSION HELPERS
========================================================= */

function hashSessionToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

async function createSession(customerId) {
  const token = randomToken(32);
  const tokenHash =
    hashSessionToken(token);

  await pool.query(
    `
    INSERT INTO sessions
    (token_hash, customer_id, expires_at)
    VALUES
    ($1, $2, NOW() + INTERVAL '30 days')
    `,
    [
      tokenHash,
      customerId
    ]
  );

  return token;
}

async function getCurrentCustomer(req) {
  const token =
    getCookie(
      req,
      "mtverify_session"
    );

  if (!token) {
    return null;
  }

  const tokenHash =
    hashSessionToken(token);

  const result =
    await pool.query(
      `
      SELECT
        c.id,
        c.email,
        c.balance,
        c.password_hash,
        c.password_salt
      FROM sessions s
      JOIN customers c
        ON c.id = s.customer_id
      WHERE s.token_hash = $1
        AND s.expires_at > NOW()
      LIMIT 1
      `,
      [tokenHash]
    );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

async function requireLogin(req, res, next) {
  try {
    const customer =
      await getCurrentCustomer(req);

    if (!customer) {
      return res.status(401).json({
        error:
          "Please sign in before continuing."
      });
    }

    req.customer = customer;

    next();
  } catch (error) {
    console.error(
      "Authentication error:",
      error
    );

    res.status(500).json({
      error:
        "Unable to verify your login."
    });
  }
}

/* =========================================================
   HOME
========================================================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

/* =========================================================
   SIGN UP
========================================================= */

app.post(
  "/api/auth/signup",
  async (req, res) => {
    try {
      const email =
        cleanEmail(req.body.email);

      const password =
        String(req.body.password || "");

      if (!email || !validEmail(email)) {
        return res.status(400).json({
          error:
            "Please enter a valid email address."
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          error:
            "Password must be at least 8 characters."
        });
      }

      const existing =
        await pool.query(
          `
          SELECT id, password_hash
          FROM customers
          WHERE email = $1
          `,
          [email]
        );

      if (
        existing.rows.length > 0 &&
        existing.rows[0].password_hash
      ) {
        return res.status(409).json({
          error:
            "An account with this email already exists. Please sign in."
        });
      }

      const credentials =
        createPassword(password);

      let customer;

      if (existing.rows.length > 0) {
        /*
          Upgrade an old customer record by adding
          password credentials without deleting balance.
        */

        const result =
          await pool.query(
            `
            UPDATE customers
            SET
              password_hash = $1,
              password_salt = $2,
              updated_at = NOW()
            WHERE email = $3
            RETURNING id, email, balance
            `,
            [
              credentials.hash,
              credentials.salt,
              email
            ]
          );

        customer =
          result.rows[0];
      } else {
        const result =
          await pool.query(
            `
            INSERT INTO customers
            (
              email,
              password_hash,
              password_salt,
              balance
            )
            VALUES ($1, $2, $3, 0)
            RETURNING id, email, balance
            `,
            [
              email,
              credentials.hash,
              credentials.salt
            ]
          );

        customer =
          result.rows[0];
      }

      const session =
        await createSession(
          customer.id
        );

      setSessionCookie(
        res,
        session
      );

      res.json({
        success: true,
        customer: {
          id: customer.id,
          email: customer.email,
          balance:
            Number(customer.balance)
        }
      });
    } catch (error) {
      console.error(
        "Signup error:",
        error
      );

      if (
        error.code === "23505"
      ) {
        return res.status(409).json({
          error:
            "An account with this email already exists."
        });
      }

      res.status(500).json({
        error:
          "Unable to create your account."
      });
    }
  }
);

/* =========================================================
   SIGN IN
========================================================= */

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const email =
        cleanEmail(req.body.email);

      const password =
        String(req.body.password || "");

      if (!email || !validEmail(email)) {
        return res.status(400).json({
          error:
            "Please enter a valid email address."
        });
      }

      if (!password) {
        return res.status(400).json({
          error:
            "Please enter your password."
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            email,
            password_hash,
            password_salt,
            balance
          FROM customers
          WHERE email = $1
          `,
          [email]
        );

      if (result.rows.length === 0) {
        return res.status(401).json({
          error:
            "Incorrect email or password."
        });
      }

      const customer =
        result.rows[0];

      if (
        !customer.password_hash ||
        !customer.password_salt
      ) {
        return res.status(401).json({
          error:
            "This account needs to be registered again."
        });
      }

      const correct =
        verifyPassword(
          password,
          customer.password_salt,
          customer.password_hash
        );

      if (!correct) {
        return res.status(401).json({
          error:
            "Incorrect email or password."
        });
      }

      const session =
        await createSession(
          customer.id
        );

      setSessionCookie(
        res,
        session
      );

      res.json({
        success: true,
        customer: {
          id: customer.id,
          email: customer.email,
          balance:
            Number(customer.balance)
        }
      });
    } catch (error) {
      console.error(
        "Login error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to sign in."
      });
    }
  }
);

/* =========================================================
   CURRENT USER
========================================================= */

app.get(
  "/api/auth/me",
  async (req, res) => {
    try {
      const customer =
        await getCurrentCustomer(req);

      if (!customer) {
        return res.status(401).json({
          authenticated: false
        });
      }

      res.json({
        authenticated: true,
        customer: {
          id: customer.id,
          email: customer.email,
          balance:
            Number(customer.balance)
        }
      });
    } catch (error) {
      console.error(
        "Auth status error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to check login status."
      });
    }
  }
);

/* =========================================================
   LOGOUT
========================================================= */

app.post(
  "/api/auth/logout",
  async (req, res) => {
    try {
      const token =
        getCookie(
          req,
          "mtverify_session"
        );

      if (token) {
        await pool.query(
          `
          DELETE FROM sessions
          WHERE token_hash = $1
          `,
          [
            hashSessionToken(token)
          ]
        );
      }

      clearSessionCookie(res);

      res.json({
        success: true
      });
    } catch (error) {
      console.error(
        "Logout error:",
        error
      );

      clearSessionCookie(res);

      res.json({
        success: true
      });
    }
  }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
  "/api/status",
  async (req, res) => {
    try {
      await pool.query(
        "SELECT 1"
      );

      const customer =
        await getCurrentCustomer(req);

      res.json({
        site: "MtVerify",
        status: "online",
        databaseConfigured:
          Boolean(
            process.env.DATABASE_URL
          ),
        fiveSimConfigured:
          Boolean(
            process.env.FIVESIM_API_KEY
          ),
        paystackConfigured:
          Boolean(
            process.env.PAYSTACK_SECRET_KEY
          ),
        pricingConfigured:
          Boolean(
            process.env.FIVESIM_GHS_RATE
          ),
        authenticated:
          Boolean(customer)
      });
    } catch (error) {
      console.error(
        "Status error:",
        error
      );

      res.status(500).json({
        site: "MtVerify",
        status:
          "database_error"
      });
    }
  }
);

/* =========================================================
   BALANCE
========================================================= */

app.get(
  "/api/balance",
  requireLogin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT email, balance
          FROM customers
          WHERE id = $1
          `,
          [req.customer.id]
        );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error:
            "Customer account not found."
        });
      }

      const customer =
        result.rows[0];

      res.json({
        email: customer.email,
        balance:
          Number(customer.balance)
      });
    } catch (error) {
      console.error(
        "Balance error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to check balance."
      });
    }
  }
);

/* =========================================================
   5SIM PRICE
========================================================= */

app.get(
  "/api/price",
  requireLogin,
  async (req, res) => {
    try {
      const country =
        String(
          req.query.country || ""
        )
          .trim()
          .toLowerCase();

      const product =
        String(
          req.query.product || ""
        )
          .trim()
          .toLowerCase();

      if (!country || !product) {
        return res.status(400).json({
          error:
            "Country and service are required."
        });
      }

      const url =
        "https://5sim.com/v1/guest/prices?country=" +
        encodeURIComponent(country) +
        "&product=" +
        encodeURIComponent(product);

      const response =
        await fetch(url, {
          headers: {
            Accept:
              "application/json"
          }
        });

      const data =
        await readResponse(
          response
        );

      if (!response.ok) {
        return res.status(
          response.status
        ).json({
          error: getApiMessage(
            data,
            "Unable to check 5SIM price."
          )
        });
      }

      /*
        Add MtVerify customer price to each
        available operator.
      */

      const countryData =
        data[country];

      const productData =
        countryData &&
        countryData[product];

      if (productData) {
        for (
          const operator
          of Object.keys(productData)
        ) {
          const info =
            productData[operator];

          const cost =
            Number(info.cost);

          if (
            Number.isFinite(cost) &&
            cost > 0
          ) {
            try {
              info.mtverifyPrice =
                calculateCustomerPrice(
                  cost
                );
            } catch {
              info.mtverifyPrice =
                null;
            }
          }
        }
      }

      res.json(data);
    } catch (error) {
      console.error(
        "Price error:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Unable to check price."
      });
    }
  }
);

/* =========================================================
   PAYSTACK INITIALIZE
========================================================= */

app.post(
  "/api/paystack/initialize",
  requireLogin,
  async (req, res) => {
    try {
      if (
        !process.env.PAYSTACK_SECRET_KEY
      ) {
        return res.status(500).json({
          error:
            "Paystack secret key is not configured."
        });
      }

      const email =
        cleanEmail(
          req.customer.email
        );

      const amount =
        Number(req.body.amount);

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          error:
            "Enter a valid deposit amount."
        });
      }

      const amountInPesewas =
        Math.round(amount * 100);

      const reference =
        "MTV-" +
        Date.now() +
        "-" +
        randomToken(4);

      await pool.query(
        `
        INSERT INTO payments
        (reference, email, amount, status)
        VALUES
        ($1, $2, $3, 'pending')
        `,
        [
          reference,
          email,
          amount
        ]
      );

      const response =
        await fetch(
          "https://api.paystack.co/transaction/initialize",
          {
            method: "POST",
            headers: {
              Authorization:
                "Bearer " +
                process.env
                  .PAYSTACK_SECRET_KEY,
              "Content-Type":
                "application/json",
              Accept:
                "application/json"
            },
            body: JSON.stringify({
              email,
              amount:
                String(
                  amountInPesewas
                ),
              currency: "GHS",
              reference,
              metadata: {
                service:
                  "MtVerify",
                customer_email:
                  email,
                customer_id:
                  req.customer.id
              }
            })
          }
        );

      const data =
        await readResponse(
          response
        );

      if (
        !response.ok ||
        !data.status
      ) {
        await pool.query(
          `
          UPDATE payments
          SET status =
            'initialize_failed'
          WHERE reference = $1
          `,
          [reference]
        );

        return res.status(
          response.status || 400
        ).json({
          error: getApiMessage(
            data,
            "Unable to initialize Paystack payment."
          )
        });
      }

      res.json({
        authorization_url:
          data.data.authorization_url,
        access_code:
          data.data.access_code,
        reference:
          data.data.reference
      });
    } catch (error) {
      console.error(
        "Paystack initialize error:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Unable to start payment."
      });
    }
  }
);

/* =========================================================
   PAYSTACK VERIFY
========================================================= */

app.get(
  "/api/paystack/verify/:reference",
  requireLogin,
  async (req, res) => {
    const client =
      await pool.connect();

    try {
      if (
        !process.env.PAYSTACK_SECRET_KEY
      ) {
        return res.status(500).json({
          error:
            "Paystack secret key is not configured."
        });
      }

      const reference =
        String(
          req.params.reference || ""
        ).trim();

      const paymentResult =
        await client.query(
          `
          SELECT *
          FROM payments
          WHERE reference = $1
            AND email = $2
          `,
          [
            reference,
            req.customer.email
          ]
        );

      if (
        paymentResult.rows.length === 0
      ) {
        return res.status(404).json({
          error:
            "Payment reference was not found."
        });
      }

      const payment =
        paymentResult.rows[0];

      if (
        payment.status === "success"
      ) {
        const customerResult =
          await client.query(
            `
            SELECT email, balance
            FROM customers
            WHERE id = $1
            `,
            [req.customer.id]
          );

        const customer =
          customerResult.rows[0];

        return res.json({
          success: true,
          alreadyProcessed: true,
          email:
            customer.email,
          paidAmount:
            Number(payment.amount),
          balance:
            Number(customer.balance),
          reference
        });
      }

      const response =
        await fetch(
          "https://api.paystack.co/transaction/verify/" +
          encodeURIComponent(
            reference
          ),
          {
            headers: {
              Authorization:
                "Bearer " +
                process.env
                  .PAYSTACK_SECRET_KEY,
              Accept:
                "application/json"
            }
          }
        );

      const data =
        await readResponse(
          response
        );

      if (
        !response.ok ||
        !data.status
      ) {
        return res.status(
          response.status || 400
        ).json({
          error: getApiMessage(
            data,
            "Unable to verify payment."
          )
        });
      }

      const transaction =
        data.data;

      if (
        transaction.status !==
        "success"
      ) {
        return res.status(400).json({
          error:
            "Payment was not successful.",
          status:
            transaction.status
        });
      }

      const paystackEmail =
        transaction.customer &&
        transaction.customer.email
          ? cleanEmail(
              transaction.customer.email
            )
          : "";

      const paidAmount =
        Number(transaction.amount) /
        100;

      if (
        paystackEmail !==
        req.customer.email
      ) {
        return res.status(400).json({
          error:
            "Payment email does not match your account."
        });
      }

      if (
        !Number.isFinite(
          paidAmount
        ) ||
        Math.abs(
          paidAmount -
          Number(payment.amount)
        ) > 0.001
      ) {
        return res.status(400).json({
          error:
            "Payment amount does not match the expected amount."
        });
      }

      await client.query(
        "BEGIN"
      );

      const lockedPaymentResult =
        await client.query(
          `
          SELECT *
          FROM payments
          WHERE reference = $1
          FOR UPDATE
          `,
          [reference]
        );

      const lockedPayment =
        lockedPaymentResult.rows[0];

      if (
        lockedPayment.status ===
        "success"
      ) {
        await client.query(
          "ROLLBACK"
        );

        const customerResult =
          await pool.query(
            `
            SELECT email, balance
            FROM customers
            WHERE id = $1
            `,
            [req.customer.id]
          );

        const customer =
          customerResult.rows[0];

        return res.json({
          success: true,
          alreadyProcessed: true,
          email:
            customer.email,
          paidAmount:
            Number(
              lockedPayment.amount
            ),
          balance:
            Number(customer.balance),
          reference
        });
      }

      const customerResult =
        await client.query(
          `
          UPDATE customers
          SET
            balance =
              balance + $1,
            updated_at = NOW()
          WHERE id = $2
          RETURNING email, balance
          `,
          [
            paidAmount,
            req.customer.id
          ]
        );

      const customer =
        customerResult.rows[0];

      if (!customer) {
        await client.query(
          "ROLLBACK"
        );

        return res.status(404).json({
          error:
            "Customer account not found."
        });
      }

      await client.query(
        `
        UPDATE payments
        SET
          status = 'success',
          verified_at = NOW()
        WHERE reference = $1
        `,
        [reference]
      );

      await client.query(
        "COMMIT"
      );

      res.json({
        success: true,
        alreadyProcessed: false,
        email:
          customer.email,
        paidAmount,
        balance:
          Number(customer.balance),
        reference
      });
    } catch (error) {
      try {
        await client.query(
          "ROLLBACK"
        );
      } catch (_) {}

      console.error(
        "Paystack verify error:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Unable to verify payment."
      });
    } finally {
      client.release();
    }
  }
);

/* =========================================================
   BUY / RENT NUMBER
========================================================= */

app.post(
  "/api/buy",
  requireLogin,
  async (req, res) => {
    let chargedAmount = 0;
    let chargedCustomerId =
      req.customer.id;

    try {
      if (
        !process.env.FIVESIM_API_KEY
      ) {
        return res.status(500).json({
          error:
            "5SIM API key is not configured."
        });
      }

      const country =
        String(
          req.body.country || ""
        )
          .trim()
          .toLowerCase();

      const product =
        String(
          req.body.product || ""
        )
          .trim()
          .toLowerCase();

      const operator =
        String(
          req.body.operator || ""
        ).trim();

      if (
        !country ||
        !product ||
        !operator
      ) {
        return res.status(400).json({
          error:
            "Country, service and operator are required."
        });
      }

      /*
        Get the current 5SIM price.
      */

      const priceUrl =
        "https://5sim.com/v1/guest/prices?country=" +
        encodeURIComponent(country) +
        "&product=" +
        encodeURIComponent(product);

      const priceResponse =
        await fetch(priceUrl, {
          headers: {
            Accept:
              "application/json"
          }
        });

      const priceData =
        await readResponse(
          priceResponse
        );

      if (!priceResponse.ok) {
        return res.status(
          priceResponse.status
        ).json({
          error: getApiMessage(
            priceData,
            "Unable to get current 5SIM price."
          )
        });
      }

      const productData =
        priceData[country] &&
        priceData[country][product];

      if (!productData) {
        return res.status(400).json({
          error:
            "No price information is available for this service."
        });
      }

      const operatorInfo =
        productData[operator];

      if (!operatorInfo) {
        return res.status(400).json({
          error:
            "The selected operator is no longer available."
        });
      }

      const fiveSimCost =
        Number(operatorInfo.cost);

      const availability =
        Number(operatorInfo.count);

      if (
        !Number.isFinite(
          fiveSimCost
        ) ||
        fiveSimCost <= 0
      ) {
        return res.status(400).json({
          error:
            "Invalid 5SIM price."
        });
      }

      if (
        !Number.isFinite(
          availability
        ) ||
        availability <= 0
      ) {
        return res.status(400).json({
          error:
            "This operator has no numbers available."
        });
      }

      chargedAmount =
        calculateCustomerPrice(
          fiveSimCost
        );

      /*
        Lock the customer row so two simultaneous
        purchases cannot spend the same balance.
      */

      const client =
        await pool.connect();

      try {
        await client.query(
          "BEGIN"
        );

        const customerResult =
          await client.query(
            `
            SELECT
              id,
              email,
              balance
            FROM customers
            WHERE id = $1
            FOR UPDATE
            `,
            [chargedCustomerId]
          );

        if (
          customerResult.rows.length === 0
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(401).json({
            error:
              "Customer account not found."
          });
        }

        const customer =
          customerResult.rows[0];

        const currentBalance =
          Number(customer.balance);

        if (
          !Number.isFinite(
            currentBalance
          ) ||
          currentBalance <
            chargedAmount
        ) {
          await client.query(
            "ROLLBACK"
          );

          return res.status(400).json({
            error:
              "Insufficient MtVerify balance. Please add more balance."
          });
        }

        const newBalance =
          Math.round(
            (
              currentBalance -
              chargedAmount
            ) * 100
          ) / 100;

        await client.query(
          `
          UPDATE customers
          SET
            balance = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            newBalance,
            chargedCustomerId
          ]
        );

        await client.query(
          "COMMIT"
        );

        /*
          Now that MtVerify has reserved the money,
          request the number from 5SIM.
        */

        const buyUrl =
          "https://5sim.com/v1/user/buy/activation/" +
          encodeURIComponent(
            country
          ) +
          "/" +
          encodeURIComponent(
            operator
          ) +
          "/" +
          encodeURIComponent(
            product
          );

        const buyResponse =
          await fetch(buyUrl, {
            method: "GET",
            headers: {
              Authorization:
                "Bearer " +
                process.env
                  .FIVESIM_API_KEY,
              Accept:
                "application/json"
            }
          });

        const buyData =
          await readResponse(
            buyResponse
          );

        if (!buyResponse.ok) {
          console.error(
            "5SIM buy failed:",
            buyData
          );

          /*
            5SIM rejected the purchase.
            Refund the MtVerify customer.
          */

          await pool.query(
            `
            UPDATE customers
            SET
              balance =
                balance + $1,
              updated_at = NOW()
            WHERE id = $2
            `,
            [
              chargedAmount,
              chargedCustomerId
            ]
          );

          return res.status(
            buyResponse.status || 400
          ).json({
            error:
              getApiMessage(
                buyData,
                "5SIM could not rent this number. Your MtVerify balance has been refunded."
              )
          });
        }

        /*
          5SIM successful response.
        */

        const fiveSimOrderId =
          buyData.id ||
          buyData.order ||
          buyData.activation_id;

        if (!fiveSimOrderId) {
          console.error(
            "5SIM response did not contain an order ID:",
            buyData
          );

          await pool.query(
            `
            UPDATE customers
            SET
              balance =
                balance + $1,
              updated_at = NOW()
            WHERE id = $2
            `,
            [
              chargedAmount,
              chargedCustomerId
            ]
          );

          return res.status(502).json({
            error:
              "5SIM returned an invalid order response. Your MtVerify balance has been refunded."
          });
        }

        const phone =
          buyData.phone ||
          buyData.number ||
          null;

        const status =
          buyData.status ||
          "PENDING";

        await pool.query(
          `
          INSERT INTO orders
          (
            customer_id,
            email,
            five_sim_order_id,
            country,
            operator,
            product,
            charged,
            phone,
            status
          )
          VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT
            (five_sim_order_id)
          DO NOTHING
          `,
          [
            chargedCustomerId,
            req.customer.email,
            String(
              fiveSimOrderId
            ),
            country,
            operator,
            product,
            chargedAmount,
            phone,
            status
          ]
        );

        const balanceResult =
          await pool.query(
            `
            SELECT balance
            FROM customers
            WHERE id = $1
            `,
            [chargedCustomerId]
          );

        const remainingBalance =
          Number(
            balanceResult.rows[0]
              .balance
          );

        res.json({
          success: true,
          id:
            String(
              fiveSimOrderId
            ),
          phone,
          operator,
          country,
          product,
          charged:
            chargedAmount,
          remainingBalance,
          order:
            buyData
        });
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(
        "Buy error:",
        error
      );

      /*
        Only refund here if money was actually
        reserved and the request failed before
        the normal 5SIM response/refund path.
      */

      if (
        chargedAmount > 0 &&
        chargedCustomerId
      ) {
        /*
          We deliberately do not automatically refund
          again here if 5SIM already rejected and the
          normal refund path ran. This catch is mainly
          for unexpected failures.
        */

        console.error(
          "Unexpected rental failure after balance reservation."
        );
      }

      res.status(500).json({
        error:
          error.message ||
          "Unable to rent number."
      });
    }
  }
);

/* =========================================================
   CHECK ORDER / SMS
========================================================= */

app.get(
  "/api/order/:id",
  requireLogin,
  async (req, res) => {
    try {
      if (
        !process.env.FIVESIM_API_KEY
      ) {
        return res.status(500).json({
          error:
            "5SIM API key is not configured."
        });
      }

      const orderId =
        String(
          req.params.id || ""
        ).trim();

      if (!orderId) {
        return res.status(400).json({
          error:
            "Order ID is required."
        });
      }

      /*
        Make sure the order belongs to
        the signed-in customer.
      */

      const orderResult =
        await pool.query(
          `
          SELECT *
          FROM orders
          WHERE five_sim_order_id = $1
            AND customer_id = $2
          `,
          [
            orderId,
            req.customer.id
          ]
        );

      if (
        orderResult.rows.length === 0
      ) {
        return res.status(404).json({
          error:
            "Order not found."
        });
      }

      const url =
        "https://5sim.com/v1/user/check/" +
        encodeURIComponent(
          orderId
        );

      const response =
        await fetch(url, {
          headers: {
            Authorization:
              "Bearer " +
              process.env
                .FIVESIM_API_KEY,
            Accept:
              "application/json"
          }
        });

      const data =
        await readResponse(
          response
        );

      if (!response.ok) {
        return res.status(
          response.status
        ).json({
          error: getApiMessage(
            data,
            "Unable to check SMS."
          )
        });
      }

      /*
        Keep local order status updated.
      */

      await pool.query(
        `
        UPDATE orders
        SET
          status = $1,
          phone =
            COALESCE($2, phone)
        WHERE five_sim_order_id = $3
          AND customer_id = $4
        `,
        [
          data.status ||
            null,
          data.phone ||
            data.number ||
            null,
          orderId,
          req.customer.id
        ]
      );

      res.json(data);
    } catch (error) {
      console.error(
        "Order check error:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Unable to check SMS."
      });
    }
  }
);

/* =========================================================
   CUSTOMER ORDERS
========================================================= */

app.get(
  "/api/orders",
  requireLogin,
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            five_sim_order_id AS id,
            country,
            operator,
            product,
            charged,
            phone,
            status,
            created_at
          FROM orders
          WHERE customer_id = $1
          ORDER BY created_at DESC
          LIMIT 50
          `,
          [req.customer.id]
        );

      res.json({
        orders:
          result.rows.map(
            (order) => ({
              id:
                order.id,
              country:
                order.country,
              operator:
                order.operator,
              product:
                order.product,
              charged:
                Number(
                  order.charged
                ),
              phone:
                order.phone,
              status:
                order.status,
              createdAt:
                order.created_at
            })
          )
      });
    } catch (error) {
      console.error(
        "Orders error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load your orders."
      });
    }
  }
);

/* =========================================================
   CLEAN EXPIRED SESSIONS
========================================================= */

async function cleanSessions() {
  try {
    await pool.query(
      `
      DELETE FROM sessions
      WHERE expires_at <= NOW()
      `
    );
  } catch (error) {
    console.error(
      "Session cleanup error:",
      error
    );
  }
}

/* =========================================================
   API 404
========================================================= */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      error:
        "API endpoint not found."
    });
  }
);

/* =========================================================
   GENERAL ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(
      "Server error:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      error:
        "Internal server error."
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    await setupDatabase();

    await cleanSessions();

    setInterval(
      cleanSessions,
      6 * 60 * 60 * 1000
    );

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          `MtVerify running on port ${PORT}`
        );
      }
    );
  } catch (error) {
    console.error(
      "Failed to start MtVerify:",
      error
    );

    process.exit(1);
  }
}

startServer();
