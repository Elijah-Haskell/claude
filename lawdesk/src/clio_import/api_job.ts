// An import straight from the Clio API, one page at a time.
//
// Each page is written in one transaction together with the job's cursor (the URL of the next
// page), so if the server stops halfway, nothing is half-saved and "Resume" carries on from the
// next unread page. Because every record is keyed by its Clio ID in clio_import_map, a page that
// is read twice (or a whole import run again later) updates rather than duplicates.

import { tx, type DB } from "../db.ts";
import type { Engine } from "../engine.ts";
import { ClioApiError, type ClioClient } from "./api.ts";
import { API_RESOURCES, firstPageUrl, type ApiResource } from "./api_map.ts";
import { ClioImporter, summarize, type RunState } from "./importer.ts";
import { addSkip, addWarning, tally, type Report } from "./report.ts";

type Row = Record<string, any>;

export interface JobStatus {
  id: number;
  runId: number;
  status: "running" | "paused" | "done" | "failed";
  /** True while this server process is actually working on it. "running" without active = interrupted. */
  active: boolean;
  step: number;
  current: string | null;
  resources: { name: string; label: string; pages: number; records: number; done: boolean }[];
  waitingUntil: string | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  report: Report | null;
}

export class ApiImport {
  db: DB;
  importer: ClioImporter;
  client: ClioClient;
  resources: ApiResource[];
  private now: () => Date;
  private running = new Map<number, { stop: boolean; promise: Promise<void> }>();

  constructor(db: DB, engine: Engine, client: ClioClient, opts: { now?: () => Date; resources?: ApiResource[] } = {}) {
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.importer = new ClioImporter(db, engine, { now: this.now });
    this.client = client;
    this.resources = opts.resources ?? API_RESOURCES;
  }

