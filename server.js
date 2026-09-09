const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* Safely read JSON OR plain-text responses */
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

/* Get a useful error message from any API response */
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

async function setupDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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

  console.log("Database tables are ready.");
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


/* STATUS */
app.get("/api/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      site: "MtVerify",
      status: "online",
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      fiveSimConfigured: Boolean(process.env.FIVESIM_API_KEY),
      paystackConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY)
    });

  } catch (error) {
    console.error("Status error:", error);

    res.status(500).json({
      site: "MtVerify",
      status: "database_error"
    });
  }
});


/* 5SIM PRICE */
app.get("/api/price", async (req, res) => {
  try {
    const country =
      String(req.query.country || "")
        .trim()
        .toLowerCase();

    const product =
      String(req.query.product || "")
        .trim()
        .toLowerCase();

    if (!country || !product) {
      return res.status(400).json({
        error: "Country and service are required."
      });
    }

    const url =
      "https://5sim.com/v1/guest/prices?country=" +
      encodeURIComponent(country) +
      "&product=" +
      encodeURIComponent(product);

    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    const data = await readResponse(response);

    if (!response.ok) {
      return res.status(response.status).json({
        error: getApiMessage(
          data,
          "Unable to check 5SIM price."
        )
      });
    }

    res.json(data);

  } catch (error) {
    console.error("Price error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to check price."
    });
  }
});


/* CUSTOMER */
async function getOrCreateCustomer(email) {
  const cleanEmail =
    String(email)
      .trim()
      .toLowerCase();

  const result = await pool.query(
    `
    INSERT INTO customers (email)
    VALUES ($1)
    ON CONFLICT (email)
    DO UPDATE SET updated_at = NOW()
    RETURNING id, email, balance
    `,
    [cleanEmail]
  );

  return result.rows[0];
}


/* PAYSTACK INITIALIZE */
app.post("/api/paystack/initialize", async (req, res) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        error: "Paystack secret key is not configured."
      });
    }

    const { email, amount } = req.body;

    if (!email || !amount) {
      return res.status(400).json({
        error: "Email and amount are required."
      });
    }

    const cleanEmail =
      String(email)
        .trim()
        .toLowerCase();

    const numericAmount =
      Number(amount);

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        error: "Enter a valid deposit amount."
      });
    }

    await getOrCreateCustomer(cleanEmail);

    const amountInPesewas =
      Math.round(numericAmount * 100);

    const reference =
      "MTV-" +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex");

    await pool.query(
      `
      INSERT INTO payments
      (reference, email, amount, status)
      VALUES ($1, $2, $3, 'pending')
      `,
      [
        reference,
        cleanEmail,
        numericAmount
      ]
    );

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization:
            "Bearer " +
            process.env.PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          email: cleanEmail,
          amount: String(amountInPesewas),
          currency: "GHS",
          reference,
          metadata: {
            service: "MtVerify",
            customer_email: cleanEmail
          }
        })
      }
    );

    const data =
      await readResponse(response);

    if (!response.ok || !data.status) {

      await pool.query(
        `
        UPDATE payments
        SET status = 'initialize_failed'
        WHERE reference = $1
        `,
        [reference]
      );

      return res.status(
        response.status || 400
      ).json({
        error:
          getApiMessage(
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
});


/* PAYSTACK VERIFY */
app.get(
  "/api/paystack/verify/:reference",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      if (!process.env.PAYSTACK_SECRET_KEY) {
        return res.status(500).json({
          error:
            "Paystack secret key is not configured."
        });
      }

      const reference =
        req.params.reference;

      const paymentResult =
        await client.query(
          `
          SELECT *
          FROM payments
          WHERE reference = $1
          `,
          [reference]
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

      if (payment.status === "success") {

        const customerResult =
          await client.query(
            `
            SELECT email, balance
            FROM customers
            WHERE email = $1
            `,
            [payment.email]
          );

        const customer =
          customerResult.rows[0];

        return res.json({
          success: true,
          alreadyProcessed: true,
          email: customer.email,
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
          encodeURIComponent(reference),
          {
            headers: {
              Authorization:
                "Bearer " +
                process.env.PAYSTACK_SECRET_KEY,
              Accept: "application/json"
            }
          }
        );

      const data =
        await readResponse(response);

      if (!response.ok || !data.status) {
        return res.status(
          response.status || 400
        ).json({
          error:
            getApiMessage(
              data,
              "Unable to verify payment."
            )
        });
      }

      const transaction =
        data.data;

      if (
        transaction.status !== "success"
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
          ? transaction.customer.email
              .trim()
              .toLowerCase()
          : "";

      const paidAmount =
        Number(transaction.amount) / 100;

      if (
        paystackEmail !== payment.email
      ) {
        return res.status(400).json({
          error:
            "Payment email does not match the payment record."
        });
      }

      if (
        !Number.isFinite(paidAmount) ||
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

      await client.query("BEGIN");

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
            WHERE email = $1
            `,
            [payment.email]
          );

        const customer =
          customerResult.rows[0];

        return res.json({
          success: true,
          alreadyProcessed: true,
          email: customer.email,
          paidAmount:
            Number(payment.amount),
          balance:
            Number(customer.balance),
          reference
        });
      }

      const customerResult =
        await client.query(
          `
          INSERT INTO customers
          (email, balance)
          VALUES ($1, $2)
          ON CONFLICT (email)
          DO UPDATE SET
            balance =
              customers.balance +
              EXCLUDED.balance,
            updated_at = NOW()
          RETURNING email, balance
          `,
          [
            payment.email,
            paidAmount
          ]
        );

      const customer =
        customerResult.rows[0];

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

      await client.query("COMMIT");

      res.json({
        success: true,
        alreadyProcessed: false,
        email: customer.email,
        paidAmount,
        balance:
          Number(customer.balance),
        reference
      });

    } catch (error) {

      try {
       
