import { describe, expect, it } from "vitest";
import type { TranscriptResult } from "../types";
import { exportFilename, formatClock, toJson, toMarkdown, toSrt, toText, toVtt } from "./formats";

const result: TranscriptResult = {
  version: 1,
  language: "ja",
  duration_sec: 5400,
  model: { transcription: "large-v3", diarization: "pyannote" },
  speakers: ["SPEAKER_00", "SPEAKER_01"],
  segments: [
    { start: 754.2, end: 756.5, speaker: "SPEAKER_00", text: "それでは始めます。", words: [] },
    { start: 756.5, end: 758, speaker: "SPEAKER_00", text: "よろしく。", words: [] },
    { start: 3661.0005, end: 3662.9996, speaker: "SPEAKER_01", text: "A<B & C", words: [] },
  ],
};
const names = { SPEAKER_00: "田中" };
const noSpeakers: TranscriptResult = {
  ...result,
  speakers: [],
  segments: result.segments.map((s) => ({ ...s, speaker: null })),
};

describe("formatClock", () => {
  it("formats hours beyond a day-long range and truncates fractions", () => {
    expect(formatClock(0)).toBe("00:00:00");
    expect(formatClock(754.9)).toBe("00:12:34");
    expect(formatClock(36000)).toBe("10:00:00");
  });
});

describe("toMarkdown", () => {
  it("adds a heading each time the speaker changes", () => {
    expect(toMarkdown(result, names)).toBe(
      "**田中** [00:12:34]\nそれでは始めます。よろしく。\n\n**SPEAKER_01** [01:01:01]\nA<B & C\n",
    );
  });

  it("omits the speaker name when diarization is off", () => {
    expect(toMarkdown(noSpeakers, {})).toBe("[00:12:34]\nそれでは始めます。よろしく。A<B & C\n");
  });

  it("returns an empty string for no segments", () => {
    expect(toMarkdown({ ...result, segments: [] }, {})).toBe("");
  });
});

describe("toText", () => {
  it("writes one line per segment", () => {
    expect(toText(result, names).split("\n")[0]).toBe("[00:12:34] 田中: それでは始めます。");
  });

  it("omits the speaker when absent", () => {
    expect(toText(noSpeakers, {}).split("\n")[0]).toBe("[00:12:34] それでは始めます。");
  });
});

describe("toSrt", () => {
  it("uses numbered cues and comma-separated milliseconds", () => {
    expect(toSrt(result, names).split("\n\n")[0]).toBe(
      "1\n00:12:34,200 --> 00:12:36,500\n田中: それでは始めます。",
    );
  });

  it("carries rounding into the next second", () => {
    expect(toSrt(result, names)).toContain("01:01:01,001 --> 01:01:03,000");
  });
});

describe("toVtt", () => {
  it("starts with the header and uses dot-separated milliseconds", () => {
    const vtt = toVtt(result, names);
    expect(vtt.startsWith("WEBVTT\n\n00:12:34.200 --> 00:12:36.500\n田中: それでは始めます。\n")).toBe(true);
  });

  it("escapes characters that are special in cue text", () => {
    expect(toVtt(result, names)).toContain("SPEAKER_01: A&lt;B &amp; C");
  });
});

describe("toJson", () => {
  it("adds the renames and leaves segments unchanged", () => {
    const parsed = JSON.parse(toJson(result, names));
    expect(parsed.speaker_names).toEqual(names);
    expect(parsed.segments).toEqual(result.segments);
  });
});

describe("exportFilename", () => {
  it("replaces the extension", () => {
    expect(exportFilename("第1回.講義.mp3", "md")).toBe("第1回.講義.md");
    expect(exportFilename("noext", "srt")).toBe("noext.srt");
  });
});
