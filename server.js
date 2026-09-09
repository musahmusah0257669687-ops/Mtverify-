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

/* =========================
   HELPERS
========================= */

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

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getFiveSimRate() {
  const rate = Number(process.env.FIVESIM_GHS_RATE);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("FIVESIM_GHS_RATE is not configured correctly.");
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

  const baseGhs = Number(fiveSimCost) * rate;

  const finalPrice =
    baseGhs * (1 + markup / 100);

  return Math.ceil(finalPrice * 100) / 100;
}

/* =========================
   DATABASE
========================= */

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

async function getOrCreateCustomer(email) {
  const clean = cleanEmail(email);

  const result = await pool.query(
    `
    INSERT INTO customers (email)
    VALUES ($1)
    ON CONFLICT (email)
    DO UPDATE SET updated_at = NOW()
    RETURNING id, email, balance
    `,
    [clean]
  );

  return result.rows[0];
}

/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

/* =========================
   STATUS
========================= */

app.get("/api/status", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      site: "MtVerify",
      status: "online",
      databaseConfigured:
        Boolean(process.env.DATABASE_URL),
      fiveSimConfigured:
        Boolean(process.env.FIVESIM_API_KEY),
      paystackConfigured:
        Boolean(process.env.PAYSTACK_SECRET_KEY),
      pricingConfigured:
        Boolean(process.env.FIVESIM_GHS_RATE)
    });
  } catch (error) {
    console.error("Status error:", error);

    res.status(500).json({
      site: "MtVerify",
      status: "database_error"
    });
  }
});

/* =========================
   CUSTOMER BALANCE
========================= */

app.get("/api/balance", async (req, res) => {
  try {
    const email = cleanEmail(req.query.email);

    if (!email || !validEmail(email)) {
      return res.status(400).json({
        error: "Please enter a valid email."
      });
    }

    const customer =
      await getOrCreateCustomer(email);

    res.json({
      email: customer.email,
      balance: Number(customer.balance)
    });
  } catch (error) {
    console.error("Balance error:", error);

    res.status(500).json({
      error: "Unable to check balance."
    });
  }
});

/* =========================
   5SIM PRICE
========================= */

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
        error:
          "Country and service are required."
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

    const data =
      await readResponse(response);

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

/* =========================
   PAYSTACK INITIALIZE
========================= */

