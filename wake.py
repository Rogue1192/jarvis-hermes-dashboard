"""
Offline "Hey JARVIS" wake word.

Holds the microphone open in a background thread and scores 80 ms frames with
openWakeWord. Detection runs entirely on this machine -- no audio is uploaded,
no API key, no per-use cost. Nothing here talks to the network except the
one-time model download on first run.

Why this lives in the server and not in the browser
---------------------------------------------------
Browsers throttle timers and suspend audio in background tabs. A wake word that
stops listening the moment you switch tabs is not a wake word. Keeping the
detector in the Python process means it hears you whatever the browser is doing,
and there is exactly one detector no matter how many tabs are open.

How it fits together
--------------------
    this module          detects "hey jarvis", raises a one-shot flag
    GET  /api/wake       browser polls, consumes the flag
    ui/app.js            on a trigger, starts the same listening turn the
                         microphone button starts
    POST /api/wake       browser mutes the detector during a conversation, so
                         JARVIS never wakes himself on his own voice

Environment:
    JARVIS_WAKE=0                 disable entirely
    JARVIS_WAKE_THRESHOLD=0.5     0-1; lower = more sensitive, more false fires
    JARVIS_WAKE_DEVICE=<index>    microphone index, when the default is wrong
"""
import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

FRAME = 1280                      # 80 ms at 16 kHz -- openWakeWord's frame size
SAMPLE_RATE = 16000
COOLDOWN_S = 3.0                  # ignore repeat hits right after a trigger

ENABLED = os.environ.get("JARVIS_WAKE", "1").strip() != "0"
THRESHOLD = float(os.environ.get("JARVIS_WAKE_THRESHOLD", "0.5") or 0.5)
_DEVICE = os.environ.get("JARVIS_WAKE_DEVICE", "").strip()
DEVICE = int(_DEVICE) if _DEVICE.isdigit() else None

_LOCK = threading.Lock()
_STOP = threading.Event()
_MUTED = threading.Event()        # set while a conversation is in progress
_THREAD = None
_STATE = {
    "running": False,
    "error": "",
    "score": 0.0,
    "peak": 0.0,
    "triggered_at": 0.0,
    "trigger_count": 0,
}
_PENDING = False                  # one-shot flag consumed by the browser


# ── model ────────────────────────────────────────────────────────────────

def _load_model():
    """Return an openWakeWord model that scores 'hey jarvis'.

    The pretrained model name has moved between releases, so try the friendly
    name first and fall back to loading every bundled model (we pick the jarvis
    score out of the results either way).
    """
    import openwakeword
    from openwakeword.model import Model

    try:
        openwakeword.utils.download_models(model_names=["hey_jarvis"])
    except Exception:                                          # noqa: BLE001
        try:
            openwakeword.utils.download_models()
        except Exception as e:                                 # noqa: BLE001
            logger.warning("wake: model download failed: %s", e)

    for spec in (["hey_jarvis"], ["hey_jarvis_v0.1"], None):
        try:
            return Model(wakeword_models=spec) if spec else Model()
        except Exception as e:                                 # noqa: BLE001
            last = e
    raise RuntimeError(f"could not load a wake word model: {last}")


def _jarvis_score(scores):
    """Pull the jarvis confidence out of a predict() result."""
    if not scores:
        return 0.0
    hits = [v for k, v in scores.items() if "jarvis" in str(k).lower()]
    return float(max(hits)) if hits else float(max(scores.values()))


# ── the listening loop ───────────────────────────────────────────────────

def _loop():
    global _PENDING
    try:
        import numpy as np
        import sounddevice as sd
    except Exception as e:                                     # noqa: BLE001
        with _LOCK:
            _STATE["error"] = f"missing audio libraries: {e}"
        return

    try:
        model = _load_model()
    except Exception as e:                                     # noqa: BLE001
        with _LOCK:
            _STATE["error"] = str(e)[:300]
        return

    try:
        stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1,
                                dtype="int16", blocksize=FRAME, device=DEVICE)
        stream.start()
    except Exception as e:                                     # noqa: BLE001
        with _LOCK:
            _STATE["error"] = f"microphone unavailable: {e}"[:300]
        return

    with _LOCK:
        _STATE["running"] = True
        _STATE["error"] = ""
    logger.info("wake: listening for 'hey jarvis' (threshold %.2f)", THRESHOLD)

    last_trigger = 0.0
    try:
        while not _STOP.is_set():
            try:
                data, _overflow = stream.read(FRAME)
            except Exception as e:                             # noqa: BLE001
                # An overrun is normal under load; keep going rather than dying.
                logger.debug("wake: read hiccup: %s", e)
                continue

            if _MUTED.is_set():
                # Drop the model's internal buffer so JARVIS's own voice coming
                # back through the speakers cannot accumulate into a detection.
                if hasattr(model, "reset"):
                    try:
                        model.reset()
                    except Exception:                          # noqa: BLE001
                        pass
                with _LOCK:
                    _STATE["score"] = 0.0
                continue

            frame = np.asarray(data, dtype=np.int16).reshape(-1)
            try:
                score = _jarvis_score(model.predict(frame))
            except Exception as e:                             # noqa: BLE001
                logger.debug("wake: predict failed: %s", e)
                continue

            now = time.monotonic()
            with _LOCK:
                _STATE["score"] = score
                _STATE["peak"] = max(_STATE["peak"], score)

            if score >= THRESHOLD and (now - last_trigger) > COOLDOWN_S:
                last_trigger = now
                if hasattr(model, "reset"):
                    try:
                        model.reset()
                    except Exception:                          # noqa: BLE001
                        pass
                with _LOCK:
                    _PENDING = True
                    _STATE["triggered_at"] = time.time()
                    _STATE["trigger_count"] += 1
                logger.info("wake: triggered (%.2f)", score)
    finally:
        try:
            stream.stop()
            stream.close()
        except Exception:                                      # noqa: BLE001
            pass
        with _LOCK:
            _STATE["running"] = False


# ── public surface ───────────────────────────────────────────────────────

def start():
    """Begin listening. Safe to call twice; the second call does nothing."""
    global _THREAD
    if not ENABLED:
        with _LOCK:
            _STATE["error"] = "disabled (JARVIS_WAKE=0)"
        return False
    if _THREAD and _THREAD.is_alive():
        return True
    _STOP.clear()
    _THREAD = threading.Thread(target=_loop, name="wake-word", daemon=True)
    _THREAD.start()
    # Give the model a moment to load so /api/status reports something truthful
    # on the first page load rather than a misleading "off".
    for _ in range(60):
        with _LOCK:
            if _STATE["running"] or _STATE["error"]:
                break
        time.sleep(0.25)
    with _LOCK:
        return _STATE["running"]


def stop():
    _STOP.set()


def mute(on=True):
    """Pause detection during a conversation, resume when it ends."""
    _MUTED.set() if on else _MUTED.clear()


def take_trigger():
    """Consume the one-shot trigger. True at most once per detection."""
    global _PENDING
    with _LOCK:
        fired, _PENDING = _PENDING, False
        return fired


def status():
    with _LOCK:
        s = dict(_STATE)
    s["enabled"] = ENABLED
    s["muted"] = _MUTED.is_set()
    s["threshold"] = THRESHOLD
    return s
