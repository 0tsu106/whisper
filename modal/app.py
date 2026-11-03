"""Modal のアプリ定義。

    modal deploy app.py                                   # Worker から呼ぶ本番用
    modal run app.py::main --input lecture.mp3 --output out.json  # コマンドから1本だけ実行
"""

import json
import logging
import os
import tempfile
import time
from pathlib import Path

import modal

import pipeline

GPU = "T4"
FUNCTION_TIMEOUT_SEC = 60 * 60
MODEL_DIR = Path("/models")
CLI_INPUT_DIR = Path("/cli-inputs")
PYTHON_SITE_PACKAGES = "/usr/local/lib/python3.12/site-packages"

app = modal.App("whisper-transcriber")

# モデルの重みをキャッシュし、起動のたびにダウンロードしない
model_volume = modal.Volume.from_name("whisper-models", create_if_missing=True)
cli_input_volume = modal.Volume.from_name("whisper-cli-inputs", create_if_missing=True)

gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "libsndfile1")
    .pip_install_from_requirements(str(Path(__file__).parent / "requirements.txt"))
    .env({
        "HF_HOME": str(MODEL_DIR / "huggingface"),
        # ctranslate2 が torch の同梱する CUDA ライブラリを見つけられるようにする
        "LD_LIBRARY_PATH": f"{PYTHON_SITE_PACKAGES}/nvidia/cublas/lib:{PYTHON_SITE_PACKAGES}/nvidia/cudnn/lib",
    })
    .add_local_python_source("pipeline")
)
# Modal は各コンテナで app.py 全体を読み込むため、Web 用にも pipeline とその依存が要る
web_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]", "requests==2.34.2")
    .add_local_python_source("pipeline")
)

gpu_function_options = {
    "image": gpu_image,
    "gpu": GPU,
    "timeout": FUNCTION_TIMEOUT_SEC,
    "scaledown_window": 60,
    # 再試行は Worker が管理する
    "retries": 0,
    "secrets": [modal.Secret.from_name("whisper-secrets")],
}


def commit_model_cache() -> None:
    # キャッシュの保存に失敗しても、次回ダウンロードし直すだけなのでジョブは失敗させない
    try:
        model_volume.commit()
        pipeline.log_event("model_cache.committed")
    except Exception as err:
        pipeline.log_event("model_cache.commit_failed", logging.WARNING, error_name=type(err).__name__)


@app.function(**gpu_function_options, volumes={str(MODEL_DIR): model_volume}, max_containers=2)
def run_job(request: dict) -> None:
    pipeline.configure_logging()
    job_id, attempt = request["job_id"], request["attempt"]
    fields = {"job_id": job_id, "attempt": attempt}
    started = time.monotonic()
    pipeline.log_event("job.started", diarization=request["options"].get("diarization", True), **fields)

    callback = {"job_id": job_id, "attempt": attempt}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            work_dir = Path(tmp)
            audio_path = work_dir / "input"
            pipeline.download_audio(request["audio_url"], audio_path)
            result = pipeline.process_audio(audio_path, work_dir, request["options"], MODEL_DIR, os.environ.get("HF_TOKEN"))
            commit_model_cache()
            pipeline.upload_result(request["result_url"], result)
        callback |= {"status": "completed", "duration_sec": result["duration_sec"]}
        pipeline.log_event("job.finished", elapsed_sec=round(time.monotonic() - started, 1), **fields)
    except pipeline.PipelineError as err:
        pipeline.log_event("job.failed", logging.ERROR, error_code=err.code, detail=str(err), **fields)
        callback |= {"status": "failed", "error_code": err.code}
    except Exception as err:
        pipeline.log_event("job.failed", logging.ERROR, error_code="internal_error", error_name=type(err).__name__, **fields)
        pipeline.logger.exception("unexpected failure")
        callback |= {"status": "failed", "error_code": "internal_error"}

    pipeline.send_callback(request["callback_url"], os.environ["CALLBACK_SECRET"], callback)


@app.function(image=web_image)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def start(request: dict) -> dict:
    """Worker から呼ばれ、処理の完了を待たずに GPU 関数を起動して返す。"""
    call = run_job.spawn(request)
    print(json.dumps({
        "level": "info",
        "event": "job.spawned",
        "job_id": request.get("job_id"),
        "attempt": request.get("attempt"),
        "call_id": call.object_id,
    }))
    return {"call_id": call.object_id}


@app.function(**gpu_function_options, volumes={str(MODEL_DIR): model_volume, str(CLI_INPUT_DIR): cli_input_volume})
def transcribe_file(remote_name: str, options: dict) -> dict:
    """コマンド実行用。Volume に置いた音声を処理し、結果を直接返す。"""
    pipeline.configure_logging()
    with tempfile.TemporaryDirectory() as tmp:
        result = pipeline.process_audio(CLI_INPUT_DIR / remote_name, Path(tmp), options, MODEL_DIR, os.environ.get("HF_TOKEN"))
    commit_model_cache()
    return result


@app.local_entrypoint()
def main(
    input: str,
    output: str = "result.json",
    diarization: bool = True,
    min_speakers: int = 0,
    max_speakers: int = 0,
    terms: str = "",
):
    local_path = Path(input)
    remote_name = f"{int(time.time())}-{local_path.name}"
    print(f"uploading {local_path} ({local_path.stat().st_size} bytes)")
    with cli_input_volume.batch_upload() as batch:
        batch.put_file(str(local_path), remote_name)

    options = {
        "diarization": diarization,
        "min_speakers": min_speakers or None,
        "max_speakers": max_speakers or None,
        "terms": [t.strip() for t in terms.split(",") if t.strip()],
    }
    started = time.monotonic()
    try:
        result = transcribe_file.remote(remote_name, options)
    finally:
        cli_input_volume.remove_file(remote_name)
        print("removed the uploaded audio from the volume")
    Path(output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    elapsed = time.monotonic() - started
    print(f"wrote {output}: {result['duration_sec']:.0f}s of audio, {len(result['segments'])} segments, {elapsed:.0f}s elapsed")
