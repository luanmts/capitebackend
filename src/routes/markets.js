const express  = require("express");
const router   = express.Router();
const supabase = require("../db/supabase");

const MARKET_FIELDS = `
  id, title, slug, description, icon, image_url,
  category, closes_at, live, volume, matching_system,
  display_type, status, current_yes_odd, current_no_odd, start_price, current_round_id,
  virtual_yes_base, virtual_no_base, real_yes_volume, real_no_volume,
  selections:market_selections ( id, label, odd, odd_nao, percent, code, color )
`.trim();

// Templates ocultos temporariamente da vitrine (código e DB intactos)
const HIDDEN_TEMPLATES = new Set(["petroleo-5min-template"]);

router.get("/", async (req, res) => {
  const { data: markets, error } = await supabase
    .from("markets")
    .select(MARKET_FIELDS)
    .eq("status", "open");

  if (error) {
    return res.status(500).json({ error: "Erro ao listar mercados." });
  }

  const filtered = (markets || []).filter(
    m => !/-\d{13}$/.test(m.id) && !HIDDEN_TEMPLATES.has(m.id)
  );
  return res.json({ markets: filtered });
});

router.get("/slug/:slug", async (req, res) => {
  const { data: market, error } = await supabase
    .from("markets")
    .select(MARKET_FIELDS)
    .eq("slug", req.params.slug)
    .single();

  if (error) {
    return res.status(404).json({ error: "Mercado não encontrado." });
  }

  return res.json({ market });
});

router.get("/:id", async (req, res) => {
  const { data: market, error } = await supabase
    .from("markets")
    .select(MARKET_FIELDS)
    .eq("id", req.params.id)
    .single();

  if (error) {
    return res.status(404).json({ error: "Mercado não encontrado." });
  }

  return res.json({ market });
});

module.exports = router;
