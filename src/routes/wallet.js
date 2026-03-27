const express  = require("express");
const router   = express.Router();
const jwt      = require("jsonwebtoken");
const supabase = require("../db/supabase");

// ── Middleware JWT ────────────────────────────────────────────────────────────
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token não fornecido." });
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    req.userId = payload.userId;
    req.email  = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }
}

// ── GET /wallet/balance — Saldo do usuário ────────────────────────────────────
router.get("/balance", authRequired, async (req, res) => {
  const { data, error } = await supabase
    .from("balances")
    .select("available_balance")
    .eq("user_id", req.userId)
    .single();

  if (error || !data) {
    return res.status(500).json({ error: "Erro ao consultar saldo." });
  }

  return res.json({ balance: data.available_balance });
});

module.exports = router;
