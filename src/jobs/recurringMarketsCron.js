/**
 * src/jobs/recurringMarketsCron.js
 *
 * Cron genérico para mercados recorrentes (Bitcoin, Petróleo, Rodovia, etc.)
 * Roda a cada minuto e gerencia rounds de qualquer intervalo configurado.
 *
 * Para adicionar um novo mercado recorrente:
 *   1. Adicione uma entrada em RECURRING_MARKETS
 *   2. Implemente a função fetchPrice correspondente
 *   3. Insira o registro template no banco (igual ao bitcoin-5min-template)
 */

const cron    = require("node-cron");
const fetch   = require("node-fetch");
const supabase = require("../db/supabase");

// ── Configuração dos mercados recorrentes ─────────────────────────────────────

const RECURRING_MARKETS = [
  {
    templateId:   "bitcoin-5min-template",
    slug:         "bitcoin-70k-5min",
    title:        "Bitcoin: Sobe ou Desce? (em 5 minutos)",
    description:  "O preço do Bitcoin (BTC/USD) vai subir ou cair nos próximos 5 minutos na Binance.",
    icon:         "₿",
    category:     "Criptomoedas",
    displayType:  "crypto-live",
    intervalMins: 5,
    active24h:    true,       // true = roda 24h; false = respeita activeHours
    activeHours:  null,       // ex: { start: 9, end: 24 } — usado se active24h = false
    fetchPrice:   fetchBitcoinPrice,
    yesLabel:     "Sobe",
    noLabel:      "Desce",
    yesCode:      "SOBE",
    noCode:       "DESCE",
    yesColor:     "#02BC17",
    noColor:      "#e23838",
  },

  // Petróleo temporariamente desativado — oculto da vitrine
  // {
  //   templateId:   "petroleo-5min-template",
  //   slug:         "petroleo-5min",
  //   ...
  //   fetchPrice:   fetchPetroleumPrice,
  // },

  {
    templateId:   "eth-5min-template",
    slug:         "eth-5min",
    title:        "Ethereum: Sobe ou Desce? (em 5 minutos)",
    description:  "O preço do Ethereum (ETH/USD) vai subir ou cair nos próximos 5 minutos na Binance.",
    icon:         "⟠",
    category:     "Criptomoedas",
    displayType:  "crypto-live",
    intervalMins: 5,
    active24h:    true,
    activeHours:  null,
    fetchPrice:   fetchEthPrice,
    yesLabel:     "Sobe",
    noLabel:      "Desce",
    yesCode:      "SOBE",
    noCode:       "DESCE",
    yesColor:     "#02BC17",
    noColor:      "#e23838",
  },

  // ── Adicione Rodovia aqui quando tiver a fonte de contagem ───────────────
  // {
  //   templateId:   "rodovia-5min-template",
  //   slug:         "rodovia-castelo-branco-5min",
  //   title:        "Rodovia: Quantos Carros? (em 5 minutos)",
  //   ...
  //   fetchPrice:   fetchRodoviaCount,
  // },
];

// ── Funções de busca de preço ─────────────────────────────────────────────────

async function fetchBitcoinPrice() {
  try {
    // Tenta Binance primeiro
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", {
      timeout: 5000,
    });
    if (res.ok) {
      const data = await res.json();
      const price = parseFloat(data.price);
      if (!isNaN(price) && price > 0) return price;
    }
  } catch (err) {
    console.warn("[recurringCron] Binance falhou, tentando CoinGecko:", err.message);
  }

  try {
    // Fallback: CoinGecko
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      { timeout: 5000 }
    );
    if (res.ok) {
      const data = await res.json();
      const price = data?.bitcoin?.usd;
      if (price && !isNaN(price)) return parseFloat(price);
    }
  } catch (err) {
    console.error("[recurringCron] CoinGecko também falhou:", err.message);
  }

  return null; // ambas as fontes falharam
}

async function fetchEthPrice() {
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", {
      timeout: 5000,
    });
    if (res.ok) {
      const data = await res.json();
      const price = parseFloat(data.price);
      if (!isNaN(price) && price > 0) return price;
    }
  } catch (err) {
    console.warn("[recurringCron] Binance ETH falhou:", err.message);
  }
  return null;
}

async function fetchPetroleumPrice() {
  try {
    // WTI Crude Oil futures (CL=F) via Yahoo Finance
    const res = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1m&range=1m",
      { timeout: 5000, headers: { "User-Agent": "Mozilla/5.0" } }
    );
    if (res.ok) {
      const data = await res.json();
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price && !isNaN(price)) return parseFloat(price);
    }
  } catch (err) {
    console.warn("[recurringCron] Yahoo Finance (petróleo) falhou:", err.message);
  }
  return null;
}

// Placeholder para Rodovia — implementar quando tiver a fonte
// async function fetchRodoviaCount() { ... }

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Retorna o ID único do round baseado no timestamp de início do slot */
function getRoundId(templateId, slotDate) {
  return `${templateId}-${slotDate.getTime()}`;
}

