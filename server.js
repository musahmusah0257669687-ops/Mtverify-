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

// --------------------------------------------------
// DATABASE SETUP
// --------------------------------------------------

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

// --------------------------------------------------
// HOME
// --------------------------------------------------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------------------------------------
// STATUS
// --------------------------------------------------

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

// --------------------------------------------------
// CHECK 5SIM PRICE
// --------------------------------------------------

app.get("/api/price", async (req, res) => {
  try {
    const country = req.query.country;
    const product = req.query.product;

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

// --------------------------------------------------
// CREATE / GET CUSTOMER
// --------------------------------------------------

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

// --------------------------------------------------
// PAYSTACK INITIALIZE
// --------------------------------------------------

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

    const amountInPesewas =
      Math.round(numericAmount * 100);

    const reference =
      `MTV-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

    // Save the expected payment before sending
    // the customer to Paystack.
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

// --------------------------------------------------
// VERIFY PAYSTACK PAYMENT
// --------------------------------------------------

app.get("/api/paystack/verify/:reference", async (req, res) => {
  const client = await pool.connect();

  try {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        error: "Paystack secret key is not configured."
      });
    }

    const reference = req.params.reference;

    // Get our saved payment.
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

    // If already credited, NEVER credit again.
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

    // Ask Paystack for the real transaction status.
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

    // Make sure the payment belongs to the customer
    // and amount we originally requested.
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

    // Lock the payment row so two simultaneous requests
    // cannot credit it twice.
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

    // Lock customer row and add the money atomically.
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

    // Mark payment as successfully credited.
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

// --------------------------------------------------
// CHECK CUSTOMER BALANCE
// --------------------------------------------------

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

// --------------------------------------------------
// RENT 5SIM NUMBER
// --------------------------------------------------

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

    const rate = Number(process.env.FIVESIM_GHS_RATE);
    const markupPercent =
      Number(process.env.MTVERIFY_MARKUP_PERCENT || 30);

    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(500).json({
        error: "MtVerify pricing rate is not configured."
      });
    }

    if (
      !Number.isFinite(markupPercent) ||
      markupPercent < 0 ||
      markupPercent > 500
    ) {
      return res.status(500).json({
        error: "MtVerify markup is not configured correctly."
      });
    }

    const customerEmail =
      String(email).trim().toLowerCase();

    // Get the current 5SIM price.
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
        error: "Unable to get the current 5SIM price."
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
          "The selected operator is no longer available. Please check the price again."
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
        error: "Unable to determine the current 5SIM cost."
      });
    }

    if (!Number.isFinite(available) || available <= 0) {
      return res.status(400).json({
        error: "This operator currently has no numbers available."
      });
    }

    // Convert the configured 5SIM cost into GH₵.
    const baseGhsCost =
      fiveSimCost * rate;

    // Add MtVerify markup.
    const customerPrice =
      Math.ceil(
        baseGhsCost *
        (1 + markupPercent / 100) *
        100
      ) / 100;

    await client.query("BEGIN");

    // Lock the customer row while checking/deducting balance.
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
        error: "Customer account was not found."
      });
    }

    const balance =
      Number(customerResult.rows[0].balance);

    if (balance < customerPrice) {
      await client.query("ROLLBACK");

      return res.status(402).json({
        error:
          `Insufficient balance. ` +
          `Your balance is GH₵${balance.toFixed(2)} ` +
          `and this number costs GH₵${customerPrice.toFixed(2)}.`,
        balance,
        customerPrice
      });
    }

    /*
      Reserve the customer's money before contacting 5SIM.
      If 5SIM fails, the money is refunded below.
    */
    const newBalance =
      Math.round(
        (balance - customerPrice) * 100
      ) / 100;

    await client.query(
      `
      UPDATE customers
      SET
        balance = $1,
        updated_at = NOW()
      WHERE email = $2
      `,
      [newBalance, customerEmail]
    );

    await client.query("COMMIT");

    // Now purchase the number from 5SIM.
    const buyUrl =
      `https://5sim.com/v1/user/buy/activation/` +
      `${encodeURIComponent(country)}/` +
      `${encodeURIComponent(operator)}/` +
      `${encodeURIComponent(product)}`;

    const response = await fetch(buyUrl, {
      headers: {
        Authorization:
          `Bearer ${process.env.FIVESIM_API_KEY}`,
        Accept: "application/json"
      }
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        message: text
      };
    }

    // If 5SIM failed, refund the customer's GH₵ balance.
    if (!response.ok) {
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

      return res.status(response.status).json({
        error:
          data.message ||
          data.error ||
          "5SIM could not provide the number. Your balance was refunded."
      });
    }

    res.json({
      ...data,
      customerEmail,
      fiveSimCost,
      conversionRate: rate,
      markupPercent,
      customerPrice,
      remainingBalance: newBalance
    });

  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    console.error("5SIM buy error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to complete number rental."
    });

  } finally {
    client.release();
  }
});
  try {
    const {
      country,
      operator = "any",
      product,
      email
    } = req.body;

    if (!country || !product || !email) {
      return res.status(400).json({
        error:
          "Country, service and email are required."
      });
    }

    if (!process.env.FIVESIM_API_KEY) {
      return res.status(500).json({
        error:
          "5SIM API key is not configured on the server."
      });
    }

    const customerEmail =
      String(email).trim().toLowerCase();

    const customerResult = await pool.query(
      `
      SELECT email, balance
      FROM customers
      WHERE email = $1
      `,
      [customerEmail]
    );

    const balance =
      customerResult.rows.length > 0
        ? Number(customerResult.rows[0].balance)
        : 0;

    // Get current 5SIM price.
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

    const productData =
      priceData[country] &&
      priceData[country][product];

    const selectedOperator =
      productData &&
      productData[operator];

    if (!selectedOperator) {
      return res.status(400).json({
        error:
          "The selected operator is no longer available. Please check the price again."
      });
    }

    const fiveSimPrice =
      Number(selectedOperator.cost);

    if (
      !Number.isFinite(fiveSimPrice) ||
      fiveSimPrice <= 0
    ) {
      return res.status(400).json({
        error:
          "Unable to determine the current 5SIM price."
      });
    }

    /*
      IMPORTANT:
      5SIM's cost is NOT automatically a Ghana-cedi
      customer price.

      We are temporarily leaving this rental section
      in test mode. Before accepting real customer money,
      we must create a proper GH₵ pricing/markup system.
    */

    return res.status(400).json({
      error:
        "Number rental is temporarily disabled while MtVerify pricing is being configured.",
      fiveSimCost: fiveSimPrice,
      customerBalance: balance
    });

  } catch (error) {
    console.error("5SIM buy error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to contact 5SIM."
    });
  }
});

// --------------------------------------------------
// CHECK EXISTING 5SIM ORDER
// --------------------------------------------------

app.get("/api/order/:id", async (req, res) => {
  try {
    if (!process.env.FIVESIM_API_KEY) {
      return res.status(500).json({
        error: "5SIM API key is not configured."
      });
    }

    const response = await fetch(
      `https://5sim.com/v1/user/check/${encodeURIComponent(req.params.id)}`,
      {
        headers: {
          Authorization:
            `Bearer ${process.env.FIVESIM_API_KEY}`,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);

  } catch (error) {
    console.error("5SIM order error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to check order."
    });
  }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

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
