import hashlib
import hmac
import json
import logging
import shutil
import subprocess
from pathlib import Path

import pytest
import requests

import pipeline


def word(start, end, text):
    return {"start": start, "end": end, "text": text}


def segment(words, text=None):
    return {
        "start": words[0]["start"] if words else 0.0,
        "end": words[-1]["end"] if words else 1.0,
        "text": text if text is not None else "".join(w["text"] for w in words),
        "words": words,
    }


class TestMergeSpeakers:
    def test_without_turns_keeps_segments_with_null_speaker(self):
        merged = pipeline.merge_speakers([segment([word(0, 1, "それでは"), word(1, 2, "始めます")])], [])
        assert len(merged) == 1
        assert merged[0]["speaker"] is None
        assert merged[0]["text"] == "それでは始めます"

    def test_splits_where_the_speaker_changes(self):
        turns = [
            {"start": 0, "end": 2, "speaker": "SPEAKER_00"},
            {"start": 2, "end": 4, "speaker": "SPEAKER_01"},
        ]
        merged = pipeline.merge_speakers(
            [segment([word(0, 1, "はい"), word(1, 2, "どうぞ"), word(2, 3, "では"), word(3, 4, "話します")])], turns
        )
        assert [(s["speaker"], s["text"], s["start"], s["end"]) for s in merged] == [
            ("SPEAKER_00", "はいどうぞ", 0, 2),
            ("SPEAKER_01", "では話します", 2, 4),
        ]

    def test_assigns_the_speaker_with_the_longest_overlap(self):
        turns = [
            {"start": 0, "end": 1.2, "speaker": "SPEAKER_00"},
            {"start": 1.2, "end": 3, "speaker": "SPEAKER_01"},
        ]
        merged = pipeline.merge_speakers([segment([word(1, 2, "単語")])], turns)
        assert merged[0]["speaker"] == "SPEAKER_01"

    def test_sums_overlap_across_turns_of_one_speaker(self):
        turns = [
            {"start": 0, "end": 0.3, "speaker": "SPEAKER_00"},
            {"start": 0.3, "end": 0.7, "speaker": "SPEAKER_01"},
            {"start": 0.7, "end": 1, "speaker": "SPEAKER_00"},
        ]
        assert pipeline.merge_speakers([segment([word(0, 1, "a")])], turns)[0]["speaker"] == "SPEAKER_00"

    def test_uses_the_nearest_turn_when_nothing_overlaps(self):
        turns = [
            {"start": 0, "end": 1, "speaker": "SPEAKER_00"},
            {"start": 10, "end": 11, "speaker": "SPEAKER_01"},
        ]
        assert pipeline.merge_speakers([segment([word(8, 9, "a")])], turns)[0]["speaker"] == "SPEAKER_01"

    def test_keeps_a_segment_that_has_no_words(self):
        merged = pipeline.merge_speakers(
            [segment([], text=" 本文 ")], [{"start": 0, "end": 5, "speaker": "SPEAKER_00"}]
        )
        assert merged[0]["text"] == "本文"
        assert merged[0]["speaker"] == "SPEAKER_00"
        assert merged[0]["words"] == []

    def test_drops_blank_words_and_segments(self):
        assert pipeline.merge_speakers([segment([word(0, 1, "  ")], text="  ")], []) == []

    def test_strips_whitespace_inside_words(self):
        merged = pipeline.merge_speakers([segment([word(0, 1, " Hello"), word(1, 2, " world")])], [])
        assert merged[0]["text"] == "Hello world"
        assert [w["text"] for w in merged[0]["words"]] == ["Hello", "world"]


class TestBuildResult:
    def test_diarization_on(self):
        result = pipeline.build_result(
            [
                {"speaker": "SPEAKER_01"},
                {"speaker": "SPEAKER_00"},
                {"speaker": "SPEAKER_01"},
            ],
            90.1234,
            True,
        )
        assert result["version"] == 1
        assert result["language"] == "ja"
        assert result["duration_sec"] == 90.123
        assert result["speakers"] == ["SPEAKER_00", "SPEAKER_01"]
        assert result["model"]["diarization"] == pipeline.DIARIZATION_MODEL

    def test_diarization_off(self):
        result = pipeline.build_result([{"speaker": None}], 1.0, False)
        assert result["speakers"] == []
        assert result["model"]["diarization"] is None


class FakeResponse:
    def __init__(self, status_code=200, chunks=()):
        self.status_code = status_code
        self.chunks = chunks

    @property
    def ok(self):
        return self.status_code < 400

    def iter_content(self, _size):
        return iter(self.chunks)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


SIGNED_URL = "https://r2.example.com/audio/x?X-Amz-Signature=SECRETSIGNATURE"


