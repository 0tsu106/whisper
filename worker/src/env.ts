export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_URL: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  MODAL_ENDPOINT_URL: string;
  MODAL_KEY: string;
  MODAL_SECRET: string;
  CALLBACK_SECRET: string;
  DISCORD_WEBHOOK_URL?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_SKIP_ACCESS?: string;
}
