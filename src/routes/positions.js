const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

// ── POST /positions — Criar posição ──────────────────────────────────────────
router.post("/", authRequired, async (req, res) => {
  const { marketId, side, oddLocked } = req.body;
  const stake = Number(req.body.stake);

  if (!marketId || !side || !req.body.stake || !oddLocked) {
    return res.status(400).json({ error: "Campos obrigatórios: marketId, side, stake, oddLocked." });
  }
  if (!["yes", "no"].includes(side)) {
    return res.status(400).json({ error: "side deve ser 'yes' ou 'no'." });
  }
  if (isNaN(stake) || stake <= 0) {
    return res.status(400).json({ error: "stake deve ser um número positivo." });
  }

  // Verifica saldo
  const { data: balanceRow, error: balanceErr } = await supabase
    .from("balances")
    .select("available_balance")
    .eq("user_id", req.userId)
    .single();

  if (balanceErr || !balanceRow) {
    return res.status(500).json({ error: "Erro ao consultar saldo." });
  }
  if (balanceRow.available_balance < stake) {
    return res.status(402).json({ error: "Saldo insuficiente." });
  }

  const potentialPayout = +(stake * oddLocked).toFixed(2);
  const potentialProfit = +(potentialPayout - stake).toFixed(2);

  // Insere posição
  const { data: position, error: posErr } = await supabase
    .from("positions")
    .insert({
      user_id:          req.userId,
      market_id:        marketId,
      side,
      stake,
      odd_locked:       oddLocked,
      potential_payout: potentialPayout,
      potential_profit: potentialProfit,
      status:           "open",
    })
    .select()
    .single();

  if (posErr) {
    return res.status(500).json({ error: "Erro ao criar posição." });
  }

  // Debita saldo
  const { error: debitErr } = await supabase
    .from("balances")
    .update({ available_balance: balanceRow.available_balance - stake })
    .eq("user_id", req.userId);

  if (debitErr) {
    // Reverte posição se o débito falhar
    await supabase.from("positions").delete().eq("id", position.id);
    return res.status(500).json({ error: "Erro ao debitar saldo." });
  }

  // Registra transação
  await supabase.from("transactions").insert({
    user_id:      req.userId,
    type:         "bet",
    amount:       -stake,
    reference_id: position.id,
  });

  return res.status(201).json({ position });
});

// ── GET /positions — Listar posições do usuário ──────────────────────────────
router.get("/", authRequired, async (req, res) => {
  const { data: positions, error } = await supabase
    .from("positions")
    .select("*")
    .eq("user_id", req.userId)
    .order("created_at", { ascending: false });

  if (error) {
    return res.status(500).json({ error: "Erro ao listar posições." });
  }

  return res.json({ positions });
});

module.exports = router;
