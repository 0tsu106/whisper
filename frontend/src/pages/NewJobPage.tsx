import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { completeUpload, createJob, uploadFile } from "../api";
import { formatBytes, requestErrorMessage } from "../lib/labels";
import { log } from "../logger";

const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
const ACCEPTED_EXTENSIONS = ["mp3", "m4a", "wav", "mp4", "webm", "ogg"];

function validateFile(file: File): string | null {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ACCEPTED_EXTENSIONS.includes(extension)) {
    return `対応していない形式です(対応形式: ${ACCEPTED_EXTENSIONS.join(", ")})`;
  }
  if (file.size === 0) return "ファイルが空です";
  if (file.size > MAX_UPLOAD_BYTES) {
    return `ファイルサイズが上限(300MB)を超えています(${formatBytes(file.size)})`;
  }
  return null;
}

const parseCount = (value: string) => (value === "" ? null : Number(value));

export function NewJobPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [diarization, setDiarization] = useState(true);
  const [minSpeakers, setMinSpeakers] = useState("");
  const [maxSpeakers, setMaxSpeakers] = useState("");
  const [terms, setTerms] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploading = progress !== null;

  useEffect(() => {
    if (!uploading) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  const onFileChange = (selected: File | null) => {
    setFile(selected);
    setError(selected ? validateFile(selected) : null);
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) return;
    const min = parseCount(minSpeakers);
    const max = parseCount(maxSpeakers);
    if (diarization && min !== null && max !== null && min > max) {
      setError("話者数の最小は最大以下にしてください");
      return;
    }
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setProgress(0);
    const startedAt = performance.now();
    try {
      const { job, upload_url: uploadUrl } = await createJob(file.name, file.size, {
        diarization,
        min_speakers: diarization ? min : null,
        max_speakers: diarization ? max : null,
        terms: terms
          .split("\n")
          .map((term) => term.trim())
          .filter(Boolean),
      });
      log.info("upload.started", { job_id: job.id, size_bytes: file.size });
      await uploadFile(uploadUrl, file, setProgress);
      log.info("upload.finished", { job_id: job.id, elapsed_ms: Math.round(performance.now() - startedAt) });
      await completeUpload(job.id);
      navigate(`/jobs/${job.id}`);
    } catch (err) {
      log.error("upload.failed", { error: String(err) });
      setError(requestErrorMessage(err));
      setProgress(null);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>新規作成</h1>
        <Link to="/">一覧に戻る</Link>
      </div>
      <form className="form" onSubmit={(event) => void onSubmit(event)}>
        <label className="field">
          <span className="field-label">音声ファイル</span>
          <input
            type="file"
            accept={ACCEPTED_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
            disabled={uploading}
            onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
          />
          <span className="field-hint">
            {file ? formatBytes(file.size) : `${ACCEPTED_EXTENSIONS.join(", ")} / 300MB まで`}
          </span>
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={diarization}
            disabled={uploading}
            onChange={(event) => setDiarization(event.target.checked)}
          />
          話者分離(単独話者の講義ならオフにすると節約できます)
        </label>

        {diarization && (
          <div className="field-row">
            <label className="field">
              <span className="field-label">最小話者数</span>
              <input
                type="number"
                min={1}
                max={32}
                placeholder="指定なし"
                value={minSpeakers}
                disabled={uploading}
                onChange={(event) => setMinSpeakers(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">最大話者数</span>
              <input
                type="number"
                min={1}
                max={32}
                placeholder="指定なし"
                value={maxSpeakers}
                disabled={uploading}
                onChange={(event) => setMaxSpeakers(event.target.value)}
              />
            </label>
          </div>
        )}

        <label className="field">
          <span className="field-label">用語リスト(任意、1行に1語)</span>
          <textarea
            rows={4}
            placeholder={"専門用語\n固有名詞"}
            value={terms}
            disabled={uploading}
            onChange={(event) => setTerms(event.target.value)}
          />
        </label>

        {error && <p className="alert">{error}</p>}

        {uploading ? (
          <div className="upload-progress">
            <progress value={progress} max={1} />
            <span>
              アップロード中 {Math.round(progress * 100)}% ・ 完了まではこのタブを閉じないでください
            </span>
          </div>
        ) : (
          <button className="button primary" type="submit" disabled={!file || validateFile(file) !== null}>
            アップロードして開始
          </button>
        )}
      </form>
    </>
  );
}
