// API routes for the task and workflow engine: firm set-up, checklists, matters and tasks.
// Anything with rules (due dates, dependencies, automations) goes through the Engine;
// plain set-up edits the engine has no method for (renaming a user, a stage...) are
// simple SQL here and are written to the activity log the same way.

import { tx, type DB } from "../db.ts";
import { EngineError, type ListInput, type TemplateInput } from "../engine.ts";
import { isISODate } from "../dates.ts";
import { intParam, type Ctx, type Route } from "../http.ts";
import { ADMIN, assertCanSeeMatter, filterVisible } from "../auth/access.ts";

type Row = Record<string, any>;

// ------------------------------------------------------------------ input helpers

function bad(message: string): never {
  throw new EngineError(message, 400);
}

function text(v: unknown, what: string, opts: { required?: boolean; max?: number } = {}): string | null {
  if (v === undefined || v === null || v === "") {
    if (opts.required) bad(`${what} is required`);
    return null;
  }
  if (typeof v !== "string") bad(`${what} must be text`);
  const s = v.trim();
  if (opts.required && !s) bad(`${what} is required`);
  if (s.length > (opts.max ?? 2000)) bad(`${what} is too long`);
  return s || null;
}

function id(v: unknown, what: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) bad(`${what} must be an id`);
  return n;
}

function date(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (!isISODate(v)) bad(`${what} must be a date like 2026-01-31`);
  return v;
}

function exists(db: DB, table: string, rowId: number | null, what: string) {
  if (rowId == null) return;
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(rowId)) throw new EngineError(`${what} not found`, 404);
}

function one(db: DB, sql: string, ...p: any[]): Row | undefined {
  return db.prepare(sql).get(...p) as Row | undefined;
}

function all(db: DB, sql: string, ...p: any[]): Row[] {
  return db.prepare(sql).all(...p) as Row[];
}

function logActivity(ctx: Ctx, kind: string, detail: string, matterId: number | null = null, taskId: number | null = null) {
  ctx.db
    .prepare("INSERT INTO activity (at, user_id, matter_id, task_id, kind, detail) VALUES (?,?,?,?,?,?)")
    .run(new Date().toISOString(), ctx.userId, matterId, taskId, kind, detail);
}

// ------------------------------------------------------------- task enrichment

/**
 * Add what the screens need to explain a task: for each thing it waits on, who has it
 * and when it is due; how many unfinished tasks wait on it; its place in its checklist.
 */
export function enrich(db: DB, rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const blockers = all(
    db,
    `SELECT d.task_id, t.id, t.title, t.status, t.due_date, t.assignee_id, u.name AS assignee_name
     FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id LEFT JOIN users u ON u.id = t.assignee_id
     WHERE d.task_id IN (${marks}) AND t.status NOT IN ('done','skipped') ORDER BY t.id`,
    ...ids,
  );
  const blocking = all(
    db,
    `SELECT d.depends_on_id AS id, t.id AS task_id, t.title FROM task_deps d JOIN tasks t ON t.id = d.task_id
     WHERE d.depends_on_id IN (${marks}) AND t.status NOT IN ('done','skipped') ORDER BY t.id`,
    ...ids,
  );
  const pos = all(
    db,
    `SELECT t.id, tt.position, tt.key, l.name AS list_name FROM tasks t
     JOIN task_templates tt ON tt.id = t.template_id JOIN task_lists l ON l.id = tt.list_id WHERE t.id IN (${marks})`,
    ...ids,
  );
  const posById = new Map(pos.map((p) => [p.id, p]));
  for (const r of rows) {
    r.waiting_on = blockers
      .filter((b) => b.task_id === r.id)
      .map((b) => ({ id: b.id, title: b.title, status: b.status, due_date: b.due_date, assignee_id: b.assignee_id, assignee_name: b.assignee_name }));
    r.blocks = blocking.filter((b) => b.id === r.id).map((b) => ({ id: b.task_id, title: b.title }));
    const p = posById.get(r.id);
    r.template_position = p?.position ?? null;
    r.template_key = p?.key ?? null;
    r.list_name = p?.list_name ?? null;
  }
  return rows;
}

function taskById(ctx: Ctx, taskId: number): Row {
  return enrich(ctx.db, [ctx.engine.getTask(taskId)])[0];
}