  private one(sql: string, ...p: any[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }

  /** Create a job. Only one can be unfinished at a time. */
  create(userId: number | null = null): number {
    const open = this.one("SELECT id FROM clio_import_api_jobs WHERE status IN ('running','paused') ORDER BY id DESC LIMIT 1");
    if (open) throw Object.assign(new Error("An import from Clio is already under way; resume or cancel it first"), { status: 409 });
    if (!this.client.tokens.get()) throw Object.assign(new Error("Connect to Clio first"), { status: 400 });
    const state = this.importer.begin("api", this.resources.map((r) => r.name), { userId });
    const at = this.now().toISOString();
    const progress = Object.fromEntries(this.resources.map((r) => [r.name, { pages: 0, records: 0 }]));
    return Number(
      this.db
        .prepare("INSERT INTO clio_import_api_jobs (run_id, status, step, next_url, progress, started_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(state.runId, "running", 0, null, JSON.stringify(progress), at, at).lastInsertRowid,
    );
  }

  /** Start (or resume) work on a job in the background. Returns at once; poll status(). */
  start(jobId: number) {
    if (this.running.has(jobId)) return;
    this.db.prepare("UPDATE clio_import_api_jobs SET status = 'running', error = NULL, updated_at = ? WHERE id = ? AND status IN ('running','paused','failed')").run(this.now().toISOString(), jobId);
    const ctl = { stop: false, promise: Promise.resolve() };
    ctl.promise = this.work(jobId, ctl).finally(() => this.running.delete(jobId));
    this.running.set(jobId, ctl);
  }

  /** Run a job to the end (or until paused) and wait for it. Used by tests and by start(). */
  async runToEnd(jobId: number) {
    this.start(jobId);
    await this.running.get(jobId)?.promise;
  }

  /** Ask a running job to stop after the page it is on. */
  async pause(jobId: number) {
    const ctl = this.running.get(jobId);
    if (ctl) {
      ctl.stop = true;
      await ctl.promise;
    }
    this.db.prepare("UPDATE clio_import_api_jobs SET status = 'paused', waiting_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'").run(this.now().toISOString(), jobId);
  }

  /** Give up on an unfinished job. What was already imported stays. */
  async cancel(jobId: number) {
    await this.pause(jobId);
    const job = this.one("SELECT * FROM clio_import_api_jobs WHERE id = ?", jobId);
    if (!job) return;
    this.db.prepare("UPDATE clio_import_api_jobs SET status = 'failed', error = 'Cancelled', updated_at = ? WHERE id = ?").run(this.now().toISOString(), jobId);
    this.db.prepare("UPDATE clio_import_runs SET status = 'failed', finished_at = ? WHERE id = ?").run(this.now().toISOString(), job.run_id);
  }

  private async work(jobId: number, ctl: { stop: boolean }) {
    const job0 = this.one("SELECT * FROM clio_import_api_jobs WHERE id = ?", jobId);
    if (!job0) return;
    const state: RunState = this.importer.resumeState(job0.run_id, this.resources.map((r) => r.name));
    const prevWait = this.client.onWait;
    this.client.onWait = (until: number | null) =>
      this.db.prepare("UPDATE clio_import_api_jobs SET waiting_until = ? WHERE id = ?").run(until ? new Date(until).toISOString() : null, jobId);
    try {
      for (;;) {
        if (ctl.stop) return;
        const job = this.one("SELECT * FROM clio_import_api_jobs WHERE id = ?", jobId)!;
        if (job.step >= this.resources.length) break;
        const res = this.resources[job.step];
        const page = await this.client.get(job.next_url ?? firstPageUrl(res));
        if (ctl.stop) return; // the page is read again on resume; nothing was written
        const data: any[] = Array.isArray(page?.data) ? page.data : [];
        const next: string | null = page?.meta?.paging?.next ?? null;
        tx(this.db, () => {
          const items = [];
          for (const o of data) {
            const r = res.map(o);
            state.report.rowsRead++;
            for (const w of r.warnings) addWarning(state.report, { ref: r.rec ? summarize(r.rec) : `${res.label} #${o?.id}`, message: w });
            if (r.rec) items.push({ rec: r.rec });
            else {
              tally(state.report, res.label, "skipped");
              addSkip(state.report, { type: res.label, ref: `${res.label} #${o?.id}`, reason: r.errors.join("; ") });
            }
          }
          this.importer.applyAll(state, items);
          const progress = JSON.parse(job.progress);
          const p = (progress[res.name] ??= { pages: 0, records: 0 });
          p.pages++;
          p.records += data.length;
          this.db
            .prepare("UPDATE clio_import_api_jobs SET step = ?, next_url = ?, progress = ?, waiting_until = NULL, updated_at = ? WHERE id = ?")
            .run(next ? job.step : job.step + 1, next, JSON.stringify(progress), this.now().toISOString(), jobId);
          this.db.prepare("UPDATE clio_import_runs SET report = ? WHERE id = ?").run(JSON.stringify(state.report), state.runId);
        });
      }
      tx(this.db, () => {
        this.importer.finish(state, "done");
        this.db.prepare("UPDATE clio_import_api_jobs SET status = 'done', waiting_until = NULL, updated_at = ? WHERE id = ?").run(this.now().toISOString(), jobId);
      });
    } catch (e: any) {
      // A failed page wrote nothing; the lookups may hold rolled-back ids, so they are rebuilt on resume.
      const msg = e instanceof ClioApiError ? e.message : `Stopped: ${e?.message ?? e}`;
      this.db.prepare("UPDATE clio_import_api_jobs SET status = 'failed', error = ?, waiting_until = NULL, updated_at = ? WHERE id = ?").run(msg, this.now().toISOString(), jobId);
      this.db.prepare("UPDATE clio_import_runs SET status = 'paused' WHERE id = ?").run(state.runId);
      if (!(e instanceof ClioApiError)) console.error("[lawdesk] Clio import stopped:", e);
    } finally {
      this.client.onWait = prevWait;
    }
  }

  status(jobId?: number): JobStatus | null {
    const job = jobId ? this.one("SELECT * FROM clio_import_api_jobs WHERE id = ?", jobId) : this.one("SELECT * FROM clio_import_api_jobs ORDER BY id DESC LIMIT 1");
    if (!job) return null;
    const progress = JSON.parse(job.progress);
    const run = this.one("SELECT report FROM clio_import_runs WHERE id = ?", job.run_id);
    return {
      id: job.id,
      runId: job.run_id,
      status: job.status,
      active: this.running.has(job.id),
      step: job.step,
      current: this.resources[job.step]?.label ?? null,
      resources: this.resources.map((r, i) => ({ name: r.name, label: r.label, pages: progress[r.name]?.pages ?? 0, records: progress[r.name]?.records ?? 0, done: i < job.step })),
      waitingUntil: job.waiting_until,
      error: job.error,
      startedAt: job.started_at,
      updatedAt: job.updated_at,
      report: run?.report ? JSON.parse(run.report) : null,
    };
  }
}
