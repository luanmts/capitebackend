"""
Rodovia Castelo Branco — Worker de Contagem de Veículos
YOLO v8 + ByteTrack + cruzamento de linha virtual

Fluxo por round (5 min):
  1. Busca round ativo via GET /rodovia/rounds/active
  2. VehicleCounter roda em thread de fundo contando cruzamentos
  3. A cada METRICS_INTERVAL_SEC: envia contagem acumulada (POST metrics)
  4. Ao atingir endsAt: drena cruzamentos pendentes e envia finalize
  5. Aguarda próximo round

Configuração completa via .env — veja .env.example
"""

import os
import threading
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
METRICS_INTERVAL   = int(os.getenv("METRICS_INTERVAL_SEC", "10"))
POLL_INTERVAL      = int(os.getenv("POLL_INTERVAL_SEC", "5"))

# Visão computacional
RTSP_URL           = os.getenv("RTSP_URL", "")
YOLO_MODEL         = os.getenv("YOLO_MODEL", "yolov8n.pt")
CONFIDENCE         = float(os.getenv("CONFIDENCE_THRESHOLD", "0.4"))
FRAME_SKIP         = int(os.getenv("FRAME_SKIP", "2"))          # processa 1 a cada N frames
DEVICE             = os.getenv("DEVICE", "cpu")                 # "cpu" | "cuda" | "mps"
VEHICLE_CLASSES    = os.getenv("VEHICLE_CLASSES", "car,truck,bus,motorcycle")

# Linha virtual — coordenadas relativas (0.0–1.0) ao tamanho do frame
# LINE_START="0.0,0.5" LINE_END="1.0,0.5"  → linha horizontal no centro
# LINE_START="0.5,0.0" LINE_END="0.5,1.0"  → linha vertical no centro
LINE_START         = tuple(float(x) for x in os.getenv("LINE_START", "0.0,0.5").split(","))
LINE_END           = tuple(float(x) for x in os.getenv("LINE_END",   "1.0,0.5").split(","))

LOG_LEVEL          = os.getenv("LOG_LEVEL", "INFO")

# Debug visual — salva frames anotados em disco para calibração
# DEBUG_OUTPUT_DIR=""  → desativado (padrão)
# DEBUG_OUTPUT_DIR="/tmp/rodovia_debug"  → salva 1 frame a cada DEBUG_SAVE_EVERY frames
DEBUG_OUTPUT_DIR   = os.getenv("DEBUG_OUTPUT_DIR", "")
DEBUG_SAVE_EVERY   = int(os.getenv("DEBUG_SAVE_EVERY", "30"))   # 1 frame a cada N frames processados

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

# ── VehicleCounter — thread de fundo ─────────────────────────────────────────