/**
 * Run a change and report its knock-on effects on one matter's tasks, so the screen can
 * say "this unlocked X", "3 tasks re-dated", or "the automation added checklist Y".
 */
function track<T>(ctx: Ctx, matterId: number | null, fn: () => T): { result: T; effects: Row } {
  const snap = () =>
    new Map(
      all(ctx.db, "SELECT id, status, due_date FROM tasks WHERE matter_id IS ?", matterId).map((r) => [r.id, r] as [number, Row]),
    );
  const before = snap();
  const lastActivity = one(ctx.db, "SELECT COALESCE(MAX(id), 0) AS n FROM activity")!.n;
  const result = tx(ctx.db, fn);
  const after = snap();
  const unlocked: number[] = [];
  const relocked: number[] = [];
  const redated: number[] = [];
  const added: number[] = [];
  for (const [tid, a] of after) {
    const b = before.get(tid);
    if (!b) {
      added.push(tid);
      continue;
    }
    if (b.status === "waiting" && a.status === "open") unlocked.push(tid);
    if (b.status === "open" && a.status === "waiting") relocked.push(tid);
    if (b.due_date !== a.due_date && a.status !== "done" && a.status !== "skipped") redated.push(tid);
  }
  const rowsFor = (list: number[]) => enrich(ctx.db, list.map((tid) => ctx.engine.getTask(tid)));
  const events = all(
    ctx.db,
    "SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.id > ? AND a.matter_id IS ? ORDER BY a.id",
    lastActivity,
    matterId,
  );
  return {
    result,
    effects: { unlocked: rowsFor(unlocked), relocked: rowsFor(relocked), redated: rowsFor(redated), added: added.length, events },
  };
}

function matterOfTask(ctx: Ctx, taskId: number): number | null {
  const t = one(ctx.db, "SELECT matter_id FROM tasks WHERE id = ?", taskId);
  if (!t) throw new EngineError("Task not found", 404);
  // A task on a restricted matter is "not found" for people who can't see the matter.
  if (t.matter_id != null) {
    try {
      assertCanSeeMatter(ctx.db, ctx.userId, t.matter_id);
    } catch {
      throw new EngineError("Task not found", 404);
    }
  }
  return t.matter_id;
}

// --------------------------------------------------------------- checklist input

const ANCHOR_RE = /^(applied|after_deps|field:[a-z0-9][a-z0-9_-]{0,63})$/;

function listInput(body: any): ListInput {
  if (!body || typeof body !== "object") bad("Send the checklist as an object");
  if (!Array.isArray(body.items)) bad("A checklist needs a list of steps");
  if (body.items.length > 200) bad("A checklist can have at most 200 steps");
  const items: TemplateInput[] = body.items.map((it: any, i: number) => {
    if (!it || typeof it !== "object") bad(`Step ${i + 1} is not valid`);
    const anchor = it.anchor ?? "applied";
    if (typeof anchor !== "string" || !ANCHOR_RE.test(anchor)) bad(`Step ${i + 1}: unknown due-date rule`);
    let offset: number | null = null;
    if (it.offsetDays !== undefined && it.offsetDays !== null && it.offsetDays !== "") {
      offset = Number(it.offsetDays);
      if (!Number.isInteger(offset) || Math.abs(offset) > 3650) bad(`Step ${i + 1}: days must be a whole number`);
    }
    const deps = it.dependsOn ?? [];
    if (!Array.isArray(deps) || deps.some((d: unknown) => typeof d !== "string")) bad(`Step ${i + 1}: depends-on must be a list of step keys`);
    return {
      key: String(it.key ?? "").trim(),
      title: text(it.title, `Step ${i + 1} title`, { required: true, max: 300 })!,
      description: text(it.description, `Step ${i + 1} description`, { max: 5000 }),
      role: text(it.role, `Step ${i + 1} role`, { max: 60 }),
      anchor,
      offsetDays: offset,
      businessDays: !!it.businessDays,
      dependsOn: deps,
      priority: it.priority ?? "normal",
    };
  });
  const practiceAreaId = id(body.practiceAreaId, "Practice area");
  return {
    name: text(body.name, "Checklist name", { required: true, max: 200 })!,
    description: text(body.description, "Description", { max: 5000 }),
    practiceAreaId,
    items,
  };
}

