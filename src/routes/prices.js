const express = require("express");
const fetch   = require("node-fetch");
const router  = express.Router();

/**
 * GET /prices/oil
 * Retorna o preço atual do Petróleo WTI (CL=F) via Yahoo Finance.
 * Serve como proxy para o frontend evitar problemas de CORS.
 */
router.get("/oil", async (req, res) => {
  try {
    const response = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1m&range=1m",
      { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (!response.ok) {
      return res.status(502).json({ error: "Fonte de preço indisponível" });
    }
    const data  = await response.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price || isNaN(price)) {
      return res.status(502).json({ error: "Preço inválido na resposta" });
    }
    return res.json({ price: parseFloat(price) });
  } catch (err) {
    console.error("[/prices/oil] Erro:", err.message);
    return res.status(502).json({ error: "Erro ao buscar preço do petróleo" });
  }
});

module.exports = router;