class VehicleCounter:
    """
    Captura frames do stream RTSP em background, detecta veículos com YOLO,
    rastreia com ByteTrack e conta cruzamentos de uma linha virtual.

    Uso:
        counter = VehicleCounter()
        counter.start()
        # ... no loop de round:
        incremental, diag = counter.get_incremental()
        total += incremental
    """

    def __init__(self):
        self._lock              = threading.Lock()
        self._total_crossings   = 0   # cruzamentos acumulados desde o início
        self._last_read         = 0   # total na última chamada de get_incremental()
        self._source_health     = "initializing"
        self._fps               = None
        self._active_tracks     = 0
        self._running           = False
        self._thread: Optional[threading.Thread] = None

        # Imports pesados só na inicialização — falha explícita se libs ausentes
        try:
            from ultralytics import YOLO
            import supervision as sv
            import cv2
            self._cv2 = cv2
            self._sv  = sv
            self._model = YOLO(YOLO_MODEL)
            log.info("VehicleCounter: modelo %s carregado — device=%s", YOLO_MODEL, DEVICE)
        except ImportError as exc:
            raise RuntimeError(
                f"Dependências de visão não instaladas: {exc}\n"
                "Execute: pip install ultralytics supervision opencv-python"
            ) from exc

        # Anotadores do debug visual (instanciados uma vez, reutilizados por frame)
        if DEBUG_OUTPUT_DIR:
            import os as _os
            _os.makedirs(DEBUG_OUTPUT_DIR, exist_ok=True)
            self._box_ann   = sv.BoxAnnotator(thickness=2)
            self._label_ann = sv.LabelAnnotator(text_scale=0.5, text_thickness=1)
            self._line_ann  = sv.LineZoneAnnotator(thickness=2, text_thickness=1, text_scale=0.5)
            log.info("Debug visual ATIVO — frames salvos em %s a cada %d frames", DEBUG_OUTPUT_DIR, DEBUG_SAVE_EVERY)
        else:
            self._box_ann   = None
            self._label_ann = None
            self._line_ann  = None

        self._debug_frame_n = 0   # contador de frames processados para o debug
        # IDs que cruzaram neste frame — destacados em amarelo por 1 frame salvo
        self._just_crossed: set = set()

        # Mapeia nomes de classe → IDs do modelo
        class_filter = {c.strip() for c in VEHICLE_CLASSES.split(",")}
        self._class_ids = {
            k for k, v in self._model.names.items() if v in class_filter
        }
        log.info(
            "VehicleCounter: classes=%s IDs=%s linha=(%s)→(%s)",
            class_filter, self._class_ids, LINE_START, LINE_END,
        )

    def start(self) -> None:
        self._running = True
        self._thread  = threading.Thread(target=self._loop, daemon=True, name="vehicle-counter")
        self._thread.start()
        log.info("VehicleCounter: thread iniciada")

    def stop(self) -> None:
        self._running = False

    def get_incremental(self) -> tuple[int, dict]:
        """
        Retorna a contagem incremental de cruzamentos desde a última chamada
        e um dict de diagnóstico.
        """
        with self._lock:
            current     = self._total_crossings
            incremental = current - self._last_read
            self._last_read = current
            diag = {
                "source_health": self._source_health,
                "fps":           self._fps,
                "active_tracks": self._active_tracks,
                "source_lag_ms": None,
            }
        return incremental, diag

    def _loop(self) -> None:
        sv = self._sv
        cv2 = self._cv2

        if not RTSP_URL:
            log.error("RTSP_URL não configurada — VehicleCounter inativo")
            with self._lock:
                self._source_health = "offline"
            return

        while self._running:
            cap = cv2.VideoCapture(RTSP_URL)
            if not cap.isOpened():
                log.warning("Stream indisponível (%s), tentando em 10s...", RTSP_URL)
                with self._lock:
                    self._source_health = "offline"
                time.sleep(10)
                continue

            with self._lock:
                self._source_health = "ok"
            log.info("Stream conectado: %s", RTSP_URL)

            tracker   = sv.ByteTrack(
                track_activation_threshold=0.25,
                lost_track_buffer=30,
                minimum_matching_threshold=0.8,
                frame_rate=25,
            )
            line_zone = None  # criada na primeira frame (precisa de w, h)

            frame_n   = 0
            fps_t0    = time.monotonic()
            fps_count = 0

            while self._running:
                ret, frame = cap.read()
                if not ret:
                    log.warning("Frame perdido — reconectando stream...")
                    with self._lock:
                        self._source_health = "degraded"
                    break

                frame_n   += 1
                fps_count += 1

                # Mede FPS real a cada 60 frames
                if fps_count >= 60:
                    elapsed = time.monotonic() - fps_t0
                    measured = fps_count / elapsed if elapsed > 0 else None
                    with self._lock:
                        self._fps = round(measured, 1) if measured else None
                    fps_t0    = time.monotonic()
                    fps_count = 0

                # Salta frames para reduzir carga de CPU/GPU
                if frame_n % FRAME_SKIP != 0:
                    continue

                h, w = frame.shape[:2]

                # Cria a linha virtual com coordenadas absolutas na primeira frame
                if line_zone is None:
                    p1 = sv.Point(int(LINE_START[0] * w), int(LINE_START[1] * h))
                    p2 = sv.Point(int(LINE_END[0]   * w), int(LINE_END[1]   * h))
                    line_zone = sv.LineZone(start=p1, end=p2)
                    log.info("Linha virtual: %s → %s (resolução %dx%d)", p1, p2, w, h)

                # ── Detecção YOLO ──
                results = self._model.predict(
                    frame,
                    conf=CONFIDENCE,
                    classes=list(self._class_ids) if self._class_ids else None,
                    device=DEVICE,
                    verbose=False,
                )
                detections = sv.Detections.from_ultralytics(results[0])

                # ── Rastreamento ByteTrack ──
                detections = tracker.update_with_detections(detections)

                with self._lock:
                    self._active_tracks = len(detections)

                # Ignora se não há IDs de rastreamento (sem detecções)
                if detections.tracker_id is None or len(detections) == 0:
                    continue

                # ── Conta cruzamentos da linha ──
                crossed_in, _crossed_out = line_zone.trigger(detections=detections)
                new = int(crossed_in.sum())

                if new > 0:
                    with self._lock:
                        self._total_crossings += new
                    # Registra IDs que cruzaram para destaque visual
                    if self._box_ann is not None and detections.tracker_id is not None:
                        self._just_crossed = {
                            int(tid)
                            for tid, hit in zip(detections.tracker_id, crossed_in)
                            if hit
                        }
                    log.debug("+%d cruzamento(s) — acumulado=%d", new, self._total_crossings)
                else:
                    self._just_crossed = set()

                # ── Debug visual ──
                if self._box_ann is not None:
                    self._debug_frame_n += 1
                    if self._debug_frame_n % DEBUG_SAVE_EVERY == 0:
                        annotated = frame.copy()

                        # Cores: verde para rastreados, amarelo para quem acabou de cruzar
                        colors = []
                        labels = []
                        for i, tid in enumerate(detections.tracker_id or []):
                            crossed = int(tid) in self._just_crossed
                            colors.append((0, 255, 255) if crossed else (0, 255, 0))  # BGR
                            conf = float(detections.confidence[i]) if detections.confidence is not None else 0.0
                            labels.append(f"#{tid} {'✓' if crossed else ''} {conf:.2f}")

                        # Bounding boxes com cor por status
                        for i, (xyxy, color) in enumerate(zip(detections.xyxy, colors)):
                            x1, y1, x2, y2 = map(int, xyxy)
                            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
                            cv2.putText(annotated, labels[i], (x1, y1 - 6),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)

                        # Linha virtual
                        self._line_ann.annotate(frame=annotated, line_counter=line_zone)

                        # Contador total no canto
                        with self._lock:
                            count_now = self._total_crossings
                        cv2.putText(annotated, f"count={count_now}", (10, 30),
                                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)

                        ts = datetime.now().strftime("%H%M%S_%f")[:9]
                        out_path = f"{DEBUG_OUTPUT_DIR}/frame_{ts}.jpg"
                        cv2.imwrite(out_path, annotated)

            cap.release()

        log.info("VehicleCounter: thread encerrada")

