const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HOUSE_MARGIN = 0.08;

// ── AMM ───────────────────────────────────────────────────────────────────────
/**
 * Recalcula as odds de ambos os lados com base nos volumes efetivos.
 * effectiveYes = virtual_yes_base + real_yes_volume
 * effectiveNo  = virtual_no_base  + real_no_volume
 * odd = (1 / prob) * (1 - houseMargin)
 */
function calcAmm({ virtualYes, virtualNo, realYes, realNo }) {
  const effYes = (virtualYes || 1000) + realYes;
  const effNo  = (virtualNo  || 1000) + realNo;
  const total  = effYes + effNo;

  const oddYes = +((total / effYes) * (1 - HOUSE_MARGIN)).toFixed(2);
  const oddNo  = +((total / effNo)  * (1 - HOUSE_MARGIN)).toFixed(2);

  return { oddYes, oddNo };
}

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
  console.log("[POST /positions] body:", {
    userId:   req.userId,
    marketId: req.body.marketId,
    side:     req.body.side,
    stake:    req.body.stake,
  });

  const { marketId, side } = req.body;
  const stake = Number(req.body.stake);

  if (!marketId || !side || !req.body.stake) {
    return res.status(400).json({ error: "Campos obrigatórios: marketId, side, stake." });
  }
  if (!["yes", "no"].includes(side)) {
    return res.status(400).json({ error: "side deve ser 'yes' ou 'no'." });
  }
  if (isNaN(stake) || stake <= 0) {
    return res.status(400).json({ error: "stake deve ser um número positivo." });
  }

  // Valida mercado
  const { data: market, error: marketErr } = await supabase
    .from("markets")
    .select(
      "id, slug, status, closes_at, current_round_id, current_yes_odd, current_no_odd, " +
      "virtual_yes_base, virtual_no_base, real_yes_volume, real_no_volume, volume"
    )
    .eq("id", marketId)
    .single();

  console.log("[POST /positions] market encontrado:", {
    id:               market?.id,
    slug:             market?.slug,
    current_round_id: market?.current_round_id,
    current_yes_odd:  market?.current_yes_odd,
    current_no_odd:   market?.current_no_odd,
    status:           market?.status,
    closes_at:        market?.closes_at,
    marketErr:        marketErr?.message ?? null,
  });

  if (marketErr || !market) {
    return res.status(404).json({ error: "Mercado não encontrado." });
  }
  if (market.status !== "open") {
    return res.status(409).json({ error: "Mercado não está aberto para apostas." });
  }
  if (market.closes_at && new Date(market.closes_at) <= new Date()) {
    return res.status(409).json({ error: "Mercado já encerrado." });
  }

  // Trava a odd atual do lado escolhido
  const oddLocked = side === "yes" ? market.current_yes_odd : market.current_no_odd;

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
    await supabase.from("positions").delete().eq("id", position.id);
    return res.status(500).json({ error: "Erro ao debitar saldo." });
  }

  // Registra transação
  const { error: txErr } = await supabase.from("transactions").insert({
    user_id:      req.userId,
    type:         "bet",
    amount:       -stake,
    reference_id: position.id,
  });

  if (txErr) {
    console.error("[POST /positions] Erro ao registrar transação:", txErr);
  }

  // Atualiza AMM do mercado
  const newRealYes = (market.real_yes_volume || 0) + (side === "yes" ? stake : 0);
  const newRealNo  = (market.real_no_volume  || 0) + (side === "no"  ? stake : 0);

  const { oddYes, oddNo } = calcAmm({
    virtualYes: market.virtual_yes_base,
    virtualNo:  market.virtual_no_base,
    realYes:    newRealYes,
    realNo:     newRealNo,
  });

  const { error: ammErr } = await supabase
    .from("markets")
    .update({
      real_yes_volume:  newRealYes,
      real_no_volume:   newRealNo,
      current_yes_odd:  oddYes,
      current_no_odd:   oddNo,
      volume:           (market.volume || 0) + stake,
      updated_at:       new Date().toISOString(),
    })
    .eq("id", marketId);

  if (ammErr) {
    console.error("[POST /positions] Falha ao atualizar AMM do mercado:", ammErr, {
      marketId,
      positionId: position.id,
      userId: req.userId,
    });

    // Desfaz: remove posição e restaura saldo
    await supabase.from("positions").delete().eq("id", position.id);
    await supabase
      .from("balances")
      .update({ available_balance: balanceRow.available_balance })
      .eq("user_id", req.userId);

    return res.status(500).json({ error: "Erro ao atualizar mercado. Operação revertida." });
  }

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
