const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/status", (req, res) => {
  res.json({
    site: "MtVerify",
    status: "online",
    fiveSimConfigured: Boolean(process.env.FIVESIM_API_KEY)
  });
});

// Check 5SIM prices without spending balance
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

// Rent a number
app.post("/api/buy", async (req, res) => {
  try {
    const { country, operator = "any", product } = req.body;

    if (!country || !product) {
      return res.status(400).json({
        error: "Country and service are required."
      });
    }

    if (!process.env.FIVESIM_API_KEY) {
      return res.status(500).json({
        error: "5SIM API key is not configured on the server."
      });
    }

    const url =
      `https://5sim.com/v1/user/buy/activation/` +
      `${encodeURIComponent(country)}/` +
      `${encodeURIComponent(operator)}/` +
      `${encodeURIComponent(product)}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.FIVESIM_API_KEY}`,
        Accept: "application/json"
      }
    });

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || data.error || text
      });
    }

    res.json(data);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message || "Unable to contact 5SIM."
    });
  }
});

// Check an existing order
app.get("/api/order/:id", async (req, res) => {
  try {
    const response = await fetch(
      `https://5sim.com/v1/user/check/${encodeURIComponent(req.params.id)}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FIVESIM_API_KEY}`,
          Accept: "application/json"
        }
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message || "Unable to check order."
    });
  }
});

app.listen(PORT, () => {
  console.log(`MtVerify running on port ${PORT}`);
});
