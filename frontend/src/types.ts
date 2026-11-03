export type JobStatus = "uploading" | "queued" | "processing" | "completed" | "failed";

export interface JobOptions {
  diarization: boolean;
  min_speakers: number | null;
  max_speakers: number | null;
  terms: string[];
}

export interface Job {
  id: string;
  filename: string;
  size_bytes: number;
  status: JobStatus;
  attempt: number;
  options: JobOptions;
  speaker_names: Record<string, string>;
  error_code: string | null;
  duration_sec: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
}

export interface Word {
  start: number;
  end: number;
  text: string;
}

export interface Segment {
  start: number;
  end: number;
  speaker: string | null;
  text: string;
  words: Word[];
}

export interface TranscriptResult {
  version: number;
  language: string;
  duration_sec: number;
  model: { transcription: string; diarization: string | null };
  speakers: string[];
  segments: Segment[];
}
