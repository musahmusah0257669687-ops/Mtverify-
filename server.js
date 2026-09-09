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

if (!process.env.FIVESIM_API_KEY) {
  console.warn("FIVESIM_API_KEY is not configured.");
}

if (!process.env.PAYSTACK_SECRET_KEY) {
  console.warn("PAYSTACK_SECRET_KEY is not configured.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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


// ===============================
// 5SIM PRICE
// ===============================

app.get("/api/price", async (req, res) => {
  try {
    const country = String(req.query.country || "").trim().toLowerCase();
    const product = String(req.query.product || "").trim().toLowerCase();

    if (!country || !product) {
      return res.status(400).json({
        error: "Country and service are required."
      });
    }

    const url =
      `https://5sim.com/v1/guest/prices?country=` +
      `${encodeURIComponent(country)}` +
      `&product=${encodeURIComponent(product)}`;

    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    console.error("Price error:", error);

    res.status(500).json({
      error: error.message || "Unable to check price."
    });
  }
});


// ===============================
// CUSTOMER
// ===============================

async function getOrCreateCustomer(email) {
  const cleanEmail = String(email).trim().toLowerCase();

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


// ===============================
// PAYSTACK INITIALIZE
// ===============================

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

    const cleanEmail = String(email).trim().toLowerCase();
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: "Enter a valid deposit amount."
      });
    }

    if (numericAmount < 1) {
      return res.status(400).json({
        error: "Minimum deposit is GH₵1."
      });
    }

    await getOrCreateCustomer(cleanEmail);

    const amountInPesewas = Math.round(numericAmount * 100);

    const reference =
      `MTV-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    await pool.query(
      `
      INSERT INTO payments
      (reference, email, amount, status)
      VALUES ($1, $2, $3, 'pending')
      `,
      [reference, cleanEmail, numericAmount]
    );

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
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

    const data = await response.json();

    if (!response.ok || !data.status) {
      await pool.query(
        `
        UPDATE payments
        SET status = 'initialize_failed'
        WHERE reference = $1
        `,
        [reference]
      );

      return res.status(response.status || 400).json({
        error:
          data.message ||
          "Unable to initialize Paystack payment."
      });
    }

    res.json({
      authorization_url: data.data.authorization_url,
      access_code: data.data.access_code,
      reference: data.data.reference
    });
  } catch (error) {
    console.error("Paystack initialize error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to start payment."
    });
  }
});


// ===============================
// PAYSTACK VERIFY
// ===============================

app.get("/api/paystack/verify/:reference", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        error: "Paystack secret key is not configured."
      });
    }

    const reference = req.params.reference;

    const paymentResult = await client.query(
      `
      SELECT *
      FROM payments
      WHERE reference = $1
      `,
      [reference]
    );

    if (paymentResult.rows.length === 0) {
      return res.status(404).json({
        error: "Payment reference was not found."
      });
    }

    const payment = paymentResult.rows[0];

    if (payment.status === "success") {
      const customerResult = await client.query(
        `
        SELECT email, balance
        FROM customers
        WHERE email = $1
        `,
        [payment.email]
      );

      const customer = customerResult.rows[0];

      return res.json({
        success: true,
        alreadyProcessed: true,
        email: customer.email,
        paidAmount: Number(payment.amount),
        balance: Number(customer.balance),
        reference
      });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization:
            `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(response.status || 400).json({
        error:
          data.message ||
          "Unable to verify payment."
      });
    }

    const transaction = data.data;

    if (transaction.status !== "success") {
      return res.status(400).json({
        error: "Payment was not successful.",
        status: transaction.status
      });
    }

    const paystackEmail =
      transaction.customer &&
      transaction.customer.email
        ? transaction.customer.email.trim().toLowerCase()
        : "";

    const paidAmount =
      Number(transaction.amount) / 100;

    if (paystackEmail !== payment.email) {
      return res.status(400).json({
        error: "Payment email does not match the payment record."
      });
    }

    if (
      !Number.isFinite(paidAmount) ||
      Math.abs(paidAmount - Number(payment.amount)) > 0.001
    ) {
      return res.status(400).json({
        error: "Payment amount does not match the expected amount."
      });
    }

    await client.query("BEGIN");

    const lockedPaymentResult = await client.query(
      `
      SELECT *
      FROM payments
      WHERE reference = $1
      FOR UPDATE
      `,
      [reference]
    );

    const lockedPayment = lockedPaymentResult.rows[0];

    if (lockedPayment.status === "success") {
      await client.query("ROLLBACK");

      const customerResult = await pool.query(
        `
        SELECT email, balance
        FROM customers
        WHERE email = $1
        `,
        [payment.email]
      );

      const customer = customerResult.rows[0];

      return res.json({
        success: true,
        alreadyProcessed: true,
        email: customer.email,
        paidAmount: Number(payment.amount),
        balance: Number(customer.balance),
        reference
      });
    }

    const customerResult = await client.query(
      `
      INSERT INTO customers (email, balance)
      VALUES ($1, $2)
      ON CONFLICT (email)
      DO UPDATE SET
        balance = customers.balance + EXCLUDED.balance,
        updated_at = NOW()
      RETURNING email, balance
      `,
      [payment.email, paidAmount]
    );

    const customer = customerResult.rows[0];

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
      balance: Number(customer.balance),
      reference
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("Paystack verification error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to verify payment."
    });
  } finally {
    client.release();
  }
});