/** Retorna o slug único do round: ex bitcoin-70k-5min-20260327-1020 */
function getRoundSlug(baseSlug, slotDate) {
  const pad  = (n) => n.toString().padStart(2, "0");
  const date = `${slotDate.getFullYear()}${pad(slotDate.getMonth() + 1)}${pad(slotDate.getDate())}`;
  const time = `${pad(slotDate.getHours())}${pad(slotDate.getMinutes())}`;
  return `${baseSlug}-${date}-${time}`;
}

/**
 * Retorna a data de início do slot atual arredondada para baixo.
 * Ex: para intervalo de 5min, 11:23 → 11:20
 */
function getCurrentSlotStart(intervalMins) {
  const now     = new Date();
  const minutes = now.getMinutes();
  const slot    = Math.floor(minutes / intervalMins) * intervalMins;
  const d       = new Date(now);
  d.setMinutes(slot, 0, 0);
  return d;
}

/** Verifica se o mercado está dentro do horário ativo */
function isActiveNow(market) {
  if (market.active24h) return true;
  const { start, end } = market.activeHours;
  const hour = new Date().getHours();
  return hour >= start && hour < end;
}

// ── Lógica principal por mercado ──────────────────────────────────────────────

async function processMarket(market) {
  const {
    templateId, slug, title, description, icon, category, displayType,
    intervalMins, yesLabel, noLabel, yesCode, noCode, yesColor, noColor,
    fetchPrice,
  } = market;

  if (!isActiveNow(market)) {
    console.log(`[recurringCron] ${templateId} fora do horário ativo, pulando.`);
    return;
  }

  // 1. Busca preço atual
  const currentPrice = await fetchPrice();
  if (!currentPrice) {
    console.error(`[recurringCron] ${templateId} — não foi possível obter preço. Round não criado.`);
    return;
  }
  console.log(`[recurringCron] ${templateId} — preço atual: ${currentPrice}`);

  const now          = new Date();
  const slotStart    = getCurrentSlotStart(intervalMins);
  const slotEnd      = new Date(slotStart.getTime() + intervalMins * 60 * 1000);
  const newRoundId   = getRoundId(templateId, slotStart);
  const newRoundSlug = getRoundSlug(slug, slotStart);

  // 2. Busca template para saber qual é o round anterior
  const { data: template, error: templateErr } = await supabase
    .from("markets")
    .select("current_round_id")
    .eq("id", templateId)
    .single();

  if (templateErr) {
    console.error(`[recurringCron] ${templateId} — erro ao buscar template:`, templateErr.message);
    return;
  }

  const previousRoundId = template?.current_round_id;

  // 3. Verifica se o round atual já existe (evita duplicar em caso de restart)
  const { data: existingRound } = await supabase
    .from("markets")
    .select("id")
    .eq("id", newRoundId)
    .single();

  if (existingRound) {
    console.log(`[recurringCron] ${templateId} — round ${newRoundId} já existe, pulando criação.`);
  } else {
    // 4. Cria o novo round
    const { error: insertErr } = await supabase.from("markets").insert({
      id:               newRoundId,
      title,
      slug:             newRoundSlug,
      description,
      icon,
      category,
      status:           "open",
      live:             1,
      volume:           0,
      matching_system:  "binary",
      display_type:     displayType,
      virtual_yes_base: 1000,
      virtual_no_base:  1000,
      real_yes_volume:  0,
      real_no_volume:   0,
      current_yes_odd:  1.92,
      current_no_odd:   1.92,
      start_price:      currentPrice,
      closes_at:        slotEnd.toISOString(),
      created_at:       now.toISOString(),
      updated_at:       now.toISOString(),
    });

    if (insertErr) {
      console.error(`[recurringCron] ${templateId} — erro ao criar round:`, insertErr.message);
      return;
    }
    console.log(`[recurringCron] ${templateId} — novo round criado: ${newRoundId}`);

    // Insere selections do novo round
    const selections = [
      {
        id:        `${newRoundId}-yes`,
        market_id: newRoundId,
        label:     yesLabel,
        odd:       1.92,
        percent:   50,
        code:      yesCode,
        color:     yesColor,
      },
      {
        id:        `${newRoundId}-no`,
        market_id: newRoundId,
        label:     noLabel,
        odd:       1.92,
        percent:   50,
        code:      noCode,
        color:     noColor,
      },
    ];

    const { error: selErr } = await supabase.from("market_selections").insert(selections);
    if (selErr) {
      console.error(`[recurringCron] ${templateId} — erro ao inserir selections:`, selErr.message);
    }

    // 5. Atualiza o template para apontar pro novo round
    const { error: templateUpdateErr } = await supabase
      .from("markets")
      .update({
        current_round_id: newRoundId,
        start_price:      currentPrice,
        closes_at:        slotEnd.toISOString(),
        status:           "open",
        updated_at:       now.toISOString(),
      })
      .eq("id", templateId);

    if (templateUpdateErr) {
      console.error(`[recurringCron] ${templateId} — erro ao atualizar template:`, templateUpdateErr.message);
    }
  }

  // 6. Resolve o round anterior (se existir e estiver open)
  if (previousRoundId && previousRoundId !== newRoundId) {
    await settleRound(previousRoundId, currentPrice);
  }
}

