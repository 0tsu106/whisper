import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        // 静的アセットの生成物に依存しないよう、wrangler.jsonc を読まずに最小構成で起動する
        main: "./src/index.ts",
        miniflare: {
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          r2Buckets: ["BUCKET"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_URL: "https://app.example.com",
            R2_ACCOUNT_ID: "account",
            R2_BUCKET_NAME: "bucket",
            R2_ACCESS_KEY_ID: "key-id",
            R2_SECRET_ACCESS_KEY: "secret-key",
            MODAL_ENDPOINT_URL: "https://modal.example.com/start",
            MODAL_KEY: "modal-key",
            MODAL_SECRET: "modal-secret",
            CALLBACK_SECRET: "callback-secret",
            DISCORD_WEBHOOK_URL: "https://discord.example.com/webhook",
            ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
            ACCESS_AUD: "aud",
            DEV_SKIP_ACCESS: "true",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
