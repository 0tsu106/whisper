import { Hono } from "hono";
import { requireAccess } from "./access";
import { handleScheduled } from "./cron";
import type { Env } from "./env";
import { errorFields, log } from "./logger";
import { api } from "./routes/api";
import { internal } from "./routes/internal";

export const app = new Hono<{ Bindings: Env }>();

// クエリ文字列は記録しない
app.use("*", async (c, next) => {
  const startedAt = Date.now();
  await next();
  log.info("http.request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    elapsed_ms: Date.now() - startedAt,
  });
});

app.use("/api/*", requireAccess);
app.route("/api", api);
app.route("/internal", internal);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  log.error("http.unhandled_error", { method: c.req.method, path: c.req.path, ...errorFields(err) });
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    await handleScheduled(event.cron, env);
  },
} satisfies ExportedHandler<Env>;
