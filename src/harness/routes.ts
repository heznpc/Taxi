import type { Express, Request, Response } from "express";
import express from "express";
import { z } from "zod";
import type { HarnessHost } from "./host.js";
import { auditLog } from "../shared/audit.js";
import { runGovernedActivity } from "../shared/governed-activity.js";

/** Native app route; the caller must already prove this process generation. */
export function installHarnessRoutes(app: Express): () => Promise<void> {
  let host: HarnessHost | undefined;
  let closed = false;
  let loading: Promise<HarnessHost> | undefined;
  const current = async () => {
    if (closed) throw new Error("harness_closed");
    if (host) return host;
    loading ??= import("./host.js")
      .then(({ HarnessHost }) => {
        if (closed) throw new Error("harness_closed");
        return (host = new HarnessHost());
      })
      .catch((error) => {
        loading = undefined;
        throw error;
      });
    return loading;
  };
  const action =
    (fn: (host: HarnessHost, req: Request) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
      try {
        await runGovernedActivity(async () => {
          const runtime = await current();
          const result = await fn(runtime, req);
          if (req.method === "POST")
            auditLog({
              timestamp: new Date().toISOString(),
              tool: "harness_control",
              status: "ok",
              args: { action: req.path },
            });
          res.json(result ?? runtime.snapshot());
        });
      } catch (error) {
        const code =
          error instanceof z.ZodError
            ? "invalid_request"
            : error instanceof Error && /^[a-z_]+$/.test(error.message)
              ? error.message
              : "harness_unavailable";
        if (req.method === "POST")
          auditLog({
            timestamp: new Date().toISOString(),
            tool: "harness_control",
            status: "error",
            args: { action: req.route?.path ?? "unknown" },
            errorCategory: code,
          });
        res.status(code === "task_not_found" ? 404 : 409).json({ error: code });
      }
    };
  app.use("/app/harness/catalog", express.json({ limit: "16mb" }));
  app.use("/app/harness", express.json({ limit: "192kb" }));
  app.use("/app/harness", (error: unknown, _req: Request, res: Response, _next: import("express").NextFunction) => {
    res.status(400).json({ error: error ? "invalid_json_body" : "harness_unavailable" });
  });
  app.get(
    "/app/harness",
    action((host) => host.snapshot()),
  );
  app.post(
    "/app/harness/settings",
    action((host, req) => {
      host.configure(req.body);
    }),
  );
  app.post(
    "/app/harness/usage",
    action(async (host) => {
      await host.collectUsage();
    }),
  );
  app.post(
    "/app/harness/tasks",
    action((host, req) => ({ task: host.store.create(req.body) })),
  );
  app.post(
    "/app/harness/tasks/:id/handoff",
    action((host, req) => ({ task: host.store.fork(String(req.params.id), req.body) })),
  );
  app.post(
    "/app/harness/tasks/:id/run",
    action((host, req) => ({ run: host.run(String(req.params.id), req.body) })),
  );
  app.post(
    "/app/harness/catalog",
    action((host, req) => {
      host.store.importCatalog(req.body);
    }),
  );
  app.post(
    "/app/harness/tasks/:id/links",
    action((host, req) => ({ link: host.store.link(String(req.params.id), req.body) })),
  );
  const close = async () => {
    closed = true;
    if (loading) await loading.catch(() => undefined);
    await host?.close();
  };
  return close;
}
