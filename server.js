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

    console.log("5SIM request:", url);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.FIVESIM_API_KEY}`,
        Accept: "application/json"
      }
    });

    const text = await response.text();

    console.log("5SIM status:", response.status);
    console.log("5SIM response:", text);

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || data.error || text || "5SIM request failed."
      });
    }

    res.json(data);

  } catch (error) {
    console.error("5SIM connection error:", error);

    res.status(500).json({
      error: error.message || "Unable to contact 5SIM."
    });
  }
});

app.get("/api/order/:id", async (req, res) => {
  try {
    const response = await fetch(
      `https://5sim.com/v1/user/check/${encodeURIComponent(req.params.id)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.FIVESIM_API_KEY}`,
          Accept: "application/json"
        }
      }
    );

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    res.status(response.status).json(data);

  } catch (error) {
    console.error("Order check error:", error);

    res.status(500).json({
      error: error.message || "Unable to check order."
    });
  }
});

app.listen(PORT, () => {
  console.log(`MtVerify running on port ${PORT}`);
});