class TestDownload:
    def test_writes_the_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr(requests, "get", lambda *a, **k: FakeResponse(chunks=[b"ab", b"c"]))
        dest = tmp_path / "a"
        assert pipeline.download_audio(SIGNED_URL, dest) == 3
        assert dest.read_bytes() == b"abc"

    def test_rejects_oversized_audio(self, tmp_path, monkeypatch):
        monkeypatch.setattr(requests, "get", lambda *a, **k: FakeResponse(chunks=[b"abcd"]))
        with pytest.raises(pipeline.PipelineError) as err:
            pipeline.download_audio(SIGNED_URL, tmp_path / "a", max_bytes=3)
        assert err.value.code == "file_too_large"

    def test_network_errors_do_not_expose_the_url(self, tmp_path, monkeypatch):
        def fail(*_a, **_k):
            raise requests.ConnectionError(f"failed to reach {SIGNED_URL}")

        monkeypatch.setattr(requests, "get", fail)
        with pytest.raises(pipeline.PipelineError) as err:
            pipeline.download_audio(SIGNED_URL, tmp_path / "a")
        assert err.value.code == "download_failed"
        assert "SECRETSIGNATURE" not in str(err.value)
        assert err.value.__cause__ is None
        assert err.value.__suppress_context__ is True

    def test_status_error(self, tmp_path, monkeypatch):
        monkeypatch.setattr(requests, "get", lambda *a, **k: FakeResponse(status_code=403))
        with pytest.raises(pipeline.PipelineError) as err:
            pipeline.download_audio(SIGNED_URL, tmp_path / "a")
        assert err.value.code == "download_failed"


class TestUpload:
    def test_sends_utf8_json(self, monkeypatch):
        sent = {}

        def fake_put(url, data, headers, timeout):
            sent.update(data=data, headers=headers)
            return FakeResponse()

        monkeypatch.setattr(requests, "put", fake_put)
        pipeline.upload_result(SIGNED_URL, {"text": "日本語"})
        assert json.loads(sent["data"]) == {"text": "日本語"}
        assert "日本語".encode() in sent["data"]

    def test_failure_is_classified(self, monkeypatch):
        monkeypatch.setattr(requests, "put", lambda *a, **k: FakeResponse(status_code=500))
        with pytest.raises(pipeline.PipelineError) as err:
            pipeline.upload_result(SIGNED_URL, {})
        assert err.value.code == "result_upload_failed"


class TestCallback:
    payload = {"job_id": "j", "attempt": 1, "status": "completed"}

    def test_signature_matches_timestamp_dot_body(self, monkeypatch):
        sent = {}

        def fake_post(url, data, headers, timeout):
            sent.update(data=data, headers=headers)
            return FakeResponse()

        monkeypatch.setattr(requests, "post", fake_post)
        assert pipeline.send_callback("https://w/cb", "secret", self.payload)
        ts = sent["headers"]["X-Callback-Timestamp"]
        expected = hmac.new(b"secret", f"{ts}.{sent['data']}".encode(), hashlib.sha256).hexdigest()
        assert sent["headers"]["X-Callback-Signature"] == expected

    def test_retries_server_errors_with_backoff(self, monkeypatch):
        responses = iter([FakeResponse(500), FakeResponse(503), FakeResponse(200)])
        monkeypatch.setattr(requests, "post", lambda *a, **k: next(responses))
        sleeps = []
        assert pipeline.send_callback("https://w/cb", "s", self.payload, sleep=sleeps.append)
        assert sleeps == [2, 4]

    def test_does_not_retry_client_errors(self, monkeypatch):
        calls = []

        def fake_post(*_a, **_k):
            calls.append(1)
            return FakeResponse(401)

        monkeypatch.setattr(requests, "post", fake_post)
        assert not pipeline.send_callback("https://w/cb", "s", self.payload, sleep=lambda _: None)
        assert len(calls) == 1

    def test_gives_up_after_the_limit(self, monkeypatch):
        def fail(*_a, **_k):
            raise requests.ConnectionError("down")

        calls = []
        monkeypatch.setattr(requests, "post", lambda *a, **k: (calls.append(1), fail())[1])
        assert not pipeline.send_callback("https://w/cb", "s", self.payload, sleep=lambda _: None)
        assert len(calls) == pipeline.CALLBACK_MAX_ATTEMPTS


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg is not installed")
class TestConvert:
    def test_produces_16khz_mono_and_drops_video(self, tmp_path):
        source = tmp_path / "video.mp4"
        subprocess.run(
            [
                "ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1:sample_rate=44100",
                "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1", "-ac", "2", "-shortest", str(source),
            ],
            check=True,
        )
        dest = tmp_path / "out.wav"
        pipeline.convert_to_wav(source, dest)
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(dest)],
            capture_output=True, check=True, text=True,
        )
        streams = json.loads(probe.stdout)["streams"]
        assert len(streams) == 1
        assert streams[0]["codec_type"] == "audio"
        assert streams[0]["sample_rate"] == "16000"
        assert streams[0]["channels"] == 1

    def test_corrupt_input_is_classified(self, tmp_path, caplog):
        source = tmp_path / "bad.mp3"
        source.write_bytes(b"not audio")
        with caplog.at_level(logging.ERROR, logger="whisper"), pytest.raises(pipeline.PipelineError) as err:
            pipeline.convert_to_wav(source, tmp_path / "out.wav")
        assert err.value.code == "audio_decode_failed"
        assert "audio.convert_failed" in caplog.text
