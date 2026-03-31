"""
Rodovia Castelo Branco — Worker de Contagem de Veículos

Esqueleto pronto para integração YOLO/ByteTrack.
Sem visão computacional ainda: get_vehicle_count() retorna 0 (stub).

Fluxo por round (5 min):
  1. Busca round ativo via GET /rodovia/rounds/active
  2. A cada METRICS_INTERVAL_SEC: envia contagem parcial (POST metrics)
  3. Ao detectar fim do round: envia contagem final (POST finalize)
  4. Aguarda início do próximo round

Configuração via .env (copie .env.example → .env e preencha):
  API_BASE_URL, RODOVIA_WORKER_KEY
"""

import os
import time
import logging
from datetime import datetime, timezone
from typing import Optional

import requests
from dotenv import load_dotenv

load_dotenv()

# ── Configuração ──────────────────────────────────────────────────────────────

API_BASE_URL       = os.getenv("API_BASE_URL", "http://localhost:3001")
WORKER_KEY         = os.getenv("RODOVIA_WORKER_KEY", "")
METRICS_INTERVAL   = int(os.getenv("METRICS_INTERVAL_SEC", "10"))   # segundos entre updates
POLL_INTERVAL      = int(os.getenv("POLL_INTERVAL_SEC", "5"))       # segundos ao aguardar round
LOG_LEVEL          = os.getenv("LOG_LEVEL", "INFO")

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s [worker] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

HEADERS = {
    "Content-Type": "application/json",
    "x-worker-key": WORKER_KEY,
}

# ── Stub de contagem — substituir por YOLO/ByteTrack ─────────────────────────

def get_vehicle_count(elapsed_sec: float = 0.0) -> tuple[int, dict]:
    """
    Stub: retorna contagem simulada para validação do pipeline.

    Retorna:
        count       — número de veículos no período atual (acumulado)
        diagnostics — dados opcionais de saúde da fonte
    """
    # TODO: integrar captura de câmera + inferência YOLO + ByteTrack
    count = 0
    diagnostics = {
        "fps": None,
        "active_tracks": None,
        "source_lag_ms": None,
        "source_health": "ok",
    }
    return count, diagnostics

# ── Comunicação com o backend ─────────────────────────────────────────────────

def fetch_active_round() -> Optional[dict]:
    """Busca o round ativo. Retorna None se indisponível."""
    try:
        resp = requests.get(
            f"{API_BASE_URL}/rodovia/rounds/active",
            timeout=10,
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.warning("fetch_active_round falhou: %s", exc)
        return None


def send_metrics(round_id: str, current_count: int, diagnostics: dict) -> bool:
    """Envia contagem parcial. Retorna True se aceito."""
    payload = {
        "currentCount": current_count,
        "sourceHealth": diagnostics.get("source_health", "ok"),
    }
    if diagnostics.get("fps") is not None:
        payload["fps"] = diagnostics["fps"]
    if diagnostics.get("active_tracks") is not None:
        payload["activeTracks"] = diagnostics["active_tracks"]
    if diagnostics.get("source_lag_ms") is not None:
        payload["sourceLagMs"] = diagnostics["source_lag_ms"]

    try:
        resp = requests.post(
            f"{API_BASE_URL}/rodovia/rounds/{round_id}/metrics",
            json=payload,
            headers=HEADERS,
            timeout=10,
        )
        if resp.status_code == 200:
            log.debug("metrics enviada — roundId=%s count=%d", round_id, current_count)
            return True
        log.warning("metrics rejeitada — status=%d body=%s", resp.status_code, resp.text[:200])
        return False
    except Exception as exc:
        log.warning("send_metrics falhou: %s", exc)
        return False


def send_finalize(round_id: str, final_count: int) -> bool:
    """Envia contagem final autoritativa. Retorna True se aceito."""
    try:
        resp = requests.post(
            f"{API_BASE_URL}/rodovia/rounds/{round_id}/finalize",
            json={"finalCount": final_count},
            headers=HEADERS,
            timeout=10,
        )
        if resp.status_code == 200:
            log.info("round finalizado — roundId=%s finalCount=%d", round_id, final_count)
            return True
        log.warning("finalize rejeitado — status=%d body=%s", resp.status_code, resp.text[:200])
        return False
    except Exception as exc:
        log.warning("send_finalize falhou: %s", exc)
        return False

# ── Loop principal ────────────────────────────────────────────────────────────

def parse_iso(ts: str) -> datetime:
    """Parse ISO 8601 com timezone."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def run_round(round_data: dict) -> None:
    """
    Executa o ciclo de um round completo:
      - envia metrics a cada METRICS_INTERVAL seg até endsAt
      - envia finalize ao final
    """
    round_id   = round_data["roundId"]
    ends_at    = parse_iso(round_data["endsAt"])
    threshold  = round_data.get("threshold", 145)

    log.info(
        "▶ Round iniciado — id=%s threshold=%d endsAt=%s",
        round_id, threshold, ends_at.isoformat(),
    )

    total_count    = 0
    last_send_time = time.monotonic()

    while True:
        now_utc    = datetime.now(timezone.utc)
        remaining  = (ends_at - now_utc).total_seconds()

        if remaining <= 0:
            # Round encerrado — envia contagem final
            log.info("⏹ Round encerrado, enviando finalize — count=%d", total_count)
            send_finalize(round_id, total_count)
            break

        elapsed = time.monotonic() - last_send_time
        if elapsed >= METRICS_INTERVAL:
            count, diagnostics = get_vehicle_count(elapsed_sec=elapsed)
            total_count += count
            send_metrics(round_id, total_count, diagnostics)
            last_send_time = time.monotonic()

        time.sleep(1)


def wait_for_round() -> dict:
    """Aguarda até que um round ativo esteja disponível."""
    log.info("⏳ Aguardando round ativo...")
    while True:
        data = fetch_active_round()
        if data and data.get("roundId"):
            return data
        time.sleep(POLL_INTERVAL)


def main():
    log.info(
        "Worker Rodovia iniciado — API=%s interval=%ds",
        API_BASE_URL, METRICS_INTERVAL,
    )
    if not WORKER_KEY:
        log.warning("RODOVIA_WORKER_KEY não configurado — requisições não autenticadas")

    while True:
        try:
            round_data = wait_for_round()
            run_round(round_data)
            # Pequena pausa antes de buscar próximo round
            time.sleep(POLL_INTERVAL)
        except KeyboardInterrupt:
            log.info("Worker encerrado pelo usuário.")
            break
        except Exception as exc:
            log.error("Erro inesperado no loop principal: %s", exc, exc_info=True)
            time.sleep(10)


if __name__ == "__main__":
    main()