app.post(
  "/api/paystack/initialize",
  async (req, res) => {
    try {
      if (!process.env.PAYSTACK_SECRET_KEY) {
        return res.status(500).json({
          error:
            "Paystack secret key is not configured."
        });
      }

      const { email, amount } = req.body;

      const clean = cleanEmail(email);
      const numericAmount = Number(amount);

      if (!clean || !validEmail(clean)) {
        return res.status(400).json({
          error: "Please enter a valid email."
        });
      }

      if (
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
      ) {
        return res.status(400).json({
          error:
            "Enter a valid deposit amount."
        });
      }

      await getOrCreateCustomer(clean);

      const amountInPesewas =
        Math.round(numericAmount * 100);

      const reference =
        "MTV-" +
        Date.now() +
        "-" +
        crypto
          .randomBytes(4)
          .toString("hex");

      await pool.query(
        `
        INSERT INTO payments
        (reference, email, amount, status)
        VALUES ($1, $2, $3, 'pending')
        `,
        [
          reference,
          clean,
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
            "Content-Type":
              "application/json",
            Accept:
              "application/json"
          },
          body: JSON.stringify({
            email: clean,
            amount:
              String(amountInPesewas),
            currency: "GHS",
            reference,
            metadata: {
              service: "MtVerify",
              customer_email: clean
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

/* =========================
   PAYSTACK VERIFY
========================= */

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

      const response = await fetch(
        "https://api.paystack.co/transaction/verify/" +
        encodeURIComponent(reference),
        {
          headers: {
            Authorization:
              "Bearer " +
              process.env.PAYSTACK_SECRET_KEY,
            Accept:
              "application/json"
          }
        }
      );

      const data =
        await readResponse(response);

      if (!response.ok || !data.status) {
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

      await client.query(
        "COMMIT"
      );

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

/* =========================
   BUY / RENT NUMBER
========================= */

app.post("/api/buy", async (req, res) => {
  const client =
    await pool.connect();

  let chargedAmount = 0;
  let customerEmail = "";

  try {
    if (!process.env.FIVESIM_API_KEY) {
      return res.status(500).json({
        error:
          "5SIM API key is not configured."
      });
    }

    const {
      email,
      country,
      operator,
      product
    } = req.body;

    customerEmail =
      cleanEmail(email);

    const cleanCountry =
      String(country || "")
        .trim()
        .toLowerCase();

    const cleanOperator =
      String(operator || "")
        .trim();

    const cleanProduct =
      String(product || "")
        .trim()
        .toLowerCase();

    if (
      !customerEmail ||
      !validEmail(customerEmail)
    ) {
      return res.status(400).json({
        error:
          "Please enter a valid email."
      });
    }

    if (
      !cleanCountry ||
      !cleanProduct ||
      !cleanOperator
    ) {
      return res.status(400).json({
        error:
          "Country, service and operator are required."
      });
    }

    /* Get current 5SIM price */
    const priceUrl =
      "https://5sim.com/v1/guest/prices?country=" +
      encodeURIComponent(cleanCountry) +
      "&product=" +
      encodeURIComponent(cleanProduct);

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
      priceData[cleanCountry] &&
      priceData[cleanCountry][cleanProduct];

    if (!productData) {
      return res.status(400).json({
        error:
          "No price information is available for this service."
      });
    }

    const operatorInfo =
      productData[cleanOperator];

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
      !Number.isFinite(fiveSimCost) ||
      fiveSimCost <= 0
    ) {
      return res.status(400).json({
        error:
          "Invalid 5SIM price."
      });
    }

    if (
      !Number.isFinite(availability) ||
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

    /* Lock customer balance */
    await client.query(
      "BEGIN"
    );

    const customerResult =
      await client.query(
        `
        SELECT id, email, balance
        FROM customers
        WHERE email = $1
        FOR UPDATE
        `,
        [customerEmail]
      );

    if (
      customerResult.rows.length === 0
    ) {
      await client.query(
        `
        INSERT INTO customers
        (email, balance)
        VALUES ($1, 0)
        `,
        [customerEmail]
      );

      await client.query(
        "COMMIT"
      );

      return res.status(400).json({
        error:
          "Insufficient MtVerify balance."
      });
    }

    const customer =
      customerResult.rows[0];

    const currentBalance =
      Number(customer.balance);

    if (
      !Number.isFinite(currentBalance) ||
      currentBalance < chargedAmount
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
        (currentBalance -
          chargedAmount) *
          100
      ) / 100;

    await client.query(
      `
      UPDATE customers
      SET
        balance = $1,
        updated_at = NOW()
      WHERE email = $2
      `,
      [
        newBalance,
        customerEmail
      ]
    );

    await client.query(
      "COMMIT"
    );

    /* Call 5SIM */
    const buyUrl =
      "https://5sim.com/v1/user/buy/activation/" +
      encodeURIComponent(cleanCountry) +
      "/" +
      encodeURIComponent(cleanOperator) +
      "/" +
      encodeURIComponent(cleanProduct);

    const buyResponse =
      await fetch(buyUrl, {
        method: "GET",
        headers: {
          Authorization:
            "Bearer " +
            process.env.FIVESIM_API_KEY,
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

      /* Refund customer */
      await pool.query(
        `
        UPDATE customers
        SET
          balance = balance + $1,
          updated_at = NOW()
        WHERE email = $2
        `,
        [
          chargedAmount,
          customerEmail
        ]
      );

      return res.status(
        buyResponse.status || 400
      ).json({
        error:
          getApiMessage(
            buyData,
            "5SIM could not rent this number. Your balance has been refunded."
          )
      });
    }

    /* Successful rental */
    res.json({
      success: true,
      price: chargedAmount,
      remainingBalance:
        newBalance,
      order: buyData
    });
  } catch (error) {
    console.error(
      "Buy error:",
      error
    );

    /* Refund if customer was charged */
    if (
      chargedAmount > 0 &&
      customerEmail
    ) {
      try {
        await pool.query(
          `
          UPDATE customers
          SET
            balance = balance + $1,
            updated_at = NOW()
          WHERE email = $2
          `,
          [
            chargedAmount,
            customerEmail
          ]
        );
      } catch (refundError) {
        console.error(
          "Refund error:",
          refundError
        );
      }
    }

    res.status(500).json({
      error:
        error.message ||
        "Unable to rent number. If your balance was charged, please check your balance."
    });
  } finally {
    client.release();
  }
});

/* =========================
   CHECK 5SIM ORDER / SMS
========================= */

app.get(
  "/api/order/:id",
  async (req, res) => {
    try {
      if (!process.env.FIVESIM_API_KEY) {
        return res.status(500).json({
          error:
            "5SIM API key is not configured."
        });
      }

      const orderId =
        String(req.params.id || "")
          .trim();

      if (!orderId) {
        return res.status(400).json({
          error:
            "Order ID is required."
        });
      }

      const url =
        "https://5sim.com/v1/user/check/" +
        encodeURIComponent(orderId);

      const response =
        await fetch(url, {
          headers: {
            Authorization:
              "Bearer " +
              process.env.FIVESIM_API_KEY,
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

/* =========================
   404 API HANDLER
========================= */

app.use("/api", (req, res) => {
  res.status(404).json({
    error:
      "API endpoint not found."
  });
});

/* =========================
   ERROR HANDLER
========================= */

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

/* =========================
   START SERVER
========================= */

async function startServer() {
  try {
    await setupDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `MtVerify running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Failed to start MtVerify:",
      error
    );

    process.exit(1);
  }
}

startServer();
