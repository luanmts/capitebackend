const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");
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

// ── POST /settle — Liquidar mercado ──────────────────────────────────────────
router.post("/", authRequired, async (req, res) => {
  const { marketId, outcome } = req.body;

  if (!marketId || !outcome) {
    return res.status(400).json({ error: "Campos obrigatórios: marketId, outcome." });
  }
  if (!["yes", "no", "cancelled"].includes(outcome)) {
    return res.status(400).json({ error: "outcome deve ser 'yes', 'no' ou 'cancelled'." });
  }

  // Busca posições abertas do mercado
  const { data: positions, error: fetchErr } = await supabase
    .from("positions")
    .select("id, user_id, side, stake, potential_payout")
    .eq("market_id", marketId)
    .eq("status", "open");

  if (fetchErr) {
    return res.status(500).json({ error: "Erro ao buscar posições." });
  }
  if (!positions || positions.length === 0) {
    return res.status(200).json({ settled: 0 });
  }

  let won = 0;
  let lost = 0;
  let cancelled = 0;

  for (const pos of positions) {
    const isWinner =
      outcome === "cancelled"
        ? false
        : (outcome === "yes" && pos.side === "yes") ||
          (outcome === "no"  && pos.side === "no");

    const isCancelled = outcome === "cancelled";
    const newStatus   = isCancelled ? "cancelled" : isWinner ? "won" : "lost";
    const credit      = isCancelled ? pos.stake : isWinner ? pos.potential_payout : 0;
    const txType      = isCancelled ? "refund" : "payout";

    // Atualiza posição
    const { error: updateErr } = await supabase
      .from("positions")
      .update({ status: newStatus, settled_at: new Date().toISOString() })
      .eq("id", pos.id);

    if (updateErr) {
      return res.status(500).json({ error: `Erro ao atualizar posição ${pos.id}.` });
    }

    // Credita saldo e registra transação (apenas para vencedoras/canceladas)
    if (credit > 0) {
      // Busca saldo atual
      const { data: balanceRow, error: balanceErr } = await supabase
        .from("balances")
        .select("available_balance")
        .eq("user_id", pos.user_id)
        .single();

      if (balanceErr || !balanceRow) {
        return res.status(500).json({ error: `Erro ao consultar saldo do usuário ${pos.user_id}.` });
      }

      const { error: debitErr } = await supabase
        .from("balances")
        .update({ available_balance: balanceRow.available_balance + credit })
        .eq("user_id", pos.user_id);

      if (debitErr) {
        return res.status(500).json({ error: `Erro ao creditar saldo do usuário ${pos.user_id}.` });
      }

      const { error: txErr } = await supabase.from("transactions").insert({
        user_id:      pos.user_id,
        type:         txType,
        amount:       credit,
        reference_id: pos.id,
      });

      if (txErr) {
        return res.status(500).json({ error: `Erro ao registrar transação para posição ${pos.id}.` });
      }
    }

    if (isCancelled) cancelled++;
    else if (isWinner) won++;
    else lost++;
  }

  return res.status(200).json({ settled: positions.length, won, lost, cancelled });
});

module.exports = router;
