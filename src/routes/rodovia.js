const express = require("express");
const router = express.Router();
const rodoviaService = require("../services/rodoviaService");

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Middleware de autenticação para endpoints internos do worker.
 * Verifica o header `x-worker-key` contra RODOVIA_WORKER_KEY.
 * Se a variável não estiver configurada, passa sem bloquear (dev mode).
 */
function requireWorkerKey(req, res, next) {
  const secret = process.env.RODOVIA_WORKER_KEY;
  if (!secret) return next(); // não configurado → permite em desenvolvimento
  if (req.headers["x-worker-key"] !== secret) {
    return res.status(401).json({ error: "Não autorizado." });
  }
  next();
}

// GET /rodovia/rounds/active — público, usado pelo frontend (polling 5s)
router.get("/rounds/active", async (req, res) => {
  try {
    const activeRound = await rodoviaService.getActiveRound();
    if (!activeRound) {
      return res.status(404).json({ error: "Nenhum round ativo encontrado." });
    }
    return res.json(activeRound);
  } catch (err) {
    console.error("[rodovia] GET /rounds/active error:", err.message);
    return res.status(500).json({ error: "Erro ao obter round ativo da Rodovia." });
  }
});

/**
 * POST /internal/rodovia/rounds/:id/metrics
 * Worker envia contagem parcial periodicamente (ex: a cada 10s).
 *
 * Body:
 *   currentCount   {number}  obrigatório — veículos contados no período
 *   sourceHealth   {string}  opcional   — "ok" | "degraded" | "offline" (default "ok")
 *   fps            {number}  opcional   — frames/s da câmera
 *   activeTracks   {number}  opcional   — rastreamentos ativos no frame
 *   sourceLagMs    {number}  opcional   — latência da fonte em ms
 *
 * Header obrigatório (produção): x-worker-key: <RODOVIA_WORKER_KEY>
 */
router.post("/rounds/:id/metrics", requireWorkerKey, async (req, res) => {
  try {
    const { id } = req.params;
    const currentCount = parseNumber(req.body.currentCount);
    const sourceHealth = req.body.sourceHealth || "ok";
    const fps = parseNumber(req.body.fps);
    const activeTracks = parseNumber(req.body.activeTracks);
    const sourceLagMs = parseNumber(req.body.sourceLagMs);

    if (currentCount === null) {
      return res.status(400).json({ error: "currentCount inválido ou ausente." });
    }

    const result = await rodoviaService.updateRoundMetrics(id, {
      currentCount,
      sourceHealth,
      fps,
      activeTracks,
      sourceLagMs,
    });

    if (!result.ok) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: `Round ${id} não encontrado.` });
      }
      if (result.reason === "not_open") {
        return res.status(409).json({ error: `Round ${id} não está aberto para atualização.` });
      }
      return res.status(500).json({ error: "Erro ao atualizar métricas." });
    }

    return res.json({
      ok: true,
      roundId: id,
      applied: { currentCount, sourceHealth, fps, activeTracks, sourceLagMs },
    });
  } catch (err) {
    console.error("[rodovia] POST /rounds/:id/metrics error:", err.message);
    return res.status(500).json({ error: "Erro interno ao atualizar métricas." });
  }
});

/**
 * POST /internal/rodovia/rounds/:id/finalize
 * Worker envia contagem final ao término da janela de contagem.
 * Registra o valor autoritativo que o cron usará na liquidação.
 *
 * Body:
 *   finalCount  {number}  obrigatório — contagem total do período
 *
 * Header obrigatório (produção): x-worker-key: <RODOVIA_WORKER_KEY>
 *
 * Efeito: grava final_count e current_count em market_rounds,
 *         marca status="ended". O cron liquida posições na virada do slot.
 */
router.post("/rounds/:id/finalize", requireWorkerKey, async (req, res) => {
  try {
    const { id } = req.params;
    const finalCount = parseNumber(req.body.finalCount);

    if (finalCount === null) {
      return res.status(400).json({ error: "finalCount inválido ou ausente." });
    }

    const result = await rodoviaService.finalizeRound(id, finalCount);

    if (!result.ok) {
      if (result.reason === "not_found") {
        return res.status(404).json({ error: `Round ${id} não encontrado.` });
      }
      if (result.reason === "not_open") {
        return res.status(409).json({ error: `Round ${id} já foi encerrado ou liquidado.` });
      }
      return res.status(500).json({ error: "Erro ao finalizar round." });
    }

    return res.json({ ok: true, roundId: id, finalCount });
  } catch (err) {
    console.error("[rodovia] POST /rounds/:id/finalize error:", err.message);
    return res.status(500).json({ error: "Erro interno ao finalizar round." });
  }
});

module.exports = router;
