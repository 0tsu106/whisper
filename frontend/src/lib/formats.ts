import type { Segment, TranscriptResult } from "../types";

export type SpeakerNames = Record<string, string>;
export type ExportFormat = "json" | "md" | "txt" | "srt" | "vtt";

export const EXPORT_FORMATS: { format: ExportFormat; label: string; mime: string }[] = [
  { format: "md", label: "Markdown", mime: "text/markdown;charset=utf-8" },
  { format: "txt", label: "TXT", mime: "text/plain;charset=utf-8" },
  { format: "srt", label: "SRT", mime: "application/x-subrip;charset=utf-8" },
  { format: "vtt", label: "VTT", mime: "text/vtt;charset=utf-8" },
  { format: "json", label: "JSON", mime: "application/json;charset=utf-8" },
];

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

export function formatClock(seconds: number): string {
  const total = Math.floor(seconds);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function formatCueTime(seconds: number, separator: "," | "."): string {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = (totalMs - ms) / 1000;
  return `${formatClock(totalSec)}${separator}${pad(ms, 3)}`;
}

export function speakerLabel(speaker: string | null, names: SpeakerNames): string | null {
  if (speaker === null) return null;
  return names[speaker] || speaker;
}

const singleLine = (text: string) => text.replace(/\s*\n\s*/g, " ");

function withSpeaker(segment: Segment, names: SpeakerNames, text: string): string {
  const label = speakerLabel(segment.speaker, names);
  return label ? `${label}: ${text}` : text;
}

export function toJson(result: TranscriptResult, names: SpeakerNames): string {
  return `${JSON.stringify({ ...result, speaker_names: names }, null, 2)}\n`;
}

export function toMarkdown(result: TranscriptResult, names: SpeakerNames): string {
  const blocks: string[] = [];
  let previous: string | null | undefined;
  let body: string[] = [];
  const flush = () => {
    if (body.length > 0) blocks[blocks.length - 1] += `\n${body.join("")}`;
    body = [];
  };
  for (const segment of result.segments) {
    // 話者分離なしでは見出しが連続しないよう、最初の1回だけ時刻を出す
    if (segment.speaker !== previous) {
      flush();
      const label = speakerLabel(segment.speaker, names);
      const clock = `[${formatClock(segment.start)}]`;
      blocks.push(label ? `**${label}** ${clock}` : clock);
      previous = segment.speaker;
    }
    body.push(singleLine(segment.text));
  }
  flush();
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
}

export function toText(result: TranscriptResult, names: SpeakerNames): string {
  return result.segments
    .map((segment) => `[${formatClock(segment.start)}] ${withSpeaker(segment, names, singleLine(segment.text))}\n`)
    .join("");
}

export function toSrt(result: TranscriptResult, names: SpeakerNames): string {
  return result.segments
    .map((segment, index) => {
      const range = `${formatCueTime(segment.start, ",")} --> ${formatCueTime(segment.end, ",")}`;
      return `${index + 1}\n${range}\n${withSpeaker(segment, names, singleLine(segment.text))}\n`;
    })
    .join("\n");
}

const escapeVtt = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function toVtt(result: TranscriptResult, names: SpeakerNames): string {
  const cues = result.segments.map((segment) => {
    const range = `${formatCueTime(segment.start, ".")} --> ${formatCueTime(segment.end, ".")}`;
    return `${range}\n${escapeVtt(withSpeaker(segment, names, singleLine(segment.text)))}\n`;
  });
  return ["WEBVTT\n", ...cues].join("\n");
}

export function renderExport(format: ExportFormat, result: TranscriptResult, names: SpeakerNames): string {
  switch (format) {
    case "json":
      return toJson(result, names);
    case "md":
      return toMarkdown(result, names);
    case "txt":
      return toText(result, names);
    case "srt":
      return toSrt(result, names);
    case "vtt":
      return toVtt(result, names);
  }
}

export function exportFilename(sourceFilename: string, format: ExportFormat): string {
  const dot = sourceFilename.lastIndexOf(".");
  const base = dot > 0 ? sourceFilename.slice(0, dot) : sourceFilename;
  return `${base}.${format}`;
}
