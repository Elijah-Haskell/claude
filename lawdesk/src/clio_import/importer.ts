// The importer: writes import records (from a CSV file or the Clio API) into Lawdesk.
//
//   - Every record is looked up in clio_import_map first, so importing the same data again
//     updates what is there instead of adding a second copy. A record not in the map is also
//     matched against what the firm already typed into Lawdesk (same contact name, same matter
//     number) before anything new is added.
//   - Rows are written in batches, one transaction per batch. Each row has its own savepoint,
//     so one bad row is skipped (and reported) without losing the rest of the batch.
//   - A trial run does all of the same work inside a transaction and then rolls it back, so its
//     report is exactly what a real run would do.
//   - Imported matters don't run automatic steps (they would add new-matter checklists to old files).
//   - Trust balances are only listed in the report (see report.ts TRUST_NOTE).

import { createHash } from "node:crypto";
import { type DB, tx } from "../db.ts";
import type { Engine } from "../engine.ts";
import { Billing } from "../billing/billing.ts";
import { Calendar } from "../calendar/calendar.ts";
import { parseCsv } from "./csv.ts";
import { KIND_DEFS, checkMapping, guessMapping, missingRequired, type Kind } from "./fields.ts";
import { dedupeKeys, normalizeRow, type NormalizeOpts } from "./normalize.ts";
import type { ActivityRec, ContactRec, EventRec, MatterRec, Rec, Ref, RowResult, TaskRec, TrustRec, UserRec } from "./records.ts";
import { TRUST_NOTE, addSkip, addWarning, newReport, tally, type Outcome, type Report } from "./report.ts";
import { nameKey } from "./values.ts";

type Row = Record<string, any>;

export class Skip extends Error {}

export interface ImportOpts extends NormalizeOpts {
  /** Add a person to Lawdesk when Clio names a timekeeper/attorney that isn't here yet (default true). */
  createMissingPeople?: boolean;
  batchSize?: number;
}

const TYPE_LABEL: Record<Rec["type"], string> = {
  user: "People",
  contact: "Contacts",
  matter: "Matters",
  task: "Tasks",
  event: "Calendar",
  activity: "Time and expenses",
  trust: "Trust balances",
};
export const typeLabel = (t: Rec["type"]) => TYPE_LABEL[t];

const COMPANY_RE = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|company|co|ltd|llp|lp|pa|p\.a|pllc|trust|bank|association|group|partners|holdings|church|foundation|city|county|state)\b\.?/i;

/** Lookup tables built once per run, with an undo log so a rolled-back row leaves no trace. */
class Lookups {
  private undo: (() => void)[] = [];
  users: Map<string, number>;
  contacts: Map<string, number[]>;
  areas: Map<string, number>;
  constructor(users: Map<string, number>, contacts: Map<string, number[]>, areas: Map<string, number>) {
    this.users = users;
    this.contacts = contacts;
    this.areas = areas;
  }
  addContact(key: string, id: number) {
    const list = this.contacts.get(key) ?? [];
    list.push(id);
    this.contacts.set(key, list);
    this.undo.push(() => list.splice(list.indexOf(id), 1));
  }
  addUser(key: string, id: number) {
    const had = this.users.get(key);
    this.users.set(key, id);
    this.undo.push(() => (had == null ? this.users.delete(key) : this.users.set(key, had)));
  }
  addArea(key: string, id: number) {
    this.areas.set(key, id);
    this.undo.push(() => this.areas.delete(key));
  }
  mark() {
    return this.undo.length;
  }
  rollback(to: number) {
    while (this.undo.length > to) this.undo.pop()!();
  }
}

export interface RunState {
  report: Report;
  runId: number | null;
  userId: number | null;
  lookups: Lookups;
  /** Report additions made by the current row (undone with it). */
  pendingAdds: { people: string[]; clients: string[]; practiceAreas: string[] };
}

export interface Preview {
  kind: Kind;
  headers: string[];
  mapping: Record<string, number>;
  guessed: Record<string, number>;
  fields: { key: string; label: string; required: boolean | string; help?: string }[];
  missing: string[];
  /** The first data row's cells, to show beside the mapping. */
  sample: string[];
  fileWarnings: string[];
  counts: { rows: number; ready: number; problems: number; new: number; update: number; warnings: number };
  rows: { line: number; status: "new" | "update" | "problem"; summary: string; errors: string[]; warnings: string[] }[];
}

export class ClioImporter {
  db: DB;
  engine: Engine;
  billing: Billing;
  calendar: Calendar;
  private now: () => Date;

  constructor(db: DB, engine: Engine, opts: { now?: () => Date } = {}) {
    this.db = db;
    this.engine = engine;
    this.now = opts.now ?? (() => new Date());
    this.billing = new Billing(db, { today: () => engine.today(), now: this.now });
    this.calendar = new Calendar(db, { now: this.now });
  }

