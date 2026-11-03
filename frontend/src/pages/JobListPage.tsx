import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listJobs } from "../api";
import { StatusBadge } from "../components";
import { formatClock } from "../lib/formats";
import { formatDateTime, requestErrorMessage } from "../lib/labels";
import { usePolling } from "../lib/usePolling";
import { log } from "../logger";
import type { Job } from "../types";

const POLL_INTERVAL_MS = 10_000;

export function JobListPage() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await listJobs();
      setJobs(next);
      setError(null);
      log.info("jobs.refreshed", { count: next.length });
    } catch (err) {
      setError(requestErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActiveJob = jobs?.some((job) => job.status === "queued" || job.status === "processing") ?? false;
  usePolling(() => void refresh(), POLL_INTERVAL_MS, hasActiveJob);

  return (
    <>
      <div className="page-header">
        <h1>ジョブ一覧</h1>
        <Link className="button primary" to="/new">
          新規作成
        </Link>
      </div>
      {error && <p className="alert">{error}</p>}
      {jobs === null && !error && <p className="muted">読み込み中…</p>}
      {jobs?.length === 0 && <p className="muted">まだジョブはありません。音声をアップロードして始めましょう。</p>}
      {jobs && jobs.length > 0 && (
        <ul className="job-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <Link to={`/jobs/${job.id}`} className="job-row">
                <span className="job-name">{job.filename}</span>
                <span className="job-meta">
                  {formatDateTime(job.created_at)}
                  {job.duration_sec !== null && ` ・ ${formatClock(job.duration_sec)}`}
                </span>
                <StatusBadge status={job.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
