"""Private JSONL worker. Synthesis uses local weights; no listening socket."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import queue
import re
import sys
import threading
import time

PROTOCOL = sys.stdout
sys.stdout = sys.stderr
WRITE_LOCK = threading.Lock()
MODEL_ID = "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit"
MODEL_REVISION = "08c72cad5e2fd0f41730c8bd1f28149585e46361"
MODEL_BYTES = 1694464000
VOICES = {"serena", "vivian", "uncle_fu", "ryan", "aiden", "ono_anna", "sohee", "eric", "dylan"}


def emit(kind, **values):
    with WRITE_LOCK:
        PROTOCOL.write(json.dumps({"type": kind, **values}, ensure_ascii=False) + "\n")
        PROTOCOL.flush()


def prepare(model_path):
    from huggingface_hub import snapshot_download
    done = threading.Event()

    def progress():
        while not done.wait(1):
            total = sum(p.stat().st_size for p in model_path.rglob("*") if p.is_file())
            emit("progress", phase="downloading", progress=min(99, int(total * 100 / MODEL_BYTES)))

    emit("progress", phase="downloading", progress=0)
    threading.Thread(target=progress, daemon=True).start()
    try:
        snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=str(model_path),
                          ignore_patterns=["README.md", ".gitattributes"])
    finally:
        done.set()


def split_text(text):
    """Keep the first request small without breaking words or punctuation."""
    parts, current = [], ""
    for sentence in re.split(r"(?<=[。！？.!?;；\n])\s*", text):
        if not sentence:
            continue
        for fragment in re.findall(r".{1,180}(?:\s+|$)|.{1,180}", sentence):
            if current and len(current) + len(fragment) > 180:
                parts.append(current.strip())
                current = ""
            current += fragment
    if current.strip():
        parts.append(current.strip())
    return parts


def serve(model_path):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    emit("progress", phase="loading")
    from mlx_audio.tts.utils import load_model
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    mx.set_cache_limit(256 * 1024 * 1024)
    model = load_model(str(model_path))
    # Compile Metal kernels before announcing readiness; no warm-up audio is played.
    for _ in model.generate_custom_voice(text="你好。", speaker="serena", language="auto", stream=True,
                                          streaming_interval=0.48, max_tokens=64, verbose=False):
        pass
    mx.clear_cache()
    jobs = queue.Queue()
    cancellations = {}
    events_lock = threading.Lock()

    def reader():
        for line in sys.stdin:
            try:
                value = json.loads(line)
                request_id = value.get("id")
                if not isinstance(request_id, str) or len(request_id) > 100:
                    continue
                with events_lock:
                    if value.get("type") == "cancel":
                        if request_id in cancellations:
                            cancellations[request_id].set()
                    elif value.get("type") == "synthesize":
                        event = threading.Event()
                        cancellations[request_id] = event
                        jobs.put((value, event))
            except (ValueError, TypeError):
                continue
        os._exit(0)  # Parent exits or closes stdin: never leave the model behind.

    threading.Thread(target=reader, daemon=True).start()
    emit("ready")
    while True:
        request, cancelled = jobs.get()
        request_id = request["id"]
        try:
            text, voice = request.get("text", ""), request.get("voice", "serena")
            if not isinstance(text, str) or not text.strip() or len(text) > 5000 or voice not in VOICES:
                raise ValueError("invalid_request")
            started, first = time.monotonic(), True
            seconds = 0
            for part in split_text(text):
                if cancelled.is_set():
                    break
                for result in model.generate_custom_voice(text=part, speaker=voice, language="auto", stream=True,
                                                          streaming_interval=0.48, max_tokens=1800, verbose=False):
                    if cancelled.is_set():
                        break
                    audio = np.asarray(result.audio, dtype=np.float32)
                    if not audio.size:
                        continue
                    output = io.BytesIO()
                    sf.write(output, audio, result.sample_rate, format="WAV", subtype="PCM_16")
                    seconds += audio.size / result.sample_rate
                    emit("chunk", id=request_id, audio=base64.b64encode(output.getvalue()).decode("ascii"),
                         mimeType="audio/wav")
                    if first:
                        emit("timing", id=request_id, firstAudioMs=round((time.monotonic() - started) * 1000))
                        first = False
            if cancelled.is_set():
                emit("failed", id=request_id, code="cancelled")
            else:
                emit("done", id=request_id, generationMs=round((time.monotonic() - started) * 1000), audioSeconds=seconds)
        except Exception as error:
            print(f"Local speech generation failed: {type(error).__name__}", file=sys.stderr)
            emit("failed", id=request_id, code="generation_failed")
        finally:
            with events_lock:
                cancellations.pop(request_id, None)
            mx.clear_cache()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--prepare", action="store_true")
    args = parser.parse_args()
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    model_path = Path(args.model_dir)
    try:
        if args.prepare:
            prepare(model_path)
        serve(model_path)
    except Exception as error:
        print(f"Local speech startup failed: {type(error).__name__}: {error}", file=sys.stderr)
        emit("fatal", code="startup_failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
