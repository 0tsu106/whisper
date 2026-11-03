import { z } from "zod";

export const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ["mp3", "m4a", "wav", "mp4", "webm", "ogg"];

const speakerCount = z.number().int().min(1).max(32).nullable().default(null);

export const jobOptionsSchema = z
  .object({
    diarization: z.boolean().default(true),
    min_speakers: speakerCount,
    max_speakers: speakerCount,
    terms: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
  })
  .refine((o) => o.min_speakers === null || o.max_speakers === null || o.min_speakers <= o.max_speakers, {
    message: "min_speakers must not exceed max_speakers",
  });

export type JobOptions = z.infer<typeof jobOptionsSchema>;

export const createJobSchema = z.object({
  filename: z
    .string()
    .transform((name) => name.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .pipe(z.string().min(1).max(255))
    .refine((name) => ALLOWED_EXTENSIONS.includes(name.split(".").pop()?.toLowerCase() ?? ""), {
      message: "unsupported file type",
    }),
  size_bytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  options: jobOptionsSchema.prefault({}),
});

export const speakerNamesSchema = z.object({
  speaker_names: z.record(z.string().regex(/^SPEAKER_\d+$/), z.string().trim().max(100)),
});

export const callbackSchema = z.object({
  job_id: z.string().min(1),
  attempt: z.number().int().positive(),
  status: z.enum(["completed", "failed"]),
  error_code: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .nullish(),
  duration_sec: z.number().nonnegative().nullish(),
});