function checklists(ctx: Ctx): Row[] {
  const lists = ctx.engine.listChecklists();
  const counts = all(
    ctx.db,
    `SELECT tt.list_id, COUNT(*) AS n FROM tasks t JOIN task_templates tt ON tt.id = t.template_id
     WHERE t.status IN ('open','waiting') GROUP BY tt.list_id`,
  );
  const used = all(ctx.db, "SELECT list_id, COUNT(*) AS n FROM list_applications GROUP BY list_id");
  for (const l of lists) {
    l.open_tasks = counts.find((c) => c.list_id === l.id)?.n ?? 0;
    l.times_used = used.find((c) => c.list_id === l.id)?.n ?? 0;
  }
  return lists;
}

// ------------------------------------------------------------------------ routes

export const routes: Route[] = [
  // ---------------------------------------------------------------- set-up
  { method: "GET", path: "/setup", handler: (ctx) => ({ ...ctx.engine.setup(), allUsers: all(ctx.db, "SELECT * FROM users ORDER BY active DESC, name") }) },

  {
    method: "POST",
    path: "/users",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const name = text(ctx.body.name, "Name", { required: true, max: 200 })!;
      const uid = ctx.engine.addUser(name, text(ctx.body.defaultRole, "Role", { max: 60 }), text(ctx.body.email, "Email", { max: 200 }));
      logActivity(ctx, "user_added", `Added person "${name}"`);
      return one(ctx.db, "SELECT * FROM users WHERE id = ?", uid);
    },
  },
  {
    method: "PATCH",
    path: "/users/:id",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const uid = intParam(ctx, "id");
      const u = one(ctx.db, "SELECT * FROM users WHERE id = ?", uid);
      if (!u) throw new EngineError("Person not found", 404);
      const b = ctx.body;
      const name = b.name !== undefined ? text(b.name, "Name", { required: true, max: 200 }) : u.name;
      const role = b.defaultRole !== undefined ? text(b.defaultRole, "Role", { max: 60 }) : u.default_role;
      const email = b.email !== undefined ? text(b.email, "Email", { max: 200 }) : u.email;
      const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
      ctx.db.prepare("UPDATE users SET name = ?, default_role = ?, email = ?, active = ? WHERE id = ?").run(name, role, email, active, uid);
      if (active !== u.active) logActivity(ctx, "user_changed", `${active ? "Reactivated" : "Deactivated"} "${name}"`);
      return one(ctx.db, "SELECT * FROM users WHERE id = ?", uid);
    },
  },

  { method: "GET", path: "/contacts", handler: (ctx) => all(ctx.db, "SELECT * FROM contacts ORDER BY name") },
  {
    method: "POST",
    path: "/contacts",
    handler: (ctx) => {
      const kind = ctx.body.kind === "company" ? "company" : "person";
      const cid = ctx.engine.addContact(
        text(ctx.body.name, "Name", { required: true, max: 200 })!,
        kind,
        text(ctx.body.email, "Email", { max: 200 }),
        text(ctx.body.phone, "Phone", { max: 60 }),
      );
      return one(ctx.db, "SELECT * FROM contacts WHERE id = ?", cid);
    },
  },
  {
    method: "PATCH",
    path: "/contacts/:id",
    handler: (ctx) => {
      const cid = intParam(ctx, "id");
      const c = one(ctx.db, "SELECT * FROM contacts WHERE id = ?", cid);
      if (!c) throw new EngineError("Contact not found", 404);
      const b = ctx.body;
      ctx.db.prepare("UPDATE contacts SET name = ?, kind = ?, email = ?, phone = ?, notes = ? WHERE id = ?").run(
        b.name !== undefined ? text(b.name, "Name", { required: true, max: 200 }) : c.name,
        b.kind !== undefined ? (b.kind === "company" ? "company" : "person") : c.kind,
        b.email !== undefined ? text(b.email, "Email", { max: 200 }) : c.email,
        b.phone !== undefined ? text(b.phone, "Phone", { max: 60 }) : c.phone,
        b.notes !== undefined ? text(b.notes, "Notes", { max: 5000 }) : c.notes,
        cid,
      );
      return one(ctx.db, "SELECT * FROM contacts WHERE id = ?", cid);
    },
  },

  {
    method: "POST",
    path: "/practice-areas",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const name = text(ctx.body.name, "Practice area name", { required: true, max: 200 })!;
      if (one(ctx.db, "SELECT 1 FROM practice_areas WHERE name = ?", name)) throw new EngineError("There is already a practice area with that name", 409);
      const stages = ctx.body.stages ?? [];
      if (!Array.isArray(stages)) bad("Stages must be a list");
      const names = stages.map((s: unknown, i: number) => text(s, `Stage ${i + 1}`, { required: true, max: 100 })!);
      const r = ctx.engine.addPracticeArea(name, names);
      logActivity(ctx, "setup", `Added practice area "${name}"`);
      return r;
    },
  },
  {
    method: "PATCH",
    path: "/practice-areas/:id",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const pid = intParam(ctx, "id");
      exists(ctx.db, "practice_areas", pid, "Practice area");
      const name = text(ctx.body.name, "Practice area name", { required: true, max: 200 })!;
      if (one(ctx.db, "SELECT 1 FROM practice_areas WHERE name = ? AND id <> ?", name, pid)) throw new EngineError("There is already a practice area with that name", 409);
      ctx.db.prepare("UPDATE practice_areas SET name = ? WHERE id = ?").run(name, pid);
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "/practice-areas/:id/stages",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const pid = intParam(ctx, "id");
      exists(ctx.db, "practice_areas", pid, "Practice area");
      const name = text(ctx.body.name, "Stage name", { required: true, max: 100 })!;
      const pos = one(ctx.db, "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM stages WHERE practice_area_id = ?", pid)!.p;
      const sid = Number(ctx.db.prepare("INSERT INTO stages (practice_area_id, name, position) VALUES (?,?,?)").run(pid, name, pos).lastInsertRowid);
      return one(ctx.db, "SELECT * FROM stages WHERE id = ?", sid);
    },
  },
  {
    method: "PUT",
    path: "/practice-areas/:id/stage-order",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const pid = intParam(ctx, "id");
      const ids = ctx.body.stageIds;
      const current = all(ctx.db, "SELECT id FROM stages WHERE practice_area_id = ?", pid).map((r) => r.id).sort();
      if (!Array.isArray(ids) || [...ids].map(Number).sort().join() !== current.join()) bad("Send every stage of this practice area, in the new order");
      tx(ctx.db, () => ids.forEach((sid: number, i: number) => ctx.db.prepare("UPDATE stages SET position = ? WHERE id = ?").run(i, Number(sid))));
      return all(ctx.db, "SELECT * FROM stages WHERE practice_area_id = ? ORDER BY position", pid);
    },
  },
  {
    method: "PATCH",
    path: "/stages/:id",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const sid = intParam(ctx, "id");
      exists(ctx.db, "stages", sid, "Stage");
      ctx.db.prepare("UPDATE stages SET name = ? WHERE id = ?").run(text(ctx.body.name, "Stage name", { required: true, max: 100 }), sid);
      return one(ctx.db, "SELECT * FROM stages WHERE id = ?", sid);
    },
  },
  {
    method: "DELETE",
    path: "/stages/:id",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const sid = intParam(ctx, "id");
      exists(ctx.db, "stages", sid, "Stage");
      const n = one(ctx.db, "SELECT COUNT(*) AS n FROM matters WHERE stage_id = ?", sid)!.n;
      if (n) throw new EngineError(`${n} matter(s) are in this stage; move them first`, 409);
      const a = one(
        ctx.db,
        "SELECT COUNT(*) AS n FROM automations WHERE (trigger='stage_entered' AND trigger_ref=?) OR (action='set_stage' AND action_ref=?)",
        sid,
        sid,
      )!.n;
      if (a) throw new EngineError(`${a} automation(s) use this stage; delete them first`, 409);
      ctx.db.prepare("DELETE FROM stages WHERE id = ?").run(sid);
      return { ok: true };
    },
  },

  {
    method: "POST",
    path: "/date-fields",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const key = text(ctx.body.key, "Key", { required: true, max: 64 })!;
      const label = text(ctx.body.label, "Label", { required: true, max: 100 })!;
      if (one(ctx.db, "SELECT 1 FROM date_fields WHERE key = ?", key)) throw new EngineError(`There is already a date field "${key}"`, 409);
      ctx.engine.addDateField(key, label);
      return { key, label };
    },
  },
  {
    method: "PATCH",
    path: "/date-fields/:key",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const key = ctx.params.key;
      if (!one(ctx.db, "SELECT 1 FROM date_fields WHERE key = ?", key)) throw new EngineError("Date field not found", 404);
      ctx.db.prepare("UPDATE date_fields SET label = ? WHERE key = ?").run(text(ctx.body.label, "Label", { required: true, max: 100 }), key);
      return { ok: true };
    },
  },
  {
    method: "DELETE",
    path: "/date-fields/:key",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const key = ctx.params.key;
      if (!one(ctx.db, "SELECT 1 FROM date_fields WHERE key = ?", key)) throw new EngineError("Date field not found", 404);
      const used =
        one(ctx.db, "SELECT COUNT(*) AS n FROM matter_dates WHERE field_key = ?", key)!.n +
        one(ctx.db, "SELECT COUNT(*) AS n FROM task_templates WHERE anchor = ?", `field:${key}`)!.n +
        one(ctx.db, "SELECT COUNT(*) AS n FROM tasks WHERE anchor = ? AND status IN ('open','waiting')", `field:${key}`)!.n;
      if (used) throw new EngineError("Matters or checklists use this date field, so it can't be deleted", 409);
      ctx.db.prepare("DELETE FROM date_fields WHERE key = ?").run(key);
      return { ok: true };
    },
  },

  {
    method: "POST",
    path: "/holidays",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const d = date(ctx.body.date, "Date");
      if (!d) bad("Date is required");
      ctx.engine.addHoliday(d, text(ctx.body.name, "Name", { max: 100 }));
      logActivity(ctx, "setup", `Firm closed on ${d}`);
      return all(ctx.db, "SELECT * FROM holidays ORDER BY date");
    },
  },
  {
    method: "DELETE",
    path: "/holidays/:date",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const d = date(ctx.params.date, "Date")!;
      ctx.engine.removeHoliday(d);
      logActivity(ctx, "setup", `Firm open again on ${d}`);
      return all(ctx.db, "SELECT * FROM holidays ORDER BY date");
    },
  },

  {
    method: "POST",
    path: "/automations",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const b = ctx.body;
      const trigger = b.trigger;
      const action = b.action;
      if (trigger !== "stage_entered" && trigger !== "list_completed") bad("Unknown trigger");
      if (action !== "apply_list" && action !== "set_stage") bad("Unknown action");
      const tRef = id(b.triggerRef, "Trigger");
      const aRef = id(b.actionRef, "Action");
      if (tRef == null || aRef == null) bad("Pick both the trigger and the action");
      let name = text(b.name, "Name", { max: 200 });
      if (!name) {
        const label = (sql: string, x: number) => one(ctx.db, sql, x)?.name ?? "?";
        const tName = trigger === "stage_entered" ? label("SELECT name FROM stages WHERE id = ?", tRef) : label("SELECT name FROM task_lists WHERE id = ?", tRef);
        const aName = action === "apply_list" ? label("SELECT name FROM task_lists WHERE id = ?", aRef) : label("SELECT name FROM stages WHERE id = ?", aRef);
        name = `${trigger === "stage_entered" ? `Entering "${tName}"` : `"${tName}" finished`} → ${action === "apply_list" ? `add "${aName}"` : `move to "${aName}"`}`;
      }
      const aid = ctx.engine.addAutomation(name, trigger, tRef, action, aRef);
      logActivity(ctx, "setup", `Added automation ${name}`);
      return one(ctx.db, "SELECT * FROM automations WHERE id = ?", aid);
    },
  },
  {
    method: "PATCH",
    path: "/automations/:id",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const aid = intParam(ctx, "id");
      ctx.engine.setAutomationEnabled(aid, !!ctx.body.enabled);
      return one(ctx.db, "SELECT * FROM automations WHERE id = ?", aid);
    },
  },
  {
    method: "DELETE",
    path: "/automations/:id",
    roles: ADMIN, // firm settings: administrators only
    handler: (ctx) => {
      const aid = intParam(ctx, "id");
      exists(ctx.db, "automations", aid, "Automation");
      ctx.engine.deleteAutomation(aid);
      return { ok: true };
    },
  },

  // ------------------------------------------------------------ checklists
  { method: "GET", path: "/checklists", handler: (ctx) => checklists(ctx) },
  {
    method: "GET",
    path: "/checklists/:id",
    handler: (ctx) => {
      const lid = intParam(ctx, "id");
      const l = checklists(ctx).find((x) => x.id === lid);
      if (!l) throw new EngineError("Checklist not found", 404);
      return l;
    },
  },
  {
    method: "POST",
    path: "/checklists",
    handler: (ctx) => {
      const input = listInput(ctx.body);
      exists(ctx.db, "practice_areas", input.practiceAreaId ?? null, "Practice area");
      const lid = ctx.engine.createList(input);
      logActivity(ctx, "checklist_created", `Created checklist "${input.name}"`);
      return checklists(ctx).find((x) => x.id === lid);
    },
  },
  {
    method: "PUT",
    path: "/checklists/:id",
    handler: (ctx) => {
      const lid = intParam(ctx, "id");
      const input = listInput(ctx.body);
      exists(ctx.db, "practice_areas", input.practiceAreaId ?? null, "Practice area");
      const r = ctx.engine.updateList(lid, input, { propagate: !!ctx.body.propagate, userId: ctx.userId });
      return { ...r, checklist: checklists(ctx).find((x) => x.id === lid) };
    },
  },
  {
    method: "DELETE",
    path: "/checklists/:id",
    handler: (ctx) => {
      const lid = intParam(ctx, "id");
      exists(ctx.db, "task_lists", lid, "Checklist");
      ctx.engine.deleteList(lid);
      return { ok: true };
    },
  },

  // --------------------------------------------------------------- matters
  {
    method: "GET",
    path: "/matters",
    handler: (ctx) => {
      const s = ctx.query.get("status") ?? "open";
      if (s !== "open" && s !== "closed" && s !== "all") bad("Status must be open, closed or all");
      return filterVisible(ctx.db, ctx.userId, ctx.engine.listMatters(s), "id");
    },
  },
  {
    method: "POST",
    path: "/matters",
    handler: (ctx) => {
      const b = ctx.body;
      let clientId = id(b.clientId, "Client");
      exists(ctx.db, "contacts", clientId, "Client");
      const practiceAreaId = id(b.practiceAreaId, "Practice area");
      const roles: Record<string, number> = {};
      for (const [role, uid] of Object.entries(b.roles ?? {})) {
        const u = id(uid, `${role}`);
        if (u == null) continue;
        exists(ctx.db, "users", u, "Person");
        roles[text(role, "Role", { required: true, max: 60 })!] = u;
      }
      const dates: Record<string, string> = {};
      for (const [k, v] of Object.entries(b.dates ?? {})) {
        const d = date(v, k);
        if (d) dates[k] = d;
      }
      const number = text(b.number, "Matter number", { max: 60 });
      if (number && one(ctx.db, "SELECT 1 FROM matters WHERE number = ?", number)) throw new EngineError(`Matter number ${number} is already used`, 409);
      const mid = tx(ctx.db, () => {
        const newClient = text(b.newClientName, "Client name", { max: 200 });
        if (clientId == null && newClient) clientId = ctx.engine.addContact(newClient, b.newClientKind === "company" ? "company" : "person");
        return ctx.engine.createMatter(
          {
            name: text(b.name, "Matter name", { required: true, max: 300 })!,
            number,
            clientId,
            practiceAreaId,
            description: text(b.description, "Description", { max: 5000 }),
            openedOn: date(b.openedOn, "Open date") ?? undefined,
            roles,
            dates,
          },
          ctx.userId,
        );
      });
      return ctx.engine.getMatter(mid).matter;
    },
  },
  {
    method: "GET",
    path: "/matters/:id",
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      const d = ctx.engine.getMatter(mid);
      enrich(ctx.db, d.tasks);
      return d;
    },
  },
  {
    method: "PATCH",
    path: "/matters/:id",
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      const m = ctx.engine.getMatter(mid).matter;
      const b = ctx.body;
      const name = b.name !== undefined ? text(b.name, "Matter name", { required: true, max: 300 }) : m.name;
      const number = b.number !== undefined ? text(b.number, "Matter number", { max: 60 }) : m.number;
      if (number && number !== m.number && one(ctx.db, "SELECT 1 FROM matters WHERE number = ? AND id <> ?", number, mid)) {
        throw new EngineError(`Matter number ${number} is already used`, 409);
      }
      const desc = b.description !== undefined ? text(b.description, "Description", { max: 5000 }) : m.description;
      const clientId = b.clientId !== undefined ? id(b.clientId, "Client") : m.client_id;
      exists(ctx.db, "contacts", clientId, "Client");
      ctx.db.prepare("UPDATE matters SET name = ?, number = ?, description = ?, client_id = ? WHERE id = ?").run(name, number, desc, clientId, mid);
      logActivity(ctx, "matter_updated", "Edited matter details", mid);
      return ctx.engine.getMatter(mid).matter;
    },
  },
  {
    method: "POST",
    path: "/matters/:id/stage",
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      const sid = id(ctx.body.stageId, "Stage");
      if (sid == null) bad("Pick a stage");
      return track(ctx, mid, () => ctx.engine.setStage(mid, sid, ctx.userId)).effects;
    },
  },
  {
    method: "PUT",
    path: "/matters/:id/dates/:key",
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      const value = date(ctx.body.value, "Date");
      return track(ctx, mid, () => ctx.engine.setMatterDate(mid, ctx.params.key, value, ctx.userId)).effects;
    },
  },
  {
    method: "PUT",
    path: "/matters/:id/roles/:role",
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      const role = text(ctx.params.role, "Role", { required: true, max: 60 })!;
      const uid = id(ctx.body.userId, "Person");
      return track(ctx, mid, () => ctx.engine.setMatterRole(mid, role, uid, ctx.userId)).effects;
    },
  },
  {
    method: "POST",
    path: "/matters/:id/close",
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      ctx.engine.closeMatter(mid, ctx.userId);
      return ctx.engine.getMatter(mid).matter;
    },
  },
  {
    method: "POST",
    path: "/matters/:id/reopen",
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      ctx.engine.getMatter(mid); // 404 if missing
      ctx.engine.reopenMatter(mid, ctx.userId);
      return ctx.engine.getMatter(mid).matter;
    },
  },
  {
    method: "POST",
    path: "/matters/:id/checklists",
    handler: (ctx) => {
      const mid = intParam(ctx, "id");
      assertCanSeeMatter(ctx.db, ctx.userId, mid);
      const lid = id(ctx.body.listId, "Checklist");
      if (lid == null) bad("Pick a checklist");
      return track(ctx, mid, () => ctx.engine.applyList(mid, lid, ctx.userId)).effects;
    },
  },

  // ----------------------------------------------------------------- tasks
  {
    method: "GET",
    path: "/my-tasks",
    handler: (ctx) => {
      const uid = id(ctx.query.get("userId") ?? ctx.userId, "Person");
      if (uid == null) bad("Pick a person");
      exists(ctx.db, "users", uid, "Person");
      const horizon = Number(ctx.query.get("days") ?? 7);
      if (!Number.isInteger(horizon) || horizon < 1 || horizon > 90) bad("Days must be between 1 and 90");
      const out: Row = ctx.engine.myTasks(uid, horizon);
      for (const k of ["overdue", "dueToday", "upcoming", "later", "noDate", "waiting"]) out[k] = enrich(ctx.db, filterVisible(ctx.db, ctx.userId, out[k]));
      out.doneToday = enrich(
        ctx.db,
        filterVisible(ctx.db, ctx.userId, ctx.engine.firmTasks({ status: "done", assigneeId: uid }).filter((t) => t.completed_on === out.today)),
      );
      return out;
    },
  },
  {
    method: "GET",
    path: "/firm-tasks",
    handler: (ctx) => {
      const status = ctx.query.get("status") ?? "active";
      if (!["active", "open", "waiting", "done", "skipped", "all"].includes(status)) bad("Unknown status filter");
      const assignee = ctx.query.get("assigneeId");
      const unassigned = ctx.query.get("unassigned") === "1" || assignee === "none";
      const rows = filterVisible(ctx.db, ctx.userId, ctx.engine.firmTasks({
        status,
        unassigned,
        assigneeId: unassigned || !assignee ? undefined : id(assignee, "Person")!,
      }));
      const limit = 2000;
      return { today: ctx.engine.today(), total: rows.length, tasks: enrich(ctx.db, rows.slice(0, limit)) };
    },
  },
  {
    method: "POST",
    path: "/tasks",
    handler: (ctx) => {
      const b = ctx.body;
      const matterId = id(b.matterId, "Matter");
      assertCanSeeMatter(ctx.db, ctx.userId, matterId);
      const assigneeId = id(b.assigneeId, "Person");
      exists(ctx.db, "users", assigneeId, "Person");
      const deps = b.dependsOn ?? [];
      if (!Array.isArray(deps)) bad("Depends-on must be a list of task ids");
      const r = track(ctx, matterId, () =>
        ctx.engine.addTask(
          {
            matterId,
            title: text(b.title, "Task title", { required: true, max: 300 })!,
            description: text(b.description, "Description", { max: 5000 }),
            assigneeId,
            role: text(b.role, "Role", { max: 60 }),
            dueDate: date(b.dueDate, "Due date"),
            priority: b.priority,
            dependsOn: deps.map((d: unknown) => id(d, "Depends-on")!),
          },
          ctx.userId,
        ),
      );
      return { task: taskById(ctx, r.result), effects: r.effects };
    },
  },
  {
    method: "GET",
    path: "/tasks/:id",
    handler: (ctx) => {
      const tid = intParam(ctx, "id");
      matterOfTask(ctx, tid); // 404 for a task on a matter this person can't see
      return taskById(ctx, tid);
    },
  },
  {
    method: "PATCH",
    path: "/tasks/:id",
    handler: (ctx) => {
      const tid = intParam(ctx, "id");
      const b = ctx.body;
      const patch: Row = {};
      if (b.title !== undefined) patch.title = text(b.title, "Task title", { required: true, max: 300 });
      if (b.description !== undefined) patch.description = text(b.description, "Description", { max: 5000 });
      if (b.assigneeId !== undefined) patch.assigneeId = id(b.assigneeId, "Person");
      if (b.dueDate !== undefined) patch.dueDate = date(b.dueDate, "Due date");
      if (b.priority !== undefined) patch.priority = b.priority;
      const r = track(ctx, matterOfTask(ctx, tid), () => ctx.engine.updateTask(tid, patch, ctx.userId));
      return { task: taskById(ctx, tid), effects: r.effects };
    },
  },
  ...(["complete", "skip", "reopen"] as const).map(
    (action): Route => ({
      method: "POST",
      path: `/tasks/:id/${action}`,
      handler: (ctx) => {
        const tid = intParam(ctx, "id");
        const r = track(ctx, matterOfTask(ctx, tid), () => {
          if (action === "complete") ctx.engine.completeTask(tid, ctx.userId);
          else if (action === "skip") ctx.engine.skipTask(tid, ctx.userId);
          else ctx.engine.reopenTask(tid, ctx.userId);
        });
        return { task: taskById(ctx, tid), effects: r.effects };
      },
    }),
  ),
  {
    method: "DELETE",
    path: "/tasks/:id",
    handler: (ctx) => {
      const tid = intParam(ctx, "id");
      return track(ctx, matterOfTask(ctx, tid), () => ctx.engine.deleteTask(tid, ctx.userId)).effects;
    },
  },

  {
    method: "GET",
    path: "/activity",
    handler: (ctx) => {
      const limit = Math.min(Math.max(Number(ctx.query.get("limit") ?? 50) || 50, 1), 500);
      // Sign-in events (kinds starting auth_) are for administrators.
      const rows = all(
        ctx.db,
        `SELECT a.*, u.name AS user_name, m.name AS matter_name FROM activity a
         LEFT JOIN users u ON u.id = a.user_id LEFT JOIN matters m ON m.id = a.matter_id
         ${ctx.role === "admin" ? "" : "WHERE substr(a.kind, 1, 5) <> 'auth_'"} ORDER BY a.id DESC LIMIT ?`,
        limit,
      );
      return filterVisible(ctx.db, ctx.userId, rows);
    },
  },
];
