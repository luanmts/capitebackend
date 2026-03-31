#!/usr/bin/env bash
# =============================================================================
# setup-server-env.sh
# Configura RODOVIA_WORKER_KEY no backend em produção, faz git pull e reinicia.
#
# Execute no servidor: bash scripts/setup-server-env.sh
# =============================================================================
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$BACKEND_DIR/.env"

echo ""
echo "=== Capite Backend — Setup RODOVIA_WORKER_KEY ==="
echo ""

# 1. Gera chave se não fornecida via env
if [ -z "${RODOVIA_WORKER_KEY:-}" ]; then
  RODOVIA_WORKER_KEY="$(openssl rand -hex 32)"
  echo "✔ Chave gerada automaticamente: $RODOVIA_WORKER_KEY"
  echo "  (salve esta chave — você precisará configurar RODOVIA_WORKER_KEY no worker também)"
else
  echo "✔ Usando chave fornecida via env."
fi

# 2. Garante que o .env existe
if [ ! -f "$ENV_FILE" ]; then
  echo "⚠  .env não encontrado, criando em $ENV_FILE"
  touch "$ENV_FILE"
fi

# 3. Injeta ou substitui a linha RODOVIA_WORKER_KEY
if grep -q "^RODOVIA_WORKER_KEY=" "$ENV_FILE"; then
  # Substitui linha existente
  sed -i "s|^RODOVIA_WORKER_KEY=.*|RODOVIA_WORKER_KEY=$RODOVIA_WORKER_KEY|" "$ENV_FILE"
  echo "✔ RODOVIA_WORKER_KEY atualizada no .env"
else
  echo "RODOVIA_WORKER_KEY=$RODOVIA_WORKER_KEY" >> "$ENV_FILE"
  echo "✔ RODOVIA_WORKER_KEY adicionada ao .env"
fi

# 4. Pull do código mais recente
echo ""
echo "=== git pull ==="
cd "$BACKEND_DIR"
git pull origin main

# 5. Instala dependências novas (se houver)
if [ -f package-lock.json ]; then
  npm ci --omit=dev
fi

# 6. Reinicia o processo
echo ""
echo "=== Reiniciando backend ==="
if command -v pm2 &>/dev/null; then
  pm2 restart capite-backend 2>/dev/null || pm2 restart all
  sleep 2
  pm2 status
elif command -v systemctl &>/dev/null && systemctl is-active --quiet capite-backend 2>/dev/null; then
  systemctl restart capite-backend
  sleep 2
  systemctl status capite-backend --no-pager
else
  echo "⚠  Nenhum gerenciador de processo detectado (pm2/systemctl)."
  echo "   Reinicie o backend manualmente e depois rode os curls de validação abaixo."
fi

echo ""
echo "=== Validação pós-deploy ==="
BASE="http://localhost:3001"

echo ""
echo "1. GET /rodovia/rounds/active"
curl -s --max-time 5 "$BASE/rodovia/rounds/active" | python3 -m json.tool 2>/dev/null \
  || curl -s --max-time 5 "$BASE/rodovia/rounds/active"

ROUND_ID=$(curl -s --max-time 5 "$BASE/rodovia/rounds/active" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('roundId',''))" 2>/dev/null || echo "")

if [ -z "$ROUND_ID" ]; then
  echo "⚠  Nenhum round ativo encontrado. Aguarde o próximo ciclo do cron (5 min)."
else
  echo ""
  echo "2. POST /metrics com chave correta (deve dar 200)"
  curl -s -w "\nHTTP %{http_code}" --max-time 5 \
    -X POST "$BASE/rodovia/rounds/$ROUND_ID/metrics" \
    -H "Content-Type: application/json" \
    -H "x-worker-key: $RODOVIA_WORKER_KEY" \
    -d '{"currentCount": 99, "sourceHealth": "ok"}'

  echo ""
  echo ""
  echo "3. POST /metrics sem chave (deve dar 401)"
  curl -s -w "\nHTTP %{http_code}" --max-time 5 \
    -X POST "$BASE/rodovia/rounds/$ROUND_ID/metrics" \
    -H "Content-Type: application/json" \
    -d '{"currentCount": 1}'

  echo ""
  echo ""
  echo "4. GET /rounds/active após metrics (currentCount deve ser 99)"
  curl -s --max-time 5 "$BASE/rodovia/rounds/active" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('currentCount:', d.get('currentCount'))" 2>/dev/null
fi

echo ""
echo "==================================================="
echo "RODOVIA_WORKER_KEY=$RODOVIA_WORKER_KEY"
echo ""
echo "Configure o mesmo valor no worker:"
echo "  capite-backend/worker/.env → RODOVIA_WORKER_KEY=<acima>"
echo "==================================================="