// ── Liquidação do round anterior ──────────────────────────────────────────────

async function settleRound(roundId, closePrice) {
  console.log(`[recurringCron] Liquidando round ${roundId} com closePrice ${closePrice}`);

  // Busca start_price do round
  const { data: round, error: roundErr } = await supabase
    .from("markets")
    .select("start_price, status")
    .eq("id", roundId)
    .single();

  if (roundErr || !round) {
    console.error(`[recurringCron] Round ${roundId} não encontrado:`, roundErr?.message);
    return;
  }

  if (round.status !== "open") {
    console.log(`[recurringCron] Round ${roundId} já liquidado (status: ${round.status}), pulando.`);
    return;
  }

  const startPrice = parseFloat(round.start_price);

  // Determina outcome
  let outcome;
  if (closePrice > startPrice)       outcome = "yes";       // Sobe
  else if (closePrice < startPrice)  outcome = "no";        // Desce
  else                               outcome = "cancelled";  // Empate — reembolso

  console.log(`[recurringCron] Round ${roundId} — startPrice: ${startPrice}, closePrice: ${closePrice}, outcome: ${outcome}`);

  // Atualiza status do round no banco
  const { error: marketUpdateErr } = await supabase
    .from("markets")
    .update({
      status:           "resolved",
      resolved_outcome: outcome,
      resolved_at:      new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    })
    .eq("id", roundId);

  if (marketUpdateErr) {
    console.error(`[recurringCron] Erro ao resolver mercado ${roundId}:`, marketUpdateErr.message);
    return;
  }

  // Busca posições abertas do round
  const { data: positions, error: posErr } = await supabase
    .from("positions")
    .select("id, user_id, side, stake, potential_payout")
    .eq("market_id", roundId)
    .eq("status", "open");

  if (posErr) {
    console.error(`[recurringCron] Erro ao buscar posições do round ${roundId}:`, posErr.message);
    return;
  }

  if (!positions || positions.length === 0) {
    console.log(`[recurringCron] Round ${roundId} — sem posições abertas, nada a liquidar.`);
    return;
  }

  let won = 0, lost = 0, cancelled = 0;

  for (const pos of positions) {
    const isCancelled = outcome === "cancelled";
    const isWinner    = !isCancelled && (
      (outcome === "yes" && pos.side === "yes") ||
      (outcome === "no"  && pos.side === "no")
    );

    const newStatus = isCancelled ? "cancelled" : isWinner ? "won" : "lost";
    const credit    = isCancelled ? pos.stake : isWinner ? pos.potential_payout : 0;
    const txType    = isCancelled ? "refund" : "payout";

    // Atualiza posição
    const { error: updateErr } = await supabase
      .from("positions")
      .update({ status: newStatus, settled_at: new Date().toISOString() })
      .eq("id", pos.id);

    if (updateErr) {
      console.error(`[recurringCron] Erro ao atualizar posição ${pos.id}:`, updateErr.message);
      continue;
    }

    // Credita saldo se ganhou ou cancelou
    if (credit > 0) {
      const { data: balanceRow, error: balErr } = await supabase
        .from("balances")
        .select("available_balance")
        .eq("user_id", pos.user_id)
        .single();

      if (balErr || !balanceRow) {
        console.error(`[recurringCron] Erro ao buscar saldo do usuário ${pos.user_id}`);
        continue;
      }

      await supabase
        .from("balances")
        .update({ available_balance: balanceRow.available_balance + credit })
        .eq("user_id", pos.user_id);

      await supabase.from("transactions").insert({
        user_id:      pos.user_id,
        type:         txType,
        amount:       credit,
        reference_id: pos.id,
      });
    }

    if (isCancelled) cancelled++;
    else if (isWinner) won++;
    else lost++;
  }

  console.log(`[recurringCron] Round ${roundId} liquidado — won: ${won}, lost: ${lost}, cancelled: ${cancelled}`);
}

// ── Inicialização do cron ─────────────────────────────────────────────────────

function startRecurringMarketsCron() {
  console.log("[recurringCron] Iniciando cron de mercados recorrentes...");

  // Roda a cada minuto e verifica quais mercados precisam de novo round
  cron.schedule("* * * * *", async () => {
    const now     = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();

    // Só processa nos primeiros 30 segundos do minuto para evitar execuções duplas
    if (seconds > 30) return;

    for (const market of RECURRING_MARKETS) {
      // Verifica se este minuto é o início de um novo slot para este mercado
      if (minutes % market.intervalMins === 0) {
        try {
          await processMarket(market);
        } catch (err) {
          console.error(`[recurringCron] Erro inesperado em ${market.templateId}:`, err.message);
        }
      }
    }
  }, {
    timezone: "America/Sao_Paulo",
  });

  console.log("[recurringCron] Cron registrado — verificação a cada minuto (America/Sao_Paulo).");
}

module.exports = { startRecurringMarketsCron };