  private one(sql: string, ...p: any[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  private all(sql: string, ...p: any[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private run(sql: string, ...p: any[]): number {
    return Number(this.db.prepare(sql).run(...p).lastInsertRowid);
  }

  // ------------------------------------------------------------------ CSV

  /** Read a file and check every row, without writing anything. */
  preview(kind: Kind, csvText: string, mapping?: unknown, opts: ImportOpts = {}, sampleSize = 50): Preview {
    const table = parseCsv(csvText);
    const guessed = guessMapping(kind, table.headers);
    const map = mapping && Object.keys(mapping as object).length ? checkMapping(kind, table.headers, mapping) : guessed;
    const results = this.readRows(kind, table, map, opts);
    const counts = { rows: results.length, ready: 0, problems: 0, new: 0, update: 0, warnings: 0 };
    const rows: Preview["rows"] = [];
    for (const r of results) {
      let status: "new" | "update" | "problem";
      if (!r.rec) {
        status = "problem";
        counts.problems++;
      } else {
        counts.ready++;
        status = this.isKnown(r.rec) ? "update" : "new";
        counts[status]++;
      }
      if (r.warnings.length) counts.warnings++;
      // Show the first rows, plus every row with a problem (up to a limit).
      if (rows.length < sampleSize || (status === "problem" && rows.length < sampleSize + 500)) {
        rows.push({ line: r.line, status, summary: r.rec ? summarize(r.rec) : "", errors: r.errors, warnings: r.warnings });
      }
    }
    return {
      kind,
      headers: table.headers,
      mapping: map,
      guessed,
      fields: KIND_DEFS[kind].fields.map((f) => ({ key: f.key, label: f.label, required: f.required ?? false, help: f.help })),
      missing: missingRequired(kind, map),
      sample: (table.rows[0]?.cells ?? []).map((c) => c.slice(0, 200)),
      fileWarnings: table.warnings,
      counts,
      rows,
    };
  }

  private readRows(kind: Kind, table: ReturnType<typeof parseCsv>, map: Record<string, number>, opts: ImportOpts): RowResult[] {
    const results = table.rows.map((r) => normalizeRow(kind, r.cells, map, r.line, opts));
    dedupeKeys(results);
    return results;
  }

  private isKnown(rec: Rec): boolean {
    const kind = rec.type === "trust" ? null : rec.type;
    return kind ? !!this.one("SELECT 1 FROM clio_import_map WHERE kind = ? AND clio_key = ?", kind, rec.key) : false;
  }

  /** Import a CSV file. With dryRun, everything is rolled back and only the report is kept. */
  importCsv(
    kind: Kind,
    csvText: string,
    o: ImportOpts & { mapping?: unknown; dryRun?: boolean; fileName?: string | null; userId?: number | null } = {},
  ): Report {
    const table = parseCsv(csvText);
    const map = o.mapping && Object.keys(o.mapping as object).length ? checkMapping(kind, table.headers, o.mapping) : guessMapping(kind, table.headers);
    const missing = missingRequired(kind, map);
    if (missing.length) throw Object.assign(new Error(`Choose a column for: ${missing.join("; ")}`), { status: 400 });
    const results = this.readRows(kind, table, map, o);
    const state = this.begin("csv", [kind], { fileName: o.fileName, dryRun: o.dryRun, userId: o.userId });
    for (const w of table.warnings) addWarning(state.report, { message: w });
    state.report.rowsRead = results.length;
    const label = TYPE_LABEL[recTypeFor(kind)];
    const items: { line: number; rec: Rec }[] = [];
    for (const r of results) {
      for (const w of r.warnings) addWarning(state.report, { line: r.line, ref: r.rec ? summarize(r.rec) : undefined, message: w });
      if (r.rec) items.push({ line: r.line, rec: r.rec });
      else {
        tally(state.report, label, "skipped");
        addSkip(state.report, { line: r.line, type: label, ref: `Row ${r.line}`, reason: r.errors.join("; ") });
      }
    }
    const size = Math.max(1, o.batchSize ?? 250);
    if (o.dryRun) {
      this.db.exec("BEGIN");
      try {
        for (let i = 0; i < items.length; i += size) this.applyAll(state, items.slice(i, i + size), o);
      } finally {
        this.db.exec("ROLLBACK");
      }
    } else {
      for (let i = 0; i < items.length; i += size) tx(this.db, () => this.applyAll(state, items.slice(i, i + size), o));
    }
    return this.finish(state, "done");
  }

  // ------------------------------------------------------------- run state

  begin(source: "csv" | "api", kinds: string[], o: { fileName?: string | null; dryRun?: boolean; userId?: number | null } = {}): RunState {
    const startedAt = this.now().toISOString();
    const report = newReport(source, kinds, { fileName: o.fileName, dryRun: o.dryRun, startedAt });
    const runId = this.run(
      "INSERT INTO clio_import_runs (source, kind, file_name, dry_run, status, started_at, user_id) VALUES (?,?,?,?,?,?,?)",
      source,
      kinds.join(","),
      o.fileName ?? null,
      o.dryRun ? 1 : 0,
      "running",
      startedAt,
      o.userId ?? null,
    );
    report.runId = runId;
    return { report, runId, userId: o.userId ?? null, lookups: this.buildLookups(), pendingAdds: { people: [], clients: [], practiceAreas: [] } };
  }

  /** Carry on with a run started earlier (an API import resumed after a pause or a restart). */
  resumeState(runId: number, kinds: string[]): RunState {
    const run = this.one("SELECT * FROM clio_import_runs WHERE id = ?", runId);
    if (!run) throw new Error(`Import run ${runId} not found`);
    const report: Report = run.report ? JSON.parse(run.report) : { ...newReport(run.source, kinds, { startedAt: run.started_at }), runId };
    return { report, runId, userId: run.user_id ?? null, lookups: this.buildLookups(), pendingAdds: { people: [], clients: [], practiceAreas: [] } };
  }

  private buildLookups(): Lookups {
    const users = new Map<string, number>();
    for (const u of this.all("SELECT id, name, email FROM users ORDER BY active DESC, id")) {
      if (!users.has(nameKey(u.name))) users.set(nameKey(u.name), u.id);
      if (u.email && !users.has(u.email.toLowerCase())) users.set(u.email.toLowerCase(), u.id);
    }
    const contacts = new Map<string, number[]>();
    for (const c of this.all("SELECT id, name FROM contacts ORDER BY id")) {
      const k = nameKey(c.name);
      contacts.set(k, [...(contacts.get(k) ?? []), c.id]);
    }
    const areas = new Map<string, number>();
    for (const a of this.all("SELECT id, name FROM practice_areas")) areas.set(nameKey(a.name), a.id);
    return new Lookups(users, contacts, areas);
  }

  finish(state: RunState, status: "done" | "failed" | "paused"): Report {
    const r = state.report;
    r.finishedAt = this.now().toISOString();
    if (!r.dryRun && status === "done") {
      const parts = Object.entries(r.byType).map(([k, t]) => `${k}: ${t.created} added, ${t.updated} updated, ${t.skipped} skipped`);
      this.engine.log("clio_import", `Imported from Clio${r.fileName ? ` (${r.fileName})` : ""}. ${parts.join("; ")}`.slice(0, 2000), { userId: state.userId });
    }
    this.run("UPDATE clio_import_runs SET status = ?, finished_at = ?, report = ? WHERE id = ?", status, r.finishedAt, JSON.stringify(r), state.runId);
    return r;
  }

  // ---------------------------------------------------------------- apply

  /** Apply records, each in its own savepoint. The caller owns the surrounding transaction. */
  applyAll(state: RunState, items: { line?: number; rec: Rec }[], o: ImportOpts = {}) {
    for (const { line, rec } of items) {
      const label = TYPE_LABEL[rec.type];
      const mark = state.lookups.mark();
      state.pendingAdds = { people: [], clients: [], practiceAreas: [] };
      const warnings: string[] = [];
      this.db.exec("SAVEPOINT clio_row");
      try {
        const outcome = this.apply(state, rec, warnings, o);
        this.db.exec("RELEASE clio_row");
        tally(state.report, label, outcome);
        for (const k of ["people", "clients", "practiceAreas"] as const)
          for (const n of state.pendingAdds[k]) if (!state.report.added[k].includes(n)) state.report.added[k].push(n);
        for (const w of warnings) addWarning(state.report, { line, ref: summarize(rec), message: w });
      } catch (e: any) {
        this.db.exec("ROLLBACK TO clio_row");
        this.db.exec("RELEASE clio_row");
        state.lookups.rollback(mark);
        tally(state.report, label, "skipped");
        addSkip(state.report, { line, type: label, ref: summarize(rec), reason: e instanceof Skip ? e.message : friendly(e) });
      }
    }
  }

  private apply(state: RunState, rec: Rec, w: string[], o: ImportOpts): Outcome {
    switch (rec.type) {
      case "user":
        return this.applyUser(state, rec);
      case "contact":
        return this.applyContact(state, rec, w);
      case "matter":
        return this.applyMatter(state, rec, w, o);
      case "task":
        return this.applyTask(state, rec, w, o);
      case "event":
        return this.applyEvent(state, rec, w);
      case "activity":
        return this.applyActivity(state, rec, w, o);
      case "trust":
        return this.applyTrust(state, rec, w);
    }
  }

  // --------------------------------------------------------------- the map

  private mapped(kind: string, key: string): Row | undefined {
    const m = this.one("SELECT * FROM clio_import_map WHERE kind = ? AND clio_key = ?", kind, key);
    if (!m) return undefined;
    // The Lawdesk record may have been deleted since; then it is imported again.
    const exists = this.one(`SELECT 1 FROM ${m.target} WHERE id = ?`, m.lawdesk_id);
    return exists ? m : undefined;
  }

  private remember(state: RunState, kind: string, key: string, target: string, id: number, h: string | null, clioTotal: number | null = null) {
    this.run(
      `INSERT INTO clio_import_map (kind, clio_key, lawdesk_id, target, record_hash, clio_total_cents, first_run_id, last_run_id, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (kind, clio_key) DO UPDATE SET lawdesk_id = excluded.lawdesk_id, target = excluded.target,
         record_hash = excluded.record_hash, clio_total_cents = excluded.clio_total_cents, last_run_id = excluded.last_run_id,
         updated_at = excluded.updated_at`,
      kind,
      key,
      id,
      target,
      h,
      clioTotal,
      state.runId,
      state.runId,
      this.now().toISOString(),
    );
  }

  // ------------------------------------------------------------ resolving

  private findUser(state: RunState, ref: Ref | null, o: ImportOpts, w: string[], what: string): number | null {
    if (!ref) return null;
    if (ref.clioId) {
      const m = this.mapped("user", `id:${ref.clioId}`);
      if (m) return m.lawdesk_id;
    }
    const name = ref.name?.trim();
    if (!name) return null;
    const hit = state.lookups.users.get(name.includes("@") ? name.toLowerCase() : nameKey(name));
    if (hit) return hit;
    if (o.createMissingPeople === false) throw new Skip(`${what} "${name}" is not a person in Lawdesk (add them under Settings > People)`);
    const id = this.engine.addUser(name, null, name.includes("@") ? name : null);
    state.lookups.addUser(nameKey(name), id);
    if (ref.clioId) this.remember(state, "user", `id:${ref.clioId}`, "users", id, null);
    state.pendingAdds.people.push(name);
    w.push(`${what} "${name}" was not in Lawdesk, so they were added under Settings > People`);
    return id;
  }

  private findContact(ref: Ref, state: RunState): number | null {
    if (ref.clioId) {
      const m = this.mapped("contact", `id:${ref.clioId}`);
      if (m) return m.lawdesk_id;
    }
    if (!ref.name) return null;
    const ids = state.lookups.contacts.get(nameKey(ref.name)) ?? [];
    return ids.length ? ids[0] : null;
  }

  findMatter(ref: Ref | null): number | null {
    if (!ref) return null;
    if (ref.clioId) {
      const m = this.mapped("matter", `id:${ref.clioId}`);
      if (m) return m.lawdesk_id;
    }
    const name = ref.name?.trim();
    if (!name) return null;
    const byNumber = this.one("SELECT id FROM matters WHERE lower(number) = lower(?)", name);
    if (byNumber) return byNumber.id;
    // Clio shows matters as "<number> - <description>"; try the part before " - " as the number.
    const dash = /^(.+?)\s+-\s+(.+)$/.exec(name);
    if (dash) {
      const n = this.one("SELECT id FROM matters WHERE lower(number) = lower(?)", dash[1]);
      if (n) return n.id;
    }
    const byName = this.all("SELECT id, name FROM matters").filter((m) => nameKey(m.name) === nameKey(name));
    return byName.length === 1 ? byName[0].id : null;
  }

  private needMatter(ref: Ref | null, required: boolean): number | null {
    if (!ref) {
      if (required) throw new Skip("No matter given");
      return null;
    }
    const id = this.findMatter(ref);
    if (id == null) throw new Skip(`Matter "${ref.name ?? `Clio #${ref.clioId}`}" is not in Lawdesk (import matters first)`);
    return id;
  }

  private practiceArea(state: RunState, name: string | null): number | null {
    if (!name) return null;
    const k = nameKey(name);
    const hit = state.lookups.areas.get(k);
    if (hit) return hit;
    const { id } = this.engine.addPracticeArea(name.trim());
    state.lookups.addArea(k, id);
    state.pendingAdds.practiceAreas.push(name.trim());
    return id;
  }

  // ---------------------------------------------------------------- users

  private applyUser(state: RunState, rec: UserRec): Outcome {
    const h = fingerprint(rec);
    const m = this.mapped("user", rec.key);
    if (m && m.record_hash === h) return "unchanged";
    let id: number | undefined = m?.lawdesk_id;
    let outcome: Outcome = "updated";
    if (id == null) {
      id = (rec.email && state.lookups.users.get(rec.email.toLowerCase())) || state.lookups.users.get(nameKey(rec.name));
      if (id == null) {
        id = this.engine.addUser(rec.name, rec.role, rec.email);
        if (!rec.active) this.run("UPDATE users SET active = 0 WHERE id = ?", id);
        state.lookups.addUser(nameKey(rec.name), id);
        if (rec.email) state.lookups.addUser(rec.email.toLowerCase(), id);
        outcome = "created";
      }
    }
    if (outcome === "updated") {
      // Fill gaps only: the firm's own edits to people win.
      this.run("UPDATE users SET email = COALESCE(email, ?), default_role = COALESCE(default_role, ?) WHERE id = ?", rec.email, rec.role, id);
    }
    this.remember(state, "user", rec.key, "users", id, h);
    return outcome;
  }

  // ------------------------------------------------------------- contacts

  private applyContact(state: RunState, rec: ContactRec, w: string[]): Outcome {
    const h = fingerprint(rec);
    const m = this.mapped("contact", rec.key);
    if (m && m.record_hash === h) return "unchanged";
    let id: number | null = m?.lawdesk_id ?? null;
    let matched = false;
    if (id == null) {
      const same = (state.lookups.contacts.get(nameKey(rec.name)) ?? []).filter((cid) => !this.one("SELECT 1 FROM clio_import_map WHERE kind = 'contact' AND target = 'contacts' AND lawdesk_id = ? AND clio_key <> ?", cid, rec.key));
      if (same.length === 1) {
        id = same[0];
        matched = true;
        w.push("Matched a contact already in Lawdesk with the same name");
      } else if (same.length > 1) w.push("More than one contact in Lawdesk has this name; added a new one");
    }
    if (id == null) {
      id = this.engine.addContact(rec.name, rec.kind, rec.email, rec.phone);
      this.run("UPDATE contacts SET notes = ? WHERE id = ?", mergeNotes(null, rec), id);
      state.lookups.addContact(nameKey(rec.name), id);
      this.remember(state, "contact", rec.key, "contacts", id, h);
      return "created";
    }
    const cur = this.one("SELECT * FROM contacts WHERE id = ?", id)!;
    this.run(
      "UPDATE contacts SET name = ?, kind = ?, email = COALESCE(?, email), phone = COALESCE(?, phone), notes = ? WHERE id = ?",
      rec.name,
      rec.kind,
      rec.email,
      rec.phone,
      mergeNotes(cur.notes, rec),
      id,
    );
    if (nameKey(cur.name) !== nameKey(rec.name)) state.lookups.addContact(nameKey(rec.name), id);
    this.remember(state, "contact", rec.key, "contacts", id, h);
    return matched || m ? "updated" : "created";
  }

  // -------------------------------------------------------------- matters

  private applyMatter(state: RunState, rec: MatterRec, w: string[], o: ImportOpts): Outcome {
    const h = fingerprint(rec);
    const m = this.mapped("matter", rec.key);
    if (m && m.record_hash === h) return "unchanged";

    let clientId: number | null = null;
    if (rec.client) {
      clientId = this.findContact(rec.client, state);
      if (clientId == null) {
        if (!rec.client.name) throw new Skip(`Client (Clio #${rec.client.clioId}) is not in Lawdesk (import contacts first)`);
        const kind = rec.client.kind ?? (COMPANY_RE.test(rec.client.name) ? "company" : "person");
        clientId = this.engine.addContact(rec.client.name, kind);
        state.lookups.addContact(nameKey(rec.client.name), clientId);
        state.pendingAdds.clients.push(rec.client.name);
        w.push(`Client "${rec.client.name}" was not among the contacts, so a contact was added`);
      }
    }
    const areaId = this.practiceArea(state, rec.practiceArea);
    const attorney = this.findUser(state, rec.responsible, o, w, "Responsible attorney");
    const originating = this.findUser(state, rec.originating, o, w, "Originating attorney");
    const description = rec.extra.length ? rec.extra.join("\n") : null;

    let id: number | null = m?.lawdesk_id ?? null;
    let matched = false;
    if (id == null && rec.number) {
      const same = this.one("SELECT id FROM matters WHERE lower(number) = lower(?)", rec.number);
      if (same) {
        const other = this.one("SELECT clio_key FROM clio_import_map WHERE kind = 'matter' AND target = 'matters' AND lawdesk_id = ?", same.id);
        if (other && other.clio_key !== rec.key) throw new Skip(`Matter number ${rec.number} is already used by another imported matter`);
        id = same.id;
        matched = true;
        w.push("Matched a matter already in Lawdesk with the same number");
      }
    }
    if (rec.number && id != null) {
      const clash = this.one("SELECT id FROM matters WHERE lower(number) = lower(?) AND id <> ?", rec.number, id);
      if (clash) throw new Skip(`Matter number ${rec.number} is already used by another Lawdesk matter`);
    }
    const today = this.engine.today();
    const opened = rec.openedOn ?? rec.closedOn ?? today;
    const firstStage = (pa: number | null) => (pa == null ? null : this.one("SELECT id FROM stages WHERE practice_area_id = ? ORDER BY position LIMIT 1", pa)?.id ?? null);

    if (id == null) {
      id = this.engine.createMatter(
        { name: rec.name, number: rec.number, clientId, openedOn: opened, description, roles: {} },
        state.userId,
      );
      // Set the practice area without entering the first stage through the engine, so no automatic steps run.
      this.run("UPDATE matters SET practice_area_id = ?, stage_id = ? WHERE id = ?", areaId, firstStage(areaId), id);
    } else {
      const cur = this.one("SELECT * FROM matters WHERE id = ?", id)!;
      this.run(
        "UPDATE matters SET number = COALESCE(?, number), name = ?, client_id = COALESCE(?, client_id), opened_on = ?, description = ? WHERE id = ?",
        rec.number,
        rec.name,
        clientId,
        rec.openedOn ?? cur.opened_on,
        mergeText(cur.description, description),
        id,
      );
      if (areaId != null && areaId !== cur.practice_area_id) this.run("UPDATE matters SET practice_area_id = ?, stage_id = ? WHERE id = ?", areaId, firstStage(areaId), id);
      this.engine.log("matter_updated", "Updated from the Clio import", { userId: state.userId, matterId: id });
    }
    if (rec.status === "closed") {
      const cur = this.one("SELECT status FROM matters WHERE id = ?", id)!;
      if (cur.status !== "closed") {
        this.run("UPDATE matters SET status = 'closed', closed_on = ? WHERE id = ?", rec.closedOn ?? opened, id);
        this.engine.log("matter_closed", "Closed (closed in Clio)", { userId: state.userId, matterId: id });
      } else if (rec.closedOn) this.run("UPDATE matters SET closed_on = ? WHERE id = ?", rec.closedOn, id);
    } else if (m || matched) {
      const cur = this.one("SELECT status FROM matters WHERE id = ?", id)!;
      if (cur.status === "closed") {
        this.run("UPDATE matters SET status = 'open', closed_on = NULL WHERE id = ?", id);
        this.engine.log("matter_reopened", "Reopened (open in Clio)", { userId: state.userId, matterId: id });
      }
    }
    for (const [role, uid] of [["attorney", attorney], ["originating attorney", originating]] as const) {
      if (uid == null) continue;
      const cur = this.one("SELECT user_id FROM matter_roles WHERE matter_id = ? AND role = ?", id, role);
      if (cur?.user_id !== uid) this.engine.setMatterRole(id, role, uid, state.userId);
    }
    this.remember(state, "matter", rec.key, "matters", id, h);
    return m || matched ? "updated" : "created";
  }

  // ---------------------------------------------------------------- tasks

  private applyTask(state: RunState, rec: TaskRec, w: string[], o: ImportOpts): Outcome {
    const h = fingerprint(rec);
    const m = this.mapped("task", rec.key);
    if (m && m.record_hash === h) return "unchanged";
    const matterId = this.needMatter(rec.matter, false);
    const assigneeId = this.findUser(state, rec.assignee, o, w, "Assignee");
    const statusNote = rec.clioStatus && /in[ _]progress|in[ _]review/i.test(rec.clioStatus) ? `Clio status: ${rec.clioStatus.replace("_", " ")}` : null;
    const description = [rec.description, statusNote].filter(Boolean).join("\n\n") || null;
    let id: number;
    let outcome: Outcome;
    if (m) {
      id = m.lawdesk_id;
      const cur = this.one("SELECT * FROM tasks WHERE id = ?", id)!;
      if (cur.matter_id !== matterId) this.run("UPDATE tasks SET matter_id = ? WHERE id = ?", matterId, id);
      this.engine.updateTask(id, { title: rec.title, description, assigneeId, dueDate: rec.due, priority: rec.priority }, state.userId);
      if (!rec.done && (cur.status === "done" || cur.status === "skipped")) this.engine.reopenTask(id, state.userId);
      outcome = "updated";
    } else {
      id = this.engine.addTask({ matterId, title: rec.title, description, assigneeId, dueDate: rec.due, priority: rec.priority }, state.userId);
      outcome = "created";
    }
    if (rec.done) {
      const cur = this.one("SELECT status FROM tasks WHERE id = ?", id)!;
      if (cur.status !== "done") this.engine.completeTask(id, state.userId);
      this.run("UPDATE tasks SET completed_on = ? WHERE id = ?", rec.completedOn ?? rec.due ?? this.engine.today(), id);
    }
    this.remember(state, "task", rec.key, "tasks", id, h);
    return outcome;
  }

  // ------------------------------------------------------------- calendar

  private applyEvent(state: RunState, rec: EventRec, w: string[]): Outcome {
    const h = fingerprint(rec);
    const m = this.mapped("event", rec.key);
    if (m && m.record_hash === h) return "unchanged";
    const matterId = this.needMatter(rec.matter, false);
    const input = {
      title: rec.title.slice(0, 500),
      matterId,
      allDay: rec.allDay,
      start: rec.start,
      end: rec.end,
      location: rec.location,
      notes: rec.notes,
    };
    if (m) {
      this.calendar.updateEvent(m.lawdesk_id, input, state.userId);
      this.remember(state, "event", rec.key, "cal_events", m.lawdesk_id, h);
      return "updated";
    }
    const { event } = this.calendar.createEvent(
      { ...input, kind: "other", source: "clio_import", sourceRef: rec.key.slice(0, 200), uid: `clio-${createHash("sha256").update(rec.key).digest("hex").slice(0, 32)}@clio-import` },
      state.userId,
    );
    this.remember(state, "event", rec.key, "cal_events", event.id, h);
    return "created";
  }

  // ----------------------------------------------------- time and expenses

  private applyActivity(state: RunState, rec: ActivityRec, w: string[], o: ImportOpts): Outcome {
    const h = fingerprint(rec);
    const m = this.mapped("activity", rec.key);
    if (m && m.record_hash === h) return "unchanged";
    const matterId = this.needMatter(rec.matter, true)!;
    const userId = this.findUser(state, rec.user, o, w, rec.kind === "time" ? "Timekeeper" : "Person");
    if (rec.kind === "time" && userId == null) throw new Skip("No timekeeper");
    const target = rec.billed ? "clio_import_billed" : rec.kind === "time" ? "billing_time_entries" : "billing_expenses";

    // Anything already on a Lawdesk invoice stays exactly as it is.
    if (m && m.target !== "clio_import_billed") {
      const cur = this.one(`SELECT invoice_id FROM ${m.target} WHERE id = ?`, m.lawdesk_id);
      if (cur?.invoice_id != null) throw new Skip("Already on a Lawdesk invoice, so it was left as it is");
    }
    let id: number;
    if (m && m.target === target) {
      id = m.lawdesk_id;
      this.writeActivity(rec, target, matterId, userId, state, id);
    } else {
      if (m) this.run(`DELETE FROM ${m.target} WHERE id = ?`, m.lawdesk_id); // moved, e.g. billed in Clio since the last import
      id = this.writeActivity(rec, target, matterId, userId, state, null);
    }
    this.remember(state, "activity", rec.key, target, id, h, rec.totalCents);
    this.count(state, rec, target, id);
    return m ? "updated" : "created";
  }

  private writeActivity(rec: ActivityRec, target: string, matterId: number, userId: number | null, state: RunState, id: number | null): number {
    const description = rec.description.slice(0, 4000);
    if (target === "clio_import_billed") {
      const amount = rec.kind === "expense" || rec.flat ? rec.amountCents ?? 0 : rec.totalCents ?? Math.round((rec.minutes * (rec.rateCents ?? 0)) / 60);
      const vals = [rec.kind, matterId, userId, rec.date, rec.minutes, rec.rateCents, amount, description, rec.billNumber, rec.code, rec.billable ? 1 : 0, state.runId];
      if (id != null) {
        this.run(
          "UPDATE clio_import_billed SET kind=?, matter_id=?, user_id=?, date=?, minutes=?, rate_cents=?, amount_cents=?, description=?, bill_number=?, code=?, billable=?, run_id=? WHERE id = ?",
          ...vals,
          id,
        );
        return id;
      }
      return this.run(
        "INSERT INTO clio_import_billed (kind, matter_id, user_id, date, minutes, rate_cents, amount_cents, description, bill_number, code, billable, run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ...vals,
      );
    }
    if (target === "billing_time_entries") {
      const input = {
        userId: userId!,
        matterId,
        date: rec.date,
        minutes: rec.minutes,
        description,
        billable: rec.billable,
        rateCents: rec.flat ? 0 : rec.rateCents ?? undefined,
        flatCents: rec.flat ? rec.amountCents ?? 0 : null,
        activityCode: rec.code,
      };
      if (id != null) return this.billing.updateTime(id, input).id;
      return this.billing.addTime(input, state.userId).id;
    }
    const input = {
      matterId,
      userId,
      date: rec.date,
      description,
      costCents: rec.amountCents ?? 0,
      billable: rec.billable,
      expenseCode: rec.code,
      receiptNote: rec.receipt,
    };
    if (id != null) return this.billing.updateExpense(id, input).id;
    return this.billing.addExpense(input, state.userId).id;
  }

  private count(state: RunState, rec: ActivityRec, target: string, id: number) {
    const t = state.report.totals;
    if (rec.totalCents != null) t.clioStatedTotalCents += rec.totalCents;
    if (rec.kind === "time") {
      t.timeEntries++;
      t.timeMinutes += rec.minutes;
      if (target === "clio_import_billed") {
        t.billedTimeMinutes += rec.minutes;
        t.billedTimeCents += this.one("SELECT amount_cents FROM clio_import_billed WHERE id = ?", id)!.amount_cents;
      } else if (!rec.billable) t.nonBillableTimeMinutes += rec.minutes;
      else {
        const e = this.one("SELECT minutes, rate_cents, flat_cents FROM billing_time_entries WHERE id = ?", id)!;
        t.unbilledTimeMinutes += e.minutes;
        t.unbilledTimeCents += e.flat_cents != null ? e.flat_cents : Math.round((e.minutes * e.rate_cents) / 60);
      }
    } else {
      t.expenseEntries++;
      const cents = rec.amountCents ?? 0;
      if (target === "clio_import_billed") t.billedExpenseCents += cents;
      else if (!rec.billable) t.nonBillableExpenseCents += cents;
      else t.unbilledExpenseCents += cents;
    }
  }

  // ---------------------------------------------------------------- trust

  private applyTrust(state: RunState, rec: TrustRec, w: string[]): Outcome {
    let matterId: number | null = null;
    if (rec.matter) {
      matterId = this.findMatter(rec.matter);
      if (matterId == null) w.push(`Matter "${rec.matter.name ?? rec.matter.clioId}" is not in Lawdesk yet`);
    }
    // A later line for the same client/matter/account replaces the earlier one in this run.
    const matterRef = rec.matter?.name ?? rec.matter?.clioId ?? null;
    this.run(
      "DELETE FROM clio_import_trust_balances WHERE run_id = ? AND COALESCE(client_name,'') = COALESCE(?,'') AND COALESCE(matter_ref,'') = COALESCE(?,'') AND COALESCE(account,'') = COALESCE(?,'')",
      state.runId,
      rec.client,
      matterRef,
      rec.account,
    );
    this.run(
      "INSERT INTO clio_import_trust_balances (run_id, client_name, matter_ref, matter_id, account, balance_cents, as_of) VALUES (?,?,?,?,?,?,?)",
      state.runId,
      rec.client,
      matterRef,
      matterId,
      rec.account,
      rec.balanceCents,
      rec.asOf,
    );
    const r = state.report;
    r.trust ??= { lines: [], totalCents: 0, note: TRUST_NOTE };
    const existing = r.trust.lines.findIndex((l) => l.client === rec.client && l.matter === matterRef && l.account === rec.account);
    if (existing >= 0) {
      r.trust.totalCents -= r.trust.lines[existing].balanceCents;
      r.trust.lines.splice(existing, 1);
    }
    r.trust.lines.push({ client: rec.client, matter: matterRef, matterId, account: rec.account, balanceCents: rec.balanceCents, asOf: rec.asOf });
    r.trust.totalCents += rec.balanceCents;
    if (rec.balanceCents < 0) w.push("Negative trust balance: a matter's trust balance should never be below zero; check this with the accountant");
    return "created";
  }

  // --------------------------------------------------------------- reading

  listRuns(limit = 50) {
    return this.all("SELECT id, source, kind, file_name, dry_run, status, started_at, finished_at, user_id FROM clio_import_runs ORDER BY id DESC LIMIT ?", limit);
  }

  getRun(id: number) {
    const r = this.one("SELECT * FROM clio_import_runs WHERE id = ?", id);
    if (!r) throw Object.assign(new Error("Import not found"), { status: 404 });
    return { ...r, report: r.report ? JSON.parse(r.report) : null };
  }
}

function recTypeFor(kind: Kind): Rec["type"] {
  return ({ contacts: "contact", matters: "matter", tasks: "task", calendar: "event", time: "activity", expenses: "activity", trust_balances: "trust" } as const)[kind];
}

/** Fingerprint of a record's values, to skip rows that haven't changed since the last import. */
export function fingerprint(rec: Rec): string {
  return createHash("sha256").update(JSON.stringify(rec)).digest("hex").slice(0, 32);
}

const CLIO_BLOCK = /\n*--- From Clio ---\n[\s\S]*?\n--- End of Clio details ---/;

/** Contact notes: the firm's own notes are kept; the block of Clio details is replaced each import. */
function mergeNotes(existing: string | null, rec: ContactRec): string | null {
  const lines = [...rec.extra, ...(rec.notes ? [`Notes: ${rec.notes}`] : [])];
  const mine = (existing ?? "").replace(CLIO_BLOCK, "").trim();
  const block = lines.length ? `--- From Clio ---\n${lines.join("\n")}\n--- End of Clio details ---` : "";
  return [mine, block].filter(Boolean).join("\n\n") || null;
}

function mergeText(existing: string | null, clio: string | null): string | null {
  const mine = (existing ?? "").replace(CLIO_BLOCK, "").trim();
  const block = clio ? `--- From Clio ---\n${clio}\n--- End of Clio details ---` : "";
  return [mine, block].filter(Boolean).join("\n\n") || null;
}

/** One line describing a record, for previews and the report. */
export function summarize(rec: Rec): string {
  switch (rec.type) {
    case "user":
      return rec.name;
    case "contact":
      return `${rec.name}${rec.kind === "company" ? " (company)" : ""}`;
    case "matter":
      return [rec.number, rec.name].filter(Boolean).join(" ");
    case "task":
      return `${rec.title}${rec.due ? `, due ${rec.due}` : ""}`;
    case "event":
      return `${rec.title}, ${rec.allDay ? rec.start : rec.start.replace("T", " ").replace(/:00Z$/, " UTC")}`;
    case "activity": {
      const who = rec.user?.name ? `${rec.user.name}, ` : "";
      const what = rec.kind === "time" ? `${(rec.minutes / 60).toFixed(2)} h` : `$${((rec.amountCents ?? 0) / 100).toFixed(2)}`;
      return `${rec.date} ${who}${what}${rec.matter?.name ? ` on ${rec.matter.name}` : ""}`;
    }
    case "trust":
      return [rec.client, rec.matter?.name].filter(Boolean).join(", ");
  }
}

function friendly(e: any): string {
  const msg = String(e?.message ?? e);
  if (/UNIQUE constraint failed: matters\.number/.test(msg)) return "That matter number is already used";
  if (/FOREIGN KEY/.test(msg)) return "Refers to something that is not in Lawdesk";
  return msg;
}
