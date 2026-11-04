"""文字起こし処理の本体。Modal に依存せず、GPU なしでも一部を単体テストできる。

文字起こし本文、署名付き URL、用語リストはログに出さないこと。
"""

import hashlib
import hmac
import json
import logging
import subprocess
import sys
import time
from pathlib import Path

import requests

RESULT_VERSION = 1
LANGUAGE = "ja"
WHISPER_MODEL = "large-v3"
DIARIZATION_MODEL = "pyannote/speaker-diarization-community-1"

MAX_AUDIO_BYTES = 300 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
HTTP_TIMEOUT_SEC = (10, 300)
CALLBACK_TIMEOUT_SEC = (10, 60)
CALLBACK_MAX_ATTEMPTS = 6
PROGRESS_INTERVAL_SEC = 300.0

# 話者の割り当て: 発話の長さがこれより短い連続区間は、隣の話者に吸収する
MIN_RUN_SEC = 1.0
# Whisper は無音まで含めて1文字の時刻を伸ばすことがあるため、1文字をこの長さまでしか数えない
MAX_CHAR_SEC = 0.5
# 同じ話者の隣り合う区間を、この間隔以内かつこの文字数以内なら1つの発言にまとめる
MAX_JOIN_GAP_SEC = 1.5
MAX_UTTERANCE_CHARS = 200
# 話者が不明な区間は別人の発言を混ぜるおそれがあるため、ほぼ連続し、文が終わっていないときだけまとめる
MAX_UNLABELED_JOIN_GAP_SEC = 0.5
SENTENCE_ENDINGS = ("。", "．", ".", "!", "！", "?", "？")

logger = logging.getLogger("whisper")


def configure_logging() -> None:
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, format="%(message)s", force=True)
    # DEBUG ログには署名付き URL のクエリ文字列が含まれる
    logging.getLogger("urllib3").setLevel(logging.WARNING)


def log_event(event: str, level: int = logging.INFO, **fields) -> None:
    logger.log(level, json.dumps({"level": logging.getLevelName(level).lower(), "event": event, **fields}))


