import { STATUS_LABELS } from "./lib/labels";
import type { JobStatus } from "./types";

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status]}</span>;
}