// ===============================
// BALANCE
// ===============================

app.get("/api/balance", async (req, res) => {
  try {
    const email =
      String(req.query.email || "")
        .trim()
        .toLowerCase();

    if (!email) {
      return res.status(400).json({
        error: "Email is required."
      });
    }

    const customer = await getOrCreateCustomer(email);

    res.json({
      email: customer.email,
      balance: Number(customer.balance),
      currency: "GHS"
    });
  } catch (error) {
    console.error("Balance error:", error);

    res.status(500).json({
      error: "Unable to check balance."
    });
  }
});


// ===============================
// RENT NUMBER
// ===============================

app.post("/api/buy", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      country,
      operator = "any",
      product,
      email
    } = req.body;

    if (!country || !product || !email) {
      return res.status(400).json({
        error: "Country, service and email are required."
      });
    }

    if (!process.env.FIVESIM_API_KEY) {
      return res.status(500).json({
        error: "5SIM API key is not configured."
      });
    }

    const customerEmail =
      String(email).trim().toLowerCase();

    const rate =
      Number(process.env.FIVESIM_GHS_RATE || 1);

    const markupPercent =
      Number(process.env.MTVERIFY_MARKUP_PERCENT || 30);

    if (
      !Number.isFinite(rate) ||
      rate <= 0 ||
      !Number.isFinite(markupPercent) ||
      markupPercent < 0
    ) {
      return res.status(500).json({
        error: "MtVerify pricing is not configured correctly."
      });
    }

    // Get current 5SIM price
    const priceUrl =
      `https://5sim.com/v1/guest/prices?country=` +
      `${encodeURIComponent(country)}` +
      `&product=${encodeURIComponent(product)}`;

    const priceResponse = await fetch(priceUrl, {
      headers: {
        Accept: "application/json"
      }
    });

    const priceData = await priceResponse.json();

    if (!priceResponse.ok) {
      return res.status(priceResponse.status).json({
        error:
          priceData.message ||
          "Unable to get the current 5SIM price."
      });
    }

    const productData =
      priceData[country] &&
      priceData[country][product];

    const selectedOperator =
      productData &&
      productData[operator];

    if (!selectedOperator) {
      return res.status(400).json({
        error:
          "The selected operator is no longer available."
      });
    }

    const fiveSimCost =
      Number(selectedOperator.cost);

    const available =
      Number(selectedOperator.count);

    if (
      !Number.isFinite(fiveSimCost) ||
      fiveSimCost <= 0
    ) {
      return res.status(400).json({
        error: "Unable to determine the current 5SIM price."
      });
    }

    if (!Number.isFinite(available) || available <= 0) {
      return res.status(400).json({
        error: "No numbers are currently available for this operator."
      });
    }

    // Convert 5SIM cost to GH₵ and add MtVerify markup.
    const customerPrice =
      Math.ceil(
        fiveSimCost *
        rate *
        (1 + markupPercent / 100) *
        100
      ) / 100;

    // Start transaction and lock customer's balance.
    await client.query("BEGIN");

    const customerResult = await client.query(
      `
      SELECT email, balance
      FROM customers
      WHERE email = $1
      FOR UPDATE
      `,
      [customerEmail]
    );

    if (customerResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Please add balance before renting a number."
      });
    }

    const balance =
      Number(customerResult.rows[0].balance);

    if (balance < customerPrice) {
      await client.query("ROLLBACK");

      return res.status(400).json({
        error: "Insufficient MtVerify balance.",
        price: customerPrice,
        balance
      });
    }

    // Reserve customer money before contacting 5SIM.
    const updatedCustomer =
      await client.query(
        `
        UPDATE customers
        SET
          balance = balance - $1,
          updated_at = NOW()
        WHERE email = $2
        RETURNING email, balance
        `,
        [customerPrice, customerEmail]
      );

    const remainingBalance =
      Number(updatedCustomer.rows[0].balance);

    await client.query("COMMIT");

    // Purchase the number from 5SIM.
    const buyUrl =
      `https://5sim.com/v1/user/buy/activation/` +
      `${encodeURIComponent(country)}/` +
      `${encodeURIComponent(operator)}/` +
      `${encodeURIComponent(product)}`;

    const buyResponse = await fetch(buyUrl, {
      headers: {
        Authorization:
          `Bearer ${process.env.FIVESIM_API_KEY}`,
        Accept: "application/json"
      }
    });

    const buyData = await buyResponse.json();

    // Refund if 5SIM purchase fails.
    if (!buyResponse.ok) {
      await pool.query(
        `
        UPDATE customers
        SET
          balance = balance + $1,
          updated_at = NOW()
        WHERE email = $2
        `,
        [customerPrice, customerEmail]
      );

      return res.status(buyResponse.status || 400).json({
        error:
          buyData.message ||
          "5SIM could not provide a number. Your balance was refunded."
      });
    }

    res.json({
      success: true,
      order: buyData,
      fiveSimCost,
      price: customerPrice,
      currency: "GHS",
      remainingBalance
    });

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("5SIM buy error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to rent the number."
    });
  } finally {
    client.release();
  }
});


// ===============================
// CHECK SMS / ORDER
// ===============================

app.get("/api/order/:id", async (req, res) => {
  try {
    if (!process.env.FIVESIM_API_KEY) {
      return res.status(500).json({
        error: "5SIM API key is not configured."
      });
    }

    const orderId =
      encodeURIComponent(req.params.id);

    const response =
      await fetch(
        `https://5sim.com/v1/user/check/${orderId}`,
        {
          headers: {
            Authorization:
              `Bearer ${process.env.FIVESIM_API_KEY}`,
            Accept: "application/json"
          }
        }
      );

    const data =
      await response.json();

    res.status(response.status).json(data);

  } catch (error) {
    console.error("Order check error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to check order."
    });
  }
});


// ===============================
// START SERVER
// ===============================

async function startServer() {
  try {
    await setupDatabase();

    app.listen(PORT, () => {
      console.log(
        `MtVerify running on port ${PORT}`
      );
    });

  } catch (error) {
    console.error(
      "Database startup error:",
      error
    );

    process.exit(1);
  }
}

startServer();