class PipelineError(Exception):
    """失敗理由の分類を持つ例外。code が Worker と画面に渡る。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code


def download_audio(url: str, dest: Path, max_bytes: int = MAX_AUDIO_BYTES) -> int:
    started = time.monotonic()
    total = 0
    try:
        with requests.get(url, stream=True, timeout=HTTP_TIMEOUT_SEC) as response:
            if response.status_code != 200:
                raise PipelineError("download_failed", f"status {response.status_code}")
            with dest.open("wb") as file:
                for chunk in response.iter_content(DOWNLOAD_CHUNK_BYTES):
                    total += len(chunk)
                    if total > max_bytes:
                        raise PipelineError("file_too_large", f"exceeded {max_bytes} bytes")
                    file.write(chunk)
    except requests.RequestException as err:
        # 例外メッセージに署名付き URL が含まれるため、型名だけを残す
        raise PipelineError("download_failed", type(err).__name__) from None
    log_event("audio.downloaded", size_bytes=total, elapsed_sec=round(time.monotonic() - started, 1))
    return total


NORMALIZE_FILTER = "highpass=f=80,dynaudnorm=f=150:g=15"


def convert_to_wav(source: Path, dest: Path, normalize: bool = False) -> None:
    started = time.monotonic()
    # normalize: 片方の声が小さい通話録音などで、小声の取りこぼしを減らす
    filters = ["-af", NORMALIZE_FILTER] if normalize else []
    result = subprocess.run(
        [
            "ffmpeg", "-nostdin", "-y", "-loglevel", "error",
            "-i", str(source),
            "-vn", *filters, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            str(dest),
        ],
        capture_output=True,
        text=True,
        errors="replace",
    )
    if result.returncode != 0:
        log_event("audio.convert_failed", logging.ERROR, returncode=result.returncode, stderr=result.stderr[-500:])
        raise PipelineError("audio_decode_failed", f"ffmpeg exited with {result.returncode}")
    log_event("audio.converted", size_bytes=dest.stat().st_size, elapsed_sec=round(time.monotonic() - started, 1))


def transcribe(
    wav_path: Path,
    terms: list[str],
    model_dir: Path,
    device: str = "cuda",
    vad: bool = True,
    vad_threshold: float | None = None,
    vad_min_silence_ms: int | None = None,
    context: bool = False,
    model_name: str = WHISPER_MODEL,
) -> tuple[list[dict], float]:
    from faster_whisper import WhisperModel

    started = time.monotonic()
    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_name, device=device, compute_type=compute_type, download_root=str(model_dir / "whisper"))
    log_event("whisper.model_loaded", model=model_name, device=device, elapsed_sec=round(time.monotonic() - started, 1))

    vad_parameters = {}
    if vad_threshold is not None:
        vad_parameters["threshold"] = vad_threshold
    if vad_min_silence_ms is not None:
        vad_parameters["min_silence_duration_ms"] = vad_min_silence_ms

    started = time.monotonic()
    raw_segments, info = model.transcribe(
        str(wav_path),
        language=LANGUAGE,
        word_timestamps=True,
        vad_filter=vad,
        vad_parameters=vad_parameters or None,
        # context: 前の文を手がかりにして固有名詞などを安定させる。繰り返しは下の閾値で抑える
        condition_on_previous_text=context,
        compression_ratio_threshold=2.4,
        no_speech_threshold=0.6,
        hallucination_silence_threshold=2.0,
        initial_prompt="、".join(terms) if terms else None,
    )

    segments: list[dict] = []
    next_progress = PROGRESS_INTERVAL_SEC
    # raw_segments はジェネレータで、ここで実際の推論が走る
    for segment in raw_segments:
        segments.append({
            "start": segment.start,
            "end": segment.end,
            "text": segment.text,
            "words": [{"start": w.start, "end": w.end, "text": w.word} for w in (segment.words or [])],
        })
        if segment.end >= next_progress:
            next_progress = segment.end + PROGRESS_INTERVAL_SEC
            log_event(
                "whisper.progress",
                position_sec=round(segment.end, 1),
                duration_sec=round(info.duration, 1),
                segments=len(segments),
                elapsed_sec=round(time.monotonic() - started, 1),
            )
    log_event(
        "whisper.finished",
        duration_sec=round(info.duration, 1),
        segments=len(segments),
        elapsed_sec=round(time.monotonic() - started, 1),
    )
    return segments, info.duration


def diarize(
    wav_path: Path,
    hf_token: str,
    min_speakers: int | None = None,
    max_speakers: int | None = None,
    device: str = "cuda",
) -> list[dict]:
    import soundfile
    import torch
    from pyannote.audio import Pipeline

    started = time.monotonic()
    pipeline = Pipeline.from_pretrained(DIARIZATION_MODEL, token=hf_token)
    pipeline.to(torch.device(device))
    log_event("diarization.model_loaded", model=DIARIZATION_MODEL, device=device, elapsed_sec=round(time.monotonic() - started, 1))

    # メモリ上の波形を渡すと、pyannote 側の音声デコード(torchcodec)を経由しない
    samples, sample_rate = soundfile.read(str(wav_path), dtype="float32")
    waveform = torch.from_numpy(samples).unsqueeze(0)

    kwargs = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers

    started = time.monotonic()
    output = pipeline({"waveform": waveform, "sample_rate": sample_rate}, **kwargs)
    # exclusive は同時発話を1人に絞った結果で、単語との対応付けに向く
    turns = [
        {"start": turn.start, "end": turn.end, "speaker": speaker}
        for turn, speaker in output.exclusive_speaker_diarization
    ]
    log_event(
        "diarization.finished",
        turns=len(turns),
        speakers=len({t["speaker"] for t in turns}),
        elapsed_sec=round(time.monotonic() - started, 1),
    )
    return turns


def _speaker_for_range(start: float, end: float, turns: list[dict]) -> str | None:
    """重なりが最も長い話者を返す。どの区間とも重ならなければ最も近い区間の話者を返す。"""
    if not turns:
        return None
    overlap_by_speaker: dict[str, float] = {}
    for turn in turns:
        overlap = min(end, turn["end"]) - max(start, turn["start"])
        if overlap > 0:
            overlap_by_speaker[turn["speaker"]] = overlap_by_speaker.get(turn["speaker"], 0.0) + overlap
    if overlap_by_speaker:
        return max(overlap_by_speaker, key=lambda speaker: overlap_by_speaker[speaker])
    nearest = min(turns, key=lambda t: max(t["start"] - end, start - t["end"]))
    return nearest["speaker"]


def _clean_word(word: dict) -> dict:
    return {"start": round(word["start"], 3), "end": round(word["end"], 3), "text": word["text"].strip()}


def _word_speaker(word: dict, turns: list[dict]) -> str | None:
    """単語の後半(中点から終端)で話者を決める。

    Whisper は文頭の1文字の start を実際の発声より早く返し、直前の話者の区間に食い込むことがある。
    後半だけを見れば、その影響を受けない。
    """
    midpoint = (word["start"] + word["end"]) / 2
    return _speaker_for_range(midpoint, word["end"], turns)


def _word_chars(words: list[dict]) -> int:
    return sum(len(w["text"].strip()) for w in words)


def _is_short_run(words: list[dict]) -> bool:
    spoken = sum(min(w["end"] - w["start"], MAX_CHAR_SEC * len(w["text"].strip())) for w in words)
    return spoken < MIN_RUN_SEC


def _split_runs(words: list[dict], turns: list[dict]) -> list[tuple[str | None, list[dict]]]:
    runs: list[tuple[str | None, list[dict]]] = []
    for word in words:
        speaker = _word_speaker(word, turns)
        if runs and runs[-1][0] == speaker:
            runs[-1][1].append(word)
        else:
            runs.append((speaker, [word]))
    return runs


def _absorb_short_runs(runs: list[tuple[str | None, list[dict]]]) -> list[tuple[str | None, list[dict]]]:
    """短い連続区間(相づちや境界のずれ)を、隣の長いほうの話者に吸収する。"""
    while len(runs) > 1:
        index = next((i for i, (_, words) in enumerate(runs) if _is_short_run(words)), None)
        if index is None:
            break
        _, short_words = runs[index]
        has_left, has_right = index > 0, index < len(runs) - 1
        into_left = has_left and (not has_right or _word_chars(runs[index - 1][1]) >= _word_chars(runs[index + 1][1]))
        if into_left:
            speaker, words = runs[index - 1]
            runs[index - 1] = (speaker, words + short_words)
        else:
            speaker, words = runs[index + 1]
            runs[index + 1] = (speaker, short_words + words)
        del runs[index]
        # 吸収の結果、同じ話者が隣り合ったらつなぐ
        coalesced: list[tuple[str | None, list[dict]]] = []
        for speaker, words in runs:
            if coalesced and coalesced[-1][0] == speaker:
                coalesced[-1] = (speaker, coalesced[-1][1] + words)
            else:
                coalesced.append((speaker, words))
        runs = coalesced
    return runs


def _build_segment(words: list[dict], speaker: str | None) -> dict:
    return {
        "start": round(words[0]["start"], 3),
        "end": round(words[-1]["end"], 3),
        "speaker": speaker,
        "text": "".join(w["text"] for w in words).strip(),
        "words": [_clean_word(w) for w in words],
    }


def _can_join(previous: dict, current: dict) -> bool:
    if previous["speaker"] != current["speaker"] or not previous["words"] or not current["words"]:
        return False
    if _word_chars(previous["words"]) + _word_chars(current["words"]) > MAX_UTTERANCE_CHARS:
        return False
    gap = current["words"][0]["start"] - previous["words"][-1]["end"]
    if previous["speaker"] is None:
        last_text = previous["words"][-1]["text"].strip()
        return gap <= MAX_UNLABELED_JOIN_GAP_SEC and not last_text.endswith(SENTENCE_ENDINGS)
    return gap <= MAX_JOIN_GAP_SEC


def merge_speakers(segments: list[dict], turns: list[dict]) -> list[dict]:
    """単語ごとに話者を決め、短い断片をならしたうえで、同じ話者の続きを1つの発言にまとめる。"""
    pieces: list[dict] = []
    for segment in segments:
        words = [w for w in segment["words"] if w["text"].strip()]
        if not words:
            text = segment["text"].strip()
            if text:
                pieces.append({
                    "start": segment["start"],
                    "end": segment["end"],
                    "speaker": _speaker_for_range(segment["start"], segment["end"], turns),
                    "text": text,
                    "words": [],
                })
            continue
        for speaker, run_words in _absorb_short_runs(_split_runs(words, turns)):
            pieces.append({"speaker": speaker, "words": run_words})

    joined: list[dict] = []
    for piece in pieces:
        if joined and _can_join(joined[-1], piece):
            joined[-1]["words"] = joined[-1]["words"] + piece["words"]
        else:
            joined.append(piece)

    merged: list[dict] = []
    for piece in joined:
        if piece["words"]:
            merged.append(_build_segment(piece["words"], piece["speaker"]))
        else:
            merged.append({
                "start": round(piece["start"], 3),
                "end": round(piece["end"], 3),
                "speaker": piece["speaker"],
                "text": piece["text"],
                "words": [],
            })
    return merged


def build_result(
    segments: list[dict], duration_sec: float, diarization_enabled: bool, model_name: str = WHISPER_MODEL
) -> dict:
    speakers = sorted({s["speaker"] for s in segments if s["speaker"] is not None})
    return {
        "version": RESULT_VERSION,
        "language": LANGUAGE,
        "duration_sec": round(duration_sec, 3),
        "model": {
            "transcription": model_name,
            "diarization": DIARIZATION_MODEL if diarization_enabled else None,
        },
        "speakers": speakers,
        "segments": segments,
    }


def process_audio(audio_path: Path, work_dir: Path, options: dict, model_dir: Path, hf_token: str | None) -> dict:
    """音声ファイルから結果の JSON(dict)を作る。段階ごとに失敗理由を分類する。"""
    wav_path = work_dir / "audio.wav"
    convert_to_wav(audio_path, wav_path, normalize=bool(options.get("normalize", False)))

    try:
        segments, duration_sec = transcribe(
            wav_path,
            options.get("terms") or [],
            model_dir,
            vad=options.get("vad", True),
            vad_threshold=options.get("vad_threshold"),
            vad_min_silence_ms=options.get("vad_min_silence_ms"),
            context=bool(options.get("context", False)),
            model_name=options.get("model") or WHISPER_MODEL,
        )
    except PipelineError:
        raise
    except Exception as err:
        log_event("whisper.failed", logging.ERROR, error_name=type(err).__name__)
        logger.exception("whisper failed")
        raise PipelineError(_classify_gpu_error(err, "transcription_failed")) from err

    diarization_enabled = bool(options.get("diarization", True))
    turns: list[dict] = []
    if diarization_enabled:
        if not hf_token:
            raise PipelineError("diarization_failed", "HF_TOKEN is not set")
        try:
            turns = diarize(wav_path, hf_token, options.get("min_speakers"), options.get("max_speakers"))
        except Exception as err:
            log_event("diarization.failed", logging.ERROR, error_name=type(err).__name__)
            logger.exception("diarization failed")
            raise PipelineError(_classify_gpu_error(err, "diarization_failed")) from err

    result = build_result(
        merge_speakers(segments, turns), duration_sec, diarization_enabled, options.get("model") or WHISPER_MODEL
    )
    if options.get("debug"):
        result["debug"] = {"whisper_segments": segments, "turns": turns}
    return result


def _classify_gpu_error(err: Exception, default_code: str) -> str:
    return "out_of_memory" if "out of memory" in str(err).lower() else default_code


def upload_result(url: str, result: dict) -> int:
    body = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    started = time.monotonic()
    try:
        response = requests.put(url, data=body, headers={"Content-Type": "application/json"}, timeout=HTTP_TIMEOUT_SEC)
    except requests.RequestException as err:
        raise PipelineError("result_upload_failed", type(err).__name__) from None
    if not response.ok:
        raise PipelineError("result_upload_failed", f"status {response.status_code}")
    log_event("result.uploaded", size_bytes=len(body), elapsed_sec=round(time.monotonic() - started, 1))
    return len(body)


def sign_callback(secret: str, timestamp: str, body: str) -> str:
    return hmac.new(secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256).hexdigest()


def send_callback(url: str, secret: str, payload: dict, sleep=time.sleep) -> bool:
    """完了・失敗を Worker に通知する。届かなければ Worker の Cron が失敗として扱う。"""
    body = json.dumps(payload, separators=(",", ":"))
    fields = {"job_id": payload["job_id"], "attempt": payload["attempt"]}
    for try_number in range(1, CALLBACK_MAX_ATTEMPTS + 1):
        # 再送でも古いタイムスタンプとして拒否されないよう、毎回署名し直す
        timestamp = str(int(time.time()))
        headers = {
            "Content-Type": "application/json",
            "X-Callback-Timestamp": timestamp,
            "X-Callback-Signature": sign_callback(secret, timestamp, body),
        }
        try:
            response = requests.post(url, data=body, headers=headers, timeout=CALLBACK_TIMEOUT_SEC)
            if response.ok:
                log_event("callback.sent", try_number=try_number, status=response.status_code, **fields)
                return True
            log_event("callback.rejected", logging.WARNING, try_number=try_number, status=response.status_code, **fields)
            # 認証や形式のエラーは再送しても変わらない
            if 400 <= response.status_code < 500 and response.status_code != 429:
                return False
        except requests.RequestException as err:
            log_event("callback.error", logging.WARNING, try_number=try_number, error_name=type(err).__name__, **fields)
        if try_number < CALLBACK_MAX_ATTEMPTS:
            sleep(2**try_number)
    log_event("callback.gave_up", logging.ERROR, **fields)
    return False
