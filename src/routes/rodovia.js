const express = require("express");
const router = express.Router();
const rodoviaService = require("../services/rodoviaService");

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// GET /api/rodovia/rounds/active
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

// POST /internal/rodovia/rounds/:id/metrics
router.post("/rounds/:id/metrics", async (req, res) => {
  try {
    const { id } = req.params;
    const currentCount = parseNumber(req.body.currentCount);
    const sourceHealth = req.body.sourceHealth || "ok";
    const fps = parseNumber(req.body.fps);
    const activeTracks = parseNumber(req.body.activeTracks);
    const sourceLagMs = parseNumber(req.body.sourceLagMs);

    if (currentCount === null) {
      return res.status(400).json({ error: "currentCount inválido." });
    }

    const success = await rodoviaService.updateRoundMetrics(id, {
      currentCount,
      sourceHealth,
      fps,
      activeTracks,
      sourceLagMs,
    });

    if (!success) {
      return res.status(409).json({ error: "Não foi possível atualizar métricas." });
    }

    return res.json({
      ok: true,
      roundId: id,
      applied: {
        currentCount,
        sourceHealth,
        fps,
        activeTracks,
        sourceLagMs,
      },
    });
  } catch (err) {
    console.error("[rodovia] POST /rounds/:id/metrics error:", err.message);
    return res.status(500).json({ error: "Erro ao atualizar métricas da Rodovia." });
  }
});

module.exports = router;
