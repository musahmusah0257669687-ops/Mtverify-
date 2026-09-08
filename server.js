const express = require("express");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// TEST ONLY:
// Balances are stored in memory.
// We will replace this with a database before going live.
const balances = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


// ===============================
// MTVERIFY STATUS
// ===============================

app.get("/api/status", (req, res) => {
  res.json({
    site: "MtVerify",
    status: "online",
    fiveSimConfigured: Boolean(process.env.FIVESIM_API_KEY),
    paystackConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY)
  });
});


// ===============================
// CHECK 5SIM PRICE
// ===============================

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


// ===============================
// PAYSTACK INITIALIZE PAYMENT
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

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        error: "Enter a valid deposit amount."
      });
    }

    // Paystack expects the amount in the smallest currency unit.
    // For Ghana cedis: GH₵10.00 = 1000 pesewas.
    const amountInPesewas = Math.round(numericAmount * 100);

    const reference =
      `MTV-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

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
          email,
          amount: String(amountInPesewas),
          currency: "GHS",
          reference,

          metadata: {
            service: "MtVerify",
            customer_email: email
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
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
// VERIFY PAYSTACK PAYMENT
// ===============================

app.get("/api/paystack/verify/:reference", async (req, res) => {
  try {

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({
        error: "Paystack secret key is not configured."
      });
    }

    const reference = req.params.reference;

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

    // Get customer email from transaction.
    const email =
      transaction.customer &&
      transaction.customer.email;

    if (!email) {
      return res.status(400).json({
        error: "Customer email was not found."
      });
    }

    // Paystack amount is in pesewas.
    const paidAmount =
      Number(transaction.amount) / 100;

    // Credit balance.
    const currentBalance =
      balances.get(email) || 0;

    const newBalance =
      currentBalance + paidAmount;

    balances.set(email, newBalance);

    res.json({
      success: true,
      email,
      paidAmount,
      balance: newBalance,
      reference: transaction.reference
    });

  } catch (error) {

    console.error("Paystack verification error:", error);

    res.status(500).json({
      error:
        error.message ||
        "Unable to verify payment."
    });
  }
});


// ===============================
// CHECK CUSTOMER BALANCE
// ===============================

app.get("/api/balance", (req, res) => {

  const email =
    String(req.query.email || "")
      .trim()
      .toLowerCase();

  if (!email) {
    return res.status(400).json({
      error: "Email is required."
    });
  }

  const balance =
    balances.get(email) || 0;

  res.json({
    email,
    balance,
    currency: "GHS"
  });
});


// ===============================
// RENT 5SIM NUMBER
// ===============================

app.post("/api/buy", async (req, res) => {
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

    // Check customer balance first.
    const customerEmail =
      String(email).trim().toLowerCase();

    const balance =
      balances.get(customerEmail) || 0;

    // Get current 5SIM price.
    const priceUrl =
      `https://5sim.com/v1/guest/prices?country=` +
      `${encodeURIComponent(country)}` +
      `&product=${encodeURIComponent(product)}`;

    const priceResponse =
      await fetch(priceUrl, {
        headers: {
          Accept: "application/json"
        }
      });

    const priceData =
      await priceResponse.json();

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

    if (balance < fiveSimPrice) {
      return res.status(402).json({
        error:
          `Insufficient MtVerify balance. ` +
          `Your balance is GH₵${balance.toFixed(2)} ` +
          `and the current 5SIM price is ${fiveSimPrice}.`,
        balance,
        price: fiveSimPrice
      });
    }

    const url =
      `https://5sim.com/v1/user/buy/activation/` +
      `${encodeURIComponent(country)}/` +
      `${encodeURIComponent(operator)}/` +
      `${encodeURIComponent(product)}`;

    const response =
      await fetch(url, {
        headers: {
          Authorization:
            `Bearer ${process.env.FIVESIM_API_KEY}`,
          Accept: "application/json"
        }
      });

    const text =
      await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = {
        message: text
      };
    }

    if (!response.ok) {

      return res.status(response.status).json({
        error:
          data.message ||
          data.error ||
          text
      });
    }

    // Deduct the selected 5SIM price
    // only after 5SIM successfully gives us the number.
    const remainingBalance =
      balance - fiveSimPrice;

    balances.set(
      customerEmail,
      remainingBalance
    );

    res.json({
      ...data,
      customerEmail,
      charged: fiveSimPrice,
      remainingBalance
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


// ===============================
// CHECK EXISTING 5SIM ORDER
// ===============================

app.get("/api/order/:id", async (req, res) => {
  try {

    const response =
      await fetch(
        `https://5sim.com/v1/user/check/${encodeURIComponent(req.params.id)}`,
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

    console.error(error);

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

app.listen(PORT, () => {
  console.log(
    `MtVerify running on port ${PORT}`
  );
});
