const supabase = require("../db/supabase");

const RODOVIA_TEMPLATE_ID = "rodovia-5min-template";
const RODOVIA_SLUG = "rodovia-castelo-branco-5min";
const ROUND_DURATION_SEC = 300;
const BET_WINDOW_SEC = 150;

// Busca threshold do template ou usa default
async function getThreshold() {
  const { data } = await supabase
    .from("market_rounds")
    .select("threshold")
    .eq("id", RODOVIA_TEMPLATE_ID)
    .maybeSingle();
  
  return data?.threshold || 145;
}

// Retorna odds iniciais padrão para alinhamento com outros mercados live
function getInitialOdds() {
  return 1.76;
}

function nowIso() {
  return new Date().toISOString();
}

function deriveOperationalStatus(round) {
  if (round.status !== "open") return round.status;
  
  const now = Date.now();
  const betsCloseAt = new Date(round.closes_at).getTime() - (ROUND_DURATION_SEC - BET_WINDOW_SEC) * 1000;
  const endsAt = new Date(round.closes_at).getTime();

  if (now >= endsAt) return "ended";
  if (now >= betsCloseAt) return "betting_closed";
  return "live";
}

async function getActiveRound() {
  // 1. Busca template para obter current_round_id (e corrige odds nulas se necessário)
  const { data: template, error: templateErr } = await supabase
    .from("markets")
    .select("current_round_id, current_yes_odd, current_no_odd")
    .eq("id", RODOVIA_TEMPLATE_ID)
    .single();

  if (templateErr) {
    console.error("[rodoviaService] Erro ao buscar template:", templateErr.message);
    return null;
  }

  // Garante que o template sempre exibe as odds iniciais corretas
  if (!template?.current_yes_odd || !template?.current_no_odd) {
    const initialOdds = getInitialOdds();
    await supabase
      .from("markets")
      .update({ current_yes_odd: initialOdds, current_no_odd: initialOdds })
      .eq("id", RODOVIA_TEMPLATE_ID);
  }

  const currentRoundId = template?.current_round_id;
  if (!currentRoundId) return null;

  // 2. Busca dados do round ativo
  const { data: round, error: roundErr } = await supabase
    .from("markets")
    .select(`
      id, title, slug, description, icon, category, status, 
      closes_at, resolved_outcome, resolved_at,
      selections:market_selections ( id, label, odd, percent, code, color )
    `)
    .eq("id", currentRoundId)
    .single();

  if (roundErr) {
    console.error("[rodoviaService] Erro ao buscar round ativo:", roundErr.message);
    return null;
  }

  // 3. Busca dados auxiliares em market_rounds
  const { data: auxData, error: auxErr } = await supabase
    .from("market_rounds")
    .select("current_count, threshold, status as operational_status, source_health")
    .eq("id", currentRoundId)
    .maybeSingle();

  if (auxErr) {
    console.error("[rodoviaService] Erro ao buscar dados auxiliares:", auxErr.message);
  }

  // 4. Calcula status operacional e predictionsOpen
  const operationalStatus = auxData?.operational_status || deriveOperationalStatus(round);
  const predictionsOpen = operationalStatus === "live";
  
  // 5. Monta resposta
  const betsCloseAt = new Date(new Date(round.closes_at).getTime() - (ROUND_DURATION_SEC - BET_WINDOW_SEC) * 1000);
  const threshold = auxData?.threshold || await getThreshold();
  
  return {
    roundId: round.id,
    slug: round.slug,
    status: operationalStatus,
    marketStatus: round.status,
    startsAt: new Date(new Date(round.closes_at).getTime() - ROUND_DURATION_SEC * 1000).toISOString(),
    betsCloseAt: betsCloseAt.toISOString(),
    endsAt: round.closes_at,
    currentCount: auxData?.current_count || 0,
    threshold,
    predictionsOpen,
    selections: round.selections || [],
  };
}

async function updateRoundMetrics(roundId, metrics) {
  // 1. Verifica se o round existe e está aberto
  const { data: round, error: roundErr } = await supabase
    .from("markets")
    .select("status")
    .eq("id", roundId)
    .single();

  if (roundErr) {
    console.error("[rodoviaService] Round não encontrado:", roundErr.message);
    return false;
  }

  if (round.status !== "open") {
    console.error(`[rodoviaService] Round ${roundId} não está aberto (status: ${round.status})`);
    return false;
  }

  // 2. Atualiza dados auxiliares
  const { error: updateErr } = await supabase
    .from("market_rounds")
    .update({
      current_count: metrics.currentCount,
      source_health: metrics.sourceHealth || "ok",
      updated_at: nowIso(),
    })
    .eq("id", roundId);

  if (updateErr) {
    console.error("[rodoviaService] Erro ao atualizar métricas:", updateErr.message);
    return false;
  }

  return true;
}

// Função para obter contagem atual (placeholder)
async function getCurrentCount() {
  // Placeholder - será substituído pela contagem real do worker
  return 0;
}

module.exports = {
  RODOVIA_TEMPLATE_ID,
  RODOVIA_SLUG,
  ROUND_DURATION_SEC,
  BET_WINDOW_SEC,
  getActiveRound,
  updateRoundMetrics,
  getCurrentCount,
  getThreshold,
  getInitialOdds,
};
