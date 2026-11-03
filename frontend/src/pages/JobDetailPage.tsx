import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getJob, getResult, retryJob, updateSpeakers } from "../api";
import { StatusBadge } from "../components";
import { downloadText } from "../lib/download";
import { EXPORT_FORMATS, type ExportFormat, exportFilename, formatClock, renderExport, speakerLabel } from "../lib/formats";
import { errorLabel, formatBytes, formatDateTime, requestErrorMessage } from "../lib/labels";
import { usePolling } from "../lib/usePolling";
import { log } from "../logger";
import type { Job, TranscriptResult } from "../types";

const POLL_INTERVAL_MS = 5_000;

export function JobDetailPage() {
  const { id = "" } = useParams();
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await getJob(id);
      setJob((previous) => {
        if (previous && previous.status !== next.status) {
          log.info("job.status_changed", { job_id: id, from: previous.status, to: next.status });
        }
        return next;
      });
      setError(null);
    } catch (err) {
      setError(requestErrorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = job?.status === "queued" || job?.status === "processing";
  usePolling(() => void refresh(), POLL_INTERVAL_MS, active);

  const completed = job?.status === "completed";
  useEffect(() => {
    if (!completed) return;
    let cancelled = false;
    getResult(id)
      .then((loaded) => {
        if (cancelled) return;
        setResult(loaded);
        log.info("result.loaded", { job_id: id, segments: loaded.segments.length });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(requestErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [completed, id]);

  const onRetry = async () => {
    setRetrying(true);
    try {
      setJob(await retryJob(id));
      setError(null);
    } catch (err) {
      setError(requestErrorMessage(err));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <h1 className="filename">{job?.filename ?? "読み込み中…"}</h1>
        <Link to="/">一覧に戻る</Link>
      </div>
      {error && <p className="alert">{error}</p>}
      {job && (
        <>
          <p className="job-summary">
            <StatusBadge status={job.status} />
            <span className="muted">
              {formatDateTime(job.created_at)} ・ {formatBytes(job.size_bytes)}
              {job.duration_sec !== null && ` ・ ${formatClock(job.duration_sec)}`}
            </span>
          </p>
          {active && (
            <p className="notice">
              クラウドで処理しています。このページを閉じても、PC の電源を落としても処理は続きます。完了すると Discord に通知します。
              {job.attempt > 1 && ` (${job.attempt}回目の実行)`}
            </p>
          )}
          {job.status === "uploading" && (
            <p className="notice">アップロードが完了していません。中断した場合は新しく作成し直してください。</p>
          )}
          {job.status === "failed" && (
            <div className="alert">
              <p>{errorLabel(job.error_code)}</p>
              <button className="button" disabled={retrying} onClick={() => void onRetry()}>
                {retrying ? "再実行中…" : "再実行"}
              </button>
              <p className="field-hint">音声は失敗から約24時間で削除され、その後は再実行できません。</p>
            </div>
          )}
          {completed && !result && !error && <p className="muted">結果を読み込み中…</p>}
          {completed && result && (
            <TranscriptView job={job} result={result} onJobUpdated={setJob} />
          )}
        </>
      )}
    </>
  );
}

function TranscriptView({
  job,
  result,
  onJobUpdated,
}: {
  job: Job;
  result: TranscriptResult;
  onJobUpdated: (job: Job) => void;
}) {
  const names = job.speaker_names;

  const onDownload = (format: ExportFormat, mime: string) => {
    const filename = exportFilename(job.filename, format);
    downloadText(renderExport(format, result, names), filename, mime);
    log.info("result.downloaded", { job_id: job.id, format });
  };

  return (
    <>
      <section className="section">
        <h2>ダウンロード</h2>
        <div className="button-row">
          {EXPORT_FORMATS.map(({ format, label, mime }) => (
            <button key={format} className="button" onClick={() => onDownload(format, mime)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {result.speakers.length > 0 && <SpeakerEditor job={job} speakers={result.speakers} onJobUpdated={onJobUpdated} />}

      <section className="section">
        <h2>本文</h2>
        {result.segments.length === 0 && <p className="muted">音声から発話を検出できませんでした。</p>}
        <ol className="transcript">
          {result.segments.map((segment, index) => (
            <li key={index} className="segment">
              <time className="segment-time">{formatClock(segment.start)}</time>
              <div>
                {segment.speaker && (
                  <span className="segment-speaker">{speakerLabel(segment.speaker, names)}</span>
                )}
                <p>{segment.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function SpeakerEditor({
  job,
  speakers,
  onJobUpdated,
}: {
  job: Job;
  speakers: string[];
  onJobUpdated: (job: Job) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(job.speaker_names);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      onJobUpdated(await updateSpeakers(job.id, draft));
      setMessage("保存しました");
    } catch (err) {
      setMessage(requestErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="section">
      <h2>話者名</h2>
      <form className="speaker-form" onSubmit={(event) => void onSubmit(event)}>
        {speakers.map((speaker) => (
          <label key={speaker} className="speaker-field">
            <span className="muted">{speaker}</span>
            <input
              type="text"
              maxLength={100}
              placeholder="表示名"
              value={draft[speaker] ?? ""}
              onChange={(event) => setDraft({ ...draft, [speaker]: event.target.value })}
            />
          </label>
        ))}
        <div className="button-row">
          <button className="button" type="submit" disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
          {message && <span className="muted">{message}</span>}
        </div>
      </form>
    </section>
  );
}