# ── Comunicação com o backend ─────────────────────────────────────────────────

def fetch_active_round() -> Optional[dict]:
    try:
        resp = requests.get(f"{API_BASE_URL}/rodovia/rounds/active", timeout=10)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.warning("fetch_active_round falhou: %s", exc)
        return None


def send_metrics(round_id: str, current_count: int, diag: dict) -> bool:
    payload = {
        "currentCount":  current_count,
        "sourceHealth":  diag.get("source_health", "ok"),
    }
    if diag.get("fps")           is not None: payload["fps"]           = diag["fps"]
    if diag.get("active_tracks") is not None: payload["activeTracks"] = diag["active_tracks"]
    if diag.get("source_lag_ms") is not None: payload["sourceLagMs"]  = diag["source_lag_ms"]

    try:
        resp = requests.post(
            f"{API_BASE_URL}/rodovia/rounds/{round_id}/metrics",
            json=payload, headers=HEADERS, timeout=10,
        )
        if resp.status_code == 200:
            log.debug("metrics OK — count=%d health=%s", current_count, payload["sourceHealth"])
            return True
        log.warning("metrics rejeitada %d — %s", resp.status_code, resp.text[:200])
        return False
    except Exception as exc:
        log.warning("send_metrics falhou: %s", exc)
        return False


def send_finalize(round_id: str, final_count: int) -> bool:
    try:
        resp = requests.post(
            f"{API_BASE_URL}/rodovia/rounds/{round_id}/finalize",
            json={"finalCount": final_count}, headers=HEADERS, timeout=10,
        )
        if resp.status_code == 200:
            log.info("✔ round finalizado — finalCount=%d", final_count)
            return True
        log.warning("finalize rejeitado %d — %s", resp.status_code, resp.text[:200])
        return False
    except Exception as exc:
        log.warning("send_finalize falhou: %s", exc)
        return False

# ── Loop de round ─────────────────────────────────────────────────────────────

def parse_iso(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def run_round(round_data: dict, counter: VehicleCounter) -> None:
    round_id  = round_data["roundId"]
    ends_at   = parse_iso(round_data["endsAt"])
    threshold = round_data.get("threshold", 145)

    log.info("▶ Round — id=%s  threshold=%d  endsAt=%s",
             round_id, threshold, ends_at.isoformat())

    # Zera contagem incremental no início do round
    counter.get_incremental()

    total_count    = 0
    last_send_time = time.monotonic()

    while True:
        now_utc   = datetime.now(timezone.utc)
        remaining = (ends_at - now_utc).total_seconds()

        # Envia última métrica pendente antes de finalizar
        if time.monotonic() - last_send_time >= METRICS_INTERVAL:
            incremental, diag = counter.get_incremental()
            total_count += incremental
            send_metrics(round_id, total_count, diag)
            last_send_time = time.monotonic()

        # Finaliza ao atingir endsAt real — sai do loop imediatamente
        if remaining <= 0:
            incremental, diag = counter.get_incremental()
            total_count += incremental
            log.info("⏹ Round encerrado — enviando finalize count=%d", total_count)
            send_finalize(round_id, total_count)
            break

        time.sleep(1)


def wait_for_round() -> dict:
    log.info("⏳ Aguardando round ativo...")
    while True:
        data = fetch_active_round()
        if data and data.get("roundId"):
            return data
        time.sleep(POLL_INTERVAL)

# ── Entrypoint ────────────────────────────────────────────────────────────────

def main():
    log.info("Worker Rodovia — API=%s  model=%s  rtsp=%s",
             API_BASE_URL, YOLO_MODEL, RTSP_URL or "(não configurado)")

    if not WORKER_KEY:
        log.warning("RODOVIA_WORKER_KEY ausente — requisições não autenticadas")
    if not RTSP_URL:
        log.error("RTSP_URL não configurada — worker não irá contar veículos")

    counter = VehicleCounter()
    counter.start()

    try:
        while True:
            try:
                round_data = wait_for_round()
                run_round(round_data, counter)
                time.sleep(POLL_INTERVAL)
            except KeyboardInterrupt:
                raise
            except Exception as exc:
                log.error("Erro no loop principal: %s", exc, exc_info=True)
                time.sleep(10)
    except KeyboardInterrupt:
        log.info("Worker encerrado pelo usuário.")
    finally:
        counter.stop()


if __name__ == "__main__":
    main()
