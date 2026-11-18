// The task and workflow engine. Everything the firm does to tasks, matters and
// checklists goes through here, so the rules (dependencies, due dates, automations,
// the activity log) hold no matter which screen or import made the change.

import { type DB, tx } from "./db.ts";
import { type ISODate, isISODate, maxDate, offsetDate, rollForward, today as todayIn } from "./dates.ts";

export type Priority = "low" | "normal" | "high";
export type TaskStatus = "waiting" | "open" | "done" | "skipped";

export interface TemplateInput {
  key: string;
  title: string;
  description?: string | null;
  role?: string | null;
  /** "applied" | "after_deps" | "field:<date field key>" */
  anchor?: string;
  /** Days after the anchor (negative = before). Omit for no due date. */
  offsetDays?: number | null;
  businessDays?: boolean;
  dependsOn?: string[];
  priority?: Priority;
}

export interface ListInput {
  name: string;
  description?: string | null;
  practiceAreaId?: number | null;
  items: TemplateInput[];
}

export interface MatterInput {
  name: string;
  number?: string | null;
  clientId?: number | null;
  practiceAreaId?: number | null;
  description?: string | null;
  openedOn?: ISODate;
  roles?: Record<string, number>;
  dates?: Record<string, ISODate>;
}

export interface TaskInput {
  matterId?: number | null;
  title: string;
  description?: string | null;
  assigneeId?: number | null;
  role?: string | null;
  dueDate?: ISODate | null;
  priority?: Priority;
  dependsOn?: number[];
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  assigneeId?: number | null;
  dueDate?: ISODate | null;
  priority?: Priority;
}

export class EngineError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PRIORITIES = new Set(["low", "normal", "high"]);
const FINISHED = new Set(["done", "skipped"]);
const MAX_AUTOMATION_DEPTH = 8;

type Row = Record<string, any>;

export class Engine {
  db: DB;
  private todayFn: () => ISODate;

  constructor(db: DB, opts: { today?: () => ISODate; timeZone?: string } = {}) {
    this.db = db;
    this.todayFn = opts.today ?? (() => todayIn(opts.timeZone));
  }

  today(): ISODate {
    return this.todayFn();
  }

  // ---------------------------------------------------------------- helpers

  private one(sql: string, ...params: any[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: any[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: any[]): number {
    return Number(this.db.prepare(sql).run(...params).lastInsertRowid);
  }

  private must(sql: string, what: string, ...params: any[]): Row {
    const row = this.one(sql, ...params);
    if (!row) throw new EngineError(`${what} not found`, 404);
    return row;
  }

  /** Write one row to the activity log. Modules should use this rather than inserting directly. */
  log(kind: string, detail: string, ids: { userId?: number | null; matterId?: number | null; taskId?: number | null }) {
    this.run(
      "INSERT INTO activity (at, user_id, matter_id, task_id, kind, detail) VALUES (?,?,?,?,?,?)",
      new Date().toISOString(),
      ids.userId ?? null,
      ids.matterId ?? null,
      ids.taskId ?? null,
      kind,
      detail,
    );
  }

  private holidays(): Set<string> {
    return new Set(this.all("SELECT date FROM holidays").map((r) => r.date as string));
  }

  private checkDate(value: unknown, what: string): ISODate {
    if (!isISODate(value)) throw new EngineError(`${what} must be a date like 2026-01-31`);
    return value;
  }

  private checkPriority(p: unknown): Priority {
    if (p === undefined) return "normal";
    if (typeof p !== "string" || !PRIORITIES.has(p)) throw new EngineError("Priority must be low, normal or high");
    return p as Priority;
  }

  private checkAnchor(anchor: string) {
    if (anchor === "applied" || anchor === "after_deps") return;
    if (anchor.startsWith("field:")) {
      const key = anchor.slice(6);
      if (!this.one("SELECT 1 FROM date_fields WHERE key = ?", key)) {
        throw new EngineError(`Unknown date field "${key}"`);
      }
      return;
    }
    throw new EngineError(`Unknown due-date anchor "${anchor}"`);
  }

  // ---------------------------------------------------------- firm set-up

  addUser(name: string, defaultRole: string | null = null, email: string | null = null): number {
    if (!name?.trim()) throw new EngineError("A user needs a name");
    return this.run("INSERT INTO users (name, default_role, email) VALUES (?,?,?)", name.trim(), defaultRole, email);
  }

  addContact(name: string, kind: "person" | "company" = "person", email: string | null = null, phone: string | null = null): number {
    if (!name?.trim()) throw new EngineError("A contact needs a name");
    return this.run("INSERT INTO contacts (name, kind, email, phone) VALUES (?,?,?,?)", name.trim(), kind, email, phone);
  }

  addPracticeArea(name: string, stageNames: string[] = []): { id: number; stageIds: number[] } {
    return tx(this.db, () => {
      if (!name?.trim()) throw new EngineError("A practice area needs a name");
      const id = this.run("INSERT INTO practice_areas (name) VALUES (?)", name.trim());
      const stageIds = stageNames.map((s, i) =>
        this.run("INSERT INTO stages (practice_area_id, name, position) VALUES (?,?,?)", id, s, i),
      );
      return { id, stageIds };
    });
  }

  addDateField(key: string, label: string) {
    if (!KEY_RE.test(key)) throw new EngineError("Date field keys use lower-case letters, digits, _ and -");
    this.run("INSERT INTO date_fields (key, label) VALUES (?,?)", key, label);
  }

  addHoliday(date: ISODate, name: string | null = null) {
    this.checkDate(date, "Holiday");
    tx(this.db, () => {
      this.run("INSERT OR REPLACE INTO holidays (date, name) VALUES (?,?)", date, name);
      this.recomputeOpenDueDates();
    });
  }

  removeHoliday(date: ISODate) {
    tx(this.db, () => {
      this.run("DELETE FROM holidays WHERE date = ?", date);
      this.recomputeOpenDueDates();
    });
  }

  addAutomation(
    name: string,
    trigger: "stage_entered" | "list_completed",
    triggerRef: number,
    action: "apply_list" | "set_stage",
    actionRef: number,
  ): number {
    if (trigger === "stage_entered") this.must("SELECT id FROM stages WHERE id = ?", "Stage", triggerRef);
    else if (trigger === "list_completed") this.must("SELECT id FROM task_lists WHERE id = ?", "Checklist", triggerRef);
    else throw new EngineError("Unknown trigger");
    if (action === "apply_list") this.must("SELECT id FROM task_lists WHERE id = ?", "Checklist", actionRef);
    else if (action === "set_stage") this.must("SELECT id FROM stages WHERE id = ?", "Stage", actionRef);
    else throw new EngineError("Unknown action");
    return this.run(
      "INSERT INTO automations (name, trigger, trigger_ref, action, action_ref) VALUES (?,?,?,?,?)",
      name,
      trigger,
      triggerRef,
      action,
      actionRef,
    );
  }

  setAutomationEnabled(id: number, enabled: boolean) {
    this.must("SELECT id FROM automations WHERE id = ?", "Automation", id);
    this.run("UPDATE automations SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id);
  }

  deleteAutomation(id: number) {
    this.run("DELETE FROM automations WHERE id = ?", id);
  }

  // ------------------------------------------------------------ checklists

  /** Reject bad keys, unknown dependencies and dependency loops before anything is saved. */
  private validateItems(items: TemplateInput[]) {
    if (!Array.isArray(items) || items.length === 0) throw new EngineError("A checklist needs at least one task");
    const keys = new Set<string>();
    for (const it of items) {
      if (!KEY_RE.test(it.key ?? "")) throw new EngineError(`Task key "${it.key}" must use lower-case letters, digits, _ and -`);
      if (keys.has(it.key)) throw new EngineError(`Task key "${it.key}" is used twice`);
      keys.add(it.key);
      if (!it.title?.trim()) throw new EngineError(`Task "${it.key}" needs a title`);
      this.checkAnchor(it.anchor ?? "applied");
      this.checkPriority(it.priority);
      if (it.offsetDays != null && !Number.isInteger(it.offsetDays)) throw new EngineError(`Task "${it.key}": offset must be whole days`);
    }
    for (const it of items) {
      for (const d of it.dependsOn ?? []) {
        if (!keys.has(d)) throw new EngineError(`Task "${it.key}" depends on unknown task "${d}"`);
        if (d === it.key) throw new EngineError(`Task "${it.key}" cannot depend on itself`);
      }
      if ((it.anchor ?? "applied") === "after_deps" && !(it.dependsOn ?? []).length) {
        throw new EngineError(`Task "${it.key}" is dated from the tasks it depends on, but depends on none`);
      }
    }
    const byKey = new Map(items.map((i) => [i.key, i.dependsOn ?? []]));
    const state = new Map<string, number>(); // 1 visiting, 2 done
    const visit = (k: string, path: string[]) => {
      if (state.get(k) === 2) return;
      if (state.get(k) === 1) throw new EngineError(`Dependency loop: ${[...path, k].join(" → ")}`);
      state.set(k, 1);
      for (const d of byKey.get(k)!) visit(d, [...path, k]);
      state.set(k, 2);
    };
    for (const k of byKey.keys()) visit(k, []);
  }

  createList(input: ListInput): number {
    return tx(this.db, () => {
      if (!input.name?.trim()) throw new EngineError("A checklist needs a name");
      this.validateItems(input.items);
      const id = this.run(
        "INSERT INTO task_lists (name, description, practice_area_id) VALUES (?,?,?)",
        input.name.trim(),
        input.description ?? null,
        input.practiceAreaId ?? null,
      );
      this.insertTemplates(id, input.items);
      return id;
    });
  }

  private insertTemplates(listId: number, items: TemplateInput[]) {
    items.forEach((it, i) =>
      this.run(
        `INSERT INTO task_templates (list_id, key, title, description, role, anchor, offset_days, business_days, depends_on, priority, position)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        listId,
        it.key,
        it.title.trim(),
        it.description ?? null,
        it.role ?? null,
        it.anchor ?? "applied",
        it.offsetDays ?? null,
        it.businessDays ? 1 : 0,
        JSON.stringify(it.dependsOn ?? []),
        it.priority ?? "normal",
        i,
      ),
    );
  }

  /**
   * Replace a checklist's steps. Steps keep their identity by key, so tasks already
   * on matters stay linked. With propagate, open and waiting tasks made from a
   * changed step pick up its new title, description, role and due-date rule, except
   * where someone has edited that task by hand. (Clio does not update tasks already
   * assigned when a task list template changes.)
   */
  updateList(listId: number, input: ListInput, opts: { propagate?: boolean; userId?: number | null } = {}) {
    return tx(this.db, () => {
      this.must("SELECT id FROM task_lists WHERE id = ?", "Checklist", listId);
      if (!input.name?.trim()) throw new EngineError("A checklist needs a name");
      this.validateItems(input.items);
      this.run(
        "UPDATE task_lists SET name = ?, description = ?, practice_area_id = ? WHERE id = ?",
        input.name.trim(),
        input.description ?? null,
        input.practiceAreaId ?? null,
        listId,
      );
      const existing = new Map(this.all("SELECT * FROM task_templates WHERE list_id = ?", listId).map((r) => [r.key as string, r]));
      const keep = new Set(input.items.map((i) => i.key));
      for (const [key, row] of existing) {
        if (!keep.has(key)) this.run("DELETE FROM task_templates WHERE id = ?", row.id);
      }
      let changedTasks = 0;
      input.items.forEach((it, i) => {
        const prev = existing.get(it.key);
        const vals = [
          it.title.trim(),
          it.description ?? null,
          it.role ?? null,
          it.anchor ?? "applied",
          it.offsetDays ?? null,
          it.businessDays ? 1 : 0,
          JSON.stringify(it.dependsOn ?? []),
          it.priority ?? "normal",
          i,
        ];
        if (!prev) {
          this.insertTemplates(listId, [it]);
          this.run("UPDATE task_templates SET position = ? WHERE list_id = ? AND key = ?", i, listId, it.key);
          return;
        }
        this.run(
          `UPDATE task_templates SET title=?, description=?, role=?, anchor=?, offset_days=?, business_days=?, depends_on=?, priority=?, position=? WHERE id=?`,
          ...vals,
          prev.id,
        );
        if (opts.propagate) changedTasks += this.propagateTemplate(prev.id);
      });
      this.log("checklist_updated", `Updated checklist "${input.name.trim()}"${opts.propagate ? `; ${changedTasks} open task(s) updated` : ""}`, {
        userId: opts.userId,
      });
      return { changedTasks };
    });
  }

  private propagateTemplate(templateId: number): number {
    const t = this.one("SELECT * FROM task_templates WHERE id = ?", templateId)!;
    const tasks = this.all("SELECT * FROM tasks WHERE template_id = ? AND status IN ('open','waiting')", templateId);
    let n = 0;
    for (const task of tasks) {
      let changed = false;
      if (!task.customized && (task.title !== t.title || task.description !== t.description)) {
        this.run("UPDATE tasks SET title = ?, description = ? WHERE id = ?", t.title, t.description, task.id);
        changed = true;
      }
      if (task.priority !== t.priority) {
        this.run("UPDATE tasks SET priority = ? WHERE id = ?", t.priority, task.id);
        changed = true;
      }
      if (task.role !== t.role) {
        const assignee = task.matter_id ? this.roleHolder(task.matter_id, t.role) : null;
        this.run("UPDATE tasks SET role = ?, assignee_id = COALESCE(?, assignee_id) WHERE id = ?", t.role, assignee, task.id);
        changed = true;
      }
      if (task.anchor !== t.anchor || task.offset_days !== t.offset_days || task.business_days !== t.business_days) {
        this.run("UPDATE tasks SET anchor = ?, offset_days = ?, business_days = ? WHERE id = ?", t.anchor, t.offset_days, t.business_days, task.id);
        this.refreshDue(task.id);
        changed = true;
      }
      if (changed) n++;
    }
    return n;
  }

  deleteList(listId: number) {
    tx(this.db, () => {
      if (this.one("SELECT 1 FROM list_applications WHERE list_id = ?", listId)) {
        throw new EngineError("This checklist has been used on matters; rename it instead of deleting it", 409);
      }
      this.run("DELETE FROM automations WHERE (trigger='list_completed' AND trigger_ref=?) OR (action='apply_list' AND action_ref=?)", listId, listId);
      this.run("DELETE FROM task_lists WHERE id = ?", listId);
    });
  }

  // --------------------------------------------------------------- matters

  private roleHolder(matterId: number, role: string | null): number | null {
    if (!role) return null;
    const r = this.one("SELECT user_id FROM matter_roles WHERE matter_id = ? AND role = ?", matterId, role);
    if (r) return r.user_id;
    // Fall back to the only active user with that role, if there is exactly one.
    const users = this.all("SELECT id FROM users WHERE active = 1 AND default_role = ?", role);
    return users.length === 1 ? users[0].id : null;
  }

  createMatter(input: MatterInput, userId: number | null = null): number {
    return tx(this.db, () => {
      if (!input.name?.trim()) throw new EngineError("A matter needs a name");
      const opened = input.openedOn ? this.checkDate(input.openedOn, "Open date") : this.today();
      let stageId: number | null = null;
      if (input.practiceAreaId != null) {
        this.must("SELECT id FROM practice_areas WHERE id = ?", "Practice area", input.practiceAreaId);
        stageId = this.one("SELECT id FROM stages WHERE practice_area_id = ? ORDER BY position LIMIT 1", input.practiceAreaId)?.id ?? null;
      }
      const id = this.run(
        `INSERT INTO matters (number, name, client_id, practice_area_id, stage_id, opened_on, description) VALUES (?,?,?,?,?,?,?)`,
        input.number ?? null,
        input.name.trim(),
        input.clientId ?? null,
        input.practiceAreaId ?? null,
        null,
        opened,
        input.description ?? null,
      );
      for (const [role, uid] of Object.entries(input.roles ?? {})) {
        this.run("INSERT INTO matter_roles (matter_id, role, user_id) VALUES (?,?,?)", id, role, uid);
      }
      for (const [key, value] of Object.entries(input.dates ?? {})) {
        this.must("SELECT key FROM date_fields WHERE key = ?", `Date field "${key}"`, key);
        this.run("INSERT INTO matter_dates (matter_id, field_key, value) VALUES (?,?,?)", id, key, this.checkDate(value, key));
      }
      this.log("matter_opened", `Opened matter "${input.name.trim()}"`, { userId, matterId: id });
      if (stageId != null) this.setStage(id, stageId, userId);
      return id;
    });
  }

  setStage(matterId: number, stageId: number, userId: number | null = null, depth = 0) {
    tx(this.db, () => {
      const m = this.must("SELECT * FROM matters WHERE id = ?", "Matter", matterId);
      const s = this.must("SELECT * FROM stages WHERE id = ?", "Stage", stageId);
      if (s.practice_area_id !== m.practice_area_id) throw new EngineError("That stage belongs to a different practice area");
      if (m.stage_id === stageId) return;
      this.run("UPDATE matters SET stage_id = ? WHERE id = ?", stageId, matterId);
      this.log("stage_changed", `Moved to stage "${s.name}"`, { userId, matterId });
      this.fire("stage_entered", stageId, matterId, userId, depth);
    });
  }

  private fire(trigger: string, ref: number, matterId: number, userId: number | null, depth: number) {
    if (depth >= MAX_AUTOMATION_DEPTH) {
      this.log("automation_stopped", "Stopped a chain of automations that kept triggering each other", { matterId });
      return;
    }
    const rules = this.all("SELECT * FROM automations WHERE enabled = 1 AND trigger = ? AND trigger_ref = ? ORDER BY id", trigger, ref);
    for (const r of rules) {
      this.log("automation", `Automatic step "${r.name}" ran`, { matterId });
      if (r.action === "apply_list") this.applyList(matterId, r.action_ref, userId, depth + 1);
      else if (r.action === "set_stage") this.setStage(matterId, r.action_ref, userId, depth + 1);
    }
  }

  setMatterDate(matterId: number, key: string, value: ISODate | null, userId: number | null = null) {
    tx(this.db, () => {
      this.must("SELECT id FROM matters WHERE id = ?", "Matter", matterId);
      const f = this.must("SELECT * FROM date_fields WHERE key = ?", `Date field "${key}"`, key);
      if (value == null || value === "") {
        this.run("DELETE FROM matter_dates WHERE matter_id = ? AND field_key = ?", matterId, key);
        this.log("date_changed", `Cleared ${f.label}`, { userId, matterId });
      } else {
        this.checkDate(value, f.label);
        this.run("INSERT OR REPLACE INTO matter_dates (matter_id, field_key, value) VALUES (?,?,?)", matterId, key, value);
        this.log("date_changed", `${f.label} set to ${value}`, { userId, matterId });
      }
      const tasks = this.all("SELECT id FROM tasks WHERE matter_id = ? AND anchor = ? AND status IN ('open','waiting')", matterId, `field:${key}`);
      for (const t of tasks) this.refreshDue(t.id);
    });
  }

  /** Put someone in a role on a matter; their open tasks for that role move to them. */
  setMatterRole(matterId: number, role: string, newUserId: number | null, userId: number | null = null) {
    tx(this.db, () => {
      this.must("SELECT id FROM matters WHERE id = ?", "Matter", matterId);
      const prev = this.one("SELECT user_id FROM matter_roles WHERE matter_id = ? AND role = ?", matterId, role)?.user_id ?? null;
      if (newUserId == null) this.run("DELETE FROM matter_roles WHERE matter_id = ? AND role = ?", matterId, role);
      else {
        this.must("SELECT id FROM users WHERE id = ?", "User", newUserId);
        this.run("INSERT OR REPLACE INTO matter_roles (matter_id, role, user_id) VALUES (?,?,?)", matterId, role, newUserId);
      }
      const n = this.db
        .prepare(
          `UPDATE tasks SET assignee_id = ? WHERE matter_id = ? AND role = ? AND status IN ('open','waiting')
           AND (assignee_id IS ? OR assignee_id IS NULL)`,
        )
        .run(newUserId, matterId, role, prev).changes;
      const who = newUserId ? this.one("SELECT name FROM users WHERE id = ?", newUserId)!.name : "nobody";
      this.log("role_changed", `${role} is now ${who}; ${n} open task(s) moved`, { userId, matterId });
    });
  }

  closeMatter(matterId: number, userId: number | null = null) {
    tx(this.db, () => {
      this.must("SELECT id FROM matters WHERE id = ?", "Matter", matterId);
      const open = this.one("SELECT COUNT(*) n FROM tasks WHERE matter_id = ? AND status IN ('open','waiting')", matterId)!.n;
      if (open > 0) throw new EngineError(`This matter still has ${open} unfinished task(s)`, 409);
      this.run("UPDATE matters SET status = 'closed', closed_on = ? WHERE id = ?", this.today(), matterId);
      this.log("matter_closed", "Closed the matter", { userId, matterId });
    });
  }

  reopenMatter(matterId: number, userId: number | null = null) {
    this.must("SELECT id FROM matters WHERE id = ?", "Matter", matterId);
    this.run("UPDATE matters SET status = 'open', closed_on = NULL WHERE id = ?", matterId);
    this.log("matter_reopened", "Reopened the matter", { userId, matterId });
  }

  // ----------------------------------------------------------------- tasks

  /** Add a checklist's tasks to a matter, wiring up dependencies and due dates. */
  applyList(matterId: number, listId: number, userId: number | null = null, depth = 0): number[] {
    return tx(this.db, () => {
      this.must("SELECT id FROM matters WHERE id = ?", "Matter", matterId);
      const list = this.must("SELECT * FROM task_lists WHERE id = ?", "Checklist", listId);
      const templates = this.all("SELECT * FROM task_templates WHERE list_id = ? ORDER BY position", listId);
      const appliedOn = this.today();
      const appId = this.run(
        "INSERT INTO list_applications (matter_id, list_id, applied_on, applied_by) VALUES (?,?,?,?)",
        matterId,
        listId,
        appliedOn,
        userId,
      );
      const idByKey = new Map<string, number>();
      for (const t of templates) {
        const id = this.run(
          `INSERT INTO tasks (matter_id, template_id, application_id, title, description, role, assignee_id, status, priority,
                              anchor, offset_days, business_days, created_on)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          matterId,
          t.id,
          appId,
          t.title,
          t.description,
          t.role,
          this.roleHolder(matterId, t.role),
          JSON.parse(t.depends_on).length ? "waiting" : "open",
          t.priority,
          t.anchor,
          t.offset_days,
          t.business_days,
          appliedOn,
        );
        idByKey.set(t.key, id);
      }
      for (const t of templates) {
        for (const k of JSON.parse(t.depends_on) as string[]) {
          this.run("INSERT INTO task_deps (task_id, depends_on_id) VALUES (?,?)", idByKey.get(t.key), idByKey.get(k));
        }
      }
      for (const id of idByKey.values()) this.refreshDue(id);
      this.log("checklist_applied", `Added checklist "${list.name}" (${templates.length} tasks)`, { userId, matterId });
      return [...idByKey.values()];
    });
  }

  addTask(input: TaskInput, userId: number | null = null): number {
    return tx(this.db, () => {
      if (!input.title?.trim()) throw new EngineError("A task needs a title");
      if (input.matterId != null) this.must("SELECT id FROM matters WHERE id = ?", "Matter", input.matterId);
      const due = input.dueDate ? this.checkDate(input.dueDate, "Due date") : null;
      let assignee = input.assigneeId ?? null;
      if (assignee == null && input.matterId != null) assignee = this.roleHolder(input.matterId, input.role ?? null);
      const deps = input.dependsOn ?? [];
      for (const d of deps) {
        const dep = this.must("SELECT matter_id FROM tasks WHERE id = ?", `Task ${d}`, d);
        if (dep.matter_id !== (input.matterId ?? null)) throw new EngineError("A task can only depend on tasks in the same matter");
      }
      const id = this.run(
        `INSERT INTO tasks (matter_id, title, description, role, assignee_id, status, priority, anchor, due_date, due_locked, created_on)
         VALUES (?,?,?,?,?,'open',?,'manual',?,?,?)`,
        input.matterId ?? null,
        input.title.trim(),
        input.description ?? null,
        input.role ?? null,
        assignee,
        this.checkPriority(input.priority),
        due,
        due ? 1 : 0,
        this.today(),
      );
      for (const d of deps) this.run("INSERT INTO task_deps (task_id, depends_on_id) VALUES (?,?)", id, d);
      this.refreshStatus(id);
      this.log("task_added", `Added task "${input.title.trim()}"`, { userId, matterId: input.matterId, taskId: id });
      return id;
    });
  }

  updateTask(taskId: number, patch: TaskPatch, userId: number | null = null) {
    tx(this.db, () => {
      const t = this.must("SELECT * FROM tasks WHERE id = ?", "Task", taskId);
      const changes: string[] = [];
      if (patch.title !== undefined || patch.description !== undefined) {
        const title = patch.title !== undefined ? patch.title.trim() : t.title;
        if (!title) throw new EngineError("A task needs a title");
        const desc = patch.description !== undefined ? patch.description : t.description;
        if (title !== t.title || desc !== t.description) {
          this.run("UPDATE tasks SET title = ?, description = ?, customized = 1 WHERE id = ?", title, desc, taskId);
          changes.push("details");
        }
      }
      if (patch.priority !== undefined) {
        this.run("UPDATE tasks SET priority = ? WHERE id = ?", this.checkPriority(patch.priority), taskId);
        changes.push(`priority ${patch.priority}`);
      }
      if (patch.assigneeId !== undefined) {
        if (patch.assigneeId != null) this.must("SELECT id FROM users WHERE id = ?", "User", patch.assigneeId);
        this.run("UPDATE tasks SET assignee_id = ? WHERE id = ?", patch.assigneeId, taskId);
        const who = patch.assigneeId ? this.one("SELECT name FROM users WHERE id = ?", patch.assigneeId)!.name : "nobody";
        changes.push(`assigned to ${who}`);
      }
      if (patch.dueDate !== undefined) {
        if (patch.dueDate == null || patch.dueDate === "") {
          // Clearing a typed date hands the date back to the checklist rule, if there is one.
          this.run("UPDATE tasks SET due_locked = 0, due_date = NULL WHERE id = ?", taskId);
          this.refreshDue(taskId);
          changes.push("due date reset");
        } else {
          this.run("UPDATE tasks SET due_date = ?, due_locked = 1 WHERE id = ?", this.checkDate(patch.dueDate, "Due date"), taskId);
          changes.push(`due ${patch.dueDate}`);
        }
      }
      if (changes.length) this.log("task_updated", `"${t.title}": ${changes.join(", ")}`, { userId, matterId: t.matter_id, taskId });
    });
  }

  completeTask(taskId: number, userId: number | null = null) {
    this.finish(taskId, "done", userId);
  }

  skipTask(taskId: number, userId: number | null = null) {
    this.finish(taskId, "skipped", userId);
  }

  private finish(taskId: number, status: "done" | "skipped", userId: number | null) {
    tx(this.db, () => {
      const t = this.must("SELECT * FROM tasks WHERE id = ?", "Task", taskId);
      if (FINISHED.has(t.status)) return;
      if (t.status === "waiting" && status === "done") {
        const names = this.blockers(taskId).map((b) => `"${b.title}"`).join(", ");
        throw new EngineError(`This task is waiting on ${names}. Finish or skip those first.`, 409);
      }
      this.run("UPDATE tasks SET status = ?, completed_on = ?, completed_by = ? WHERE id = ?", status, this.today(), userId, taskId);
      this.log(status === "done" ? "task_done" : "task_skipped", `${status === "done" ? "Finished" : "Skipped"} "${t.title}"`, {
        userId,
        matterId: t.matter_id,
        taskId,
      });
      for (const d of this.all("SELECT task_id FROM task_deps WHERE depends_on_id = ?", taskId)) {
        this.refreshStatus(d.task_id);
        this.refreshDue(d.task_id);
      }
      if (t.application_id) this.checkApplicationDone(t.application_id, userId);
    });
  }

  reopenTask(taskId: number, userId: number | null = null) {
    tx(this.db, () => {
      const t = this.must("SELECT * FROM tasks WHERE id = ?", "Task", taskId);
      if (!FINISHED.has(t.status)) return;
      this.run("UPDATE tasks SET status = 'open', completed_on = NULL, completed_by = NULL WHERE id = ?", taskId);
      this.refreshStatus(taskId);
      this.log("task_reopened", `Reopened "${t.title}"`, { userId, matterId: t.matter_id, taskId });
      // Tasks that were waiting on this one go back to waiting.
      for (const d of this.all("SELECT task_id FROM task_deps WHERE depends_on_id = ?", taskId)) {
        this.refreshStatus(d.task_id);
        this.refreshDue(d.task_id);
      }
      if (t.application_id) this.run("UPDATE list_applications SET completed_on = NULL WHERE id = ?", t.application_id);
    });
  }

  deleteTask(taskId: number, userId: number | null = null) {
    tx(this.db, () => {
      const t = this.must("SELECT * FROM tasks WHERE id = ?", "Task", taskId);
      const dependents = this.all("SELECT task_id FROM task_deps WHERE depends_on_id = ?", taskId);
      this.run("DELETE FROM tasks WHERE id = ?", taskId);
      for (const d of dependents) {
        this.refreshStatus(d.task_id);
        this.refreshDue(d.task_id);
      }
      this.log("task_deleted", `Deleted "${t.title}"`, { userId, matterId: t.matter_id });
      if (t.application_id) this.checkApplicationDone(t.application_id, userId);
    });
  }

  private blockers(taskId: number): Row[] {
    return this.all(
      `SELECT t.id, t.title, t.status FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
       WHERE d.task_id = ? AND t.status NOT IN ('done','skipped') ORDER BY t.id`,
      taskId,
    );
  }

  private refreshStatus(taskId: number) {
    const t = this.one("SELECT status FROM tasks WHERE id = ?", taskId);
    if (!t || FINISHED.has(t.status)) return;
    const next = this.blockers(taskId).length ? "waiting" : "open";
    if (next !== t.status) this.run("UPDATE tasks SET status = ? WHERE id = ?", next, taskId);
  }

  /** Work out a task's due date from its rule. Typed-in dates are left alone. */
  computeDue(task: Row, holidays = this.holidays()): ISODate | null {
    if (task.anchor === "manual" || task.offset_days == null) return task.due_date ?? null;
    let base: ISODate | null = null;
    if (task.anchor === "applied") {
      base = task.application_id
        ? this.one("SELECT applied_on FROM list_applications WHERE id = ?", task.application_id)?.applied_on ?? task.created_on
        : task.created_on;
    } else if (task.anchor === "after_deps") {
      const deps = this.all(
        "SELECT t.status, t.completed_on FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ?",
        task.id,
      );
      if (deps.length === 0) base = task.created_on;
      else if (deps.some((d) => !FINISHED.has(d.status))) return null;
      else base = maxDate(deps.map((d) => d.completed_on));
    } else if (String(task.anchor).startsWith("field:")) {
      base = task.matter_id
        ? this.one("SELECT value FROM matter_dates WHERE matter_id = ? AND field_key = ?", task.matter_id, task.anchor.slice(6))?.value ?? null
        : null;
    }
    if (!base) return null;
    const due = offsetDate(base, task.offset_days, !!task.business_days, holidays);
    return task.business_days && task.offset_days === 0 ? rollForward(due, holidays) : due;
  }

  private refreshDue(taskId: number, holidays?: Set<string>) {
    const t = this.one("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!t || t.due_locked || FINISHED.has(t.status) || t.anchor === "manual") return;
    const due = this.computeDue(t, holidays);
    if (due !== t.due_date) this.run("UPDATE tasks SET due_date = ? WHERE id = ?", due, taskId);
  }

  private recomputeOpenDueDates() {
    const h = this.holidays();
    for (const t of this.all("SELECT id FROM tasks WHERE status IN ('open','waiting') AND business_days = 1")) this.refreshDue(t.id, h);
  }

  private checkApplicationDone(appId: number, userId: number | null) {
    const app = this.one("SELECT * FROM list_applications WHERE id = ?", appId);
    if (!app || app.completed_on) return;
    const left = this.one("SELECT COUNT(*) n FROM tasks WHERE application_id = ? AND status IN ('open','waiting')", appId)!.n;
    if (left > 0) return;
    this.run("UPDATE list_applications SET completed_on = ? WHERE id = ?", this.today(), appId);
    const list = this.one("SELECT name FROM task_lists WHERE id = ?", app.list_id);
    this.log("checklist_done", `Checklist "${list?.name}" is finished`, { userId, matterId: app.matter_id });
    this.fire("list_completed", app.list_id, app.matter_id, userId, 0);
  }

  // --------------------------------------------------------------- reading

  private taskRows(where: string, ...params: any[]): Row[] {
    const rows = this.all(
      `SELECT t.*, m.name AS matter_name, m.number AS matter_number, u.name AS assignee_name
       FROM tasks t LEFT JOIN matters m ON m.id = t.matter_id LEFT JOIN users u ON u.id = t.assignee_id
       WHERE ${where}
       ORDER BY t.due_date IS NULL, t.due_date, CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, t.id`,
      ...params,
    );
    const ids = rows.map((r) => r.id);
    const deps = ids.length
      ? this.all(
          `SELECT d.task_id, d.depends_on_id, t.title, t.status FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id
           WHERE d.task_id IN (${ids.map(() => "?").join(",")})`,
          ...ids,
        )
      : [];
    for (const r of rows) {
      const mine = deps.filter((d) => d.task_id === r.id);
      r.depends_on = mine.map((d) => d.depends_on_id);
      r.waiting_on = mine.filter((d) => !FINISHED.has(d.status)).map((d) => ({ id: d.depends_on_id, title: d.title }));
    }
    return rows;
  }

  getTask(id: number): Row {
    const rows = this.taskRows("t.id = ?", id);
    if (!rows.length) throw new EngineError("Task not found", 404);
    return rows[0];
  }

  /** One person's work, sorted into the buckets they act on. */
  myTasks(userId: number, horizonDays = 7) {
    const t = this.today();
    const soon = offsetDate(t, horizonDays, false);
    const rows = this.taskRows("t.assignee_id = ? AND t.status IN ('open','waiting') AND (m.status IS NULL OR m.status = 'open')", userId);
    const out = { today: t, overdue: [] as Row[], dueToday: [] as Row[], upcoming: [] as Row[], later: [] as Row[], noDate: [] as Row[], waiting: [] as Row[] };
    for (const r of rows) {
      if (r.status === "waiting") out.waiting.push(r);
      else if (!r.due_date) out.noDate.push(r);
      else if (r.due_date < t) out.overdue.push(r);
      else if (r.due_date === t) out.dueToday.push(r);
      else if (r.due_date <= soon) out.upcoming.push(r);
      else out.later.push(r);
    }
    return out;
  }

  firmTasks(filter: { status?: string; assigneeId?: number; unassigned?: boolean } = {}) {
    const where = ["(m.status IS NULL OR m.status = 'open')"];
    const params: any[] = [];
    if (filter.status === "active" || !filter.status) where.push("t.status IN ('open','waiting')");
    else if (filter.status !== "all") {
      where.push("t.status = ?");
      params.push(filter.status);
    }
    if (filter.unassigned) where.push("t.assignee_id IS NULL");
    else if (filter.assigneeId != null) {
      where.push("t.assignee_id = ?");
      params.push(filter.assigneeId);
    }
    return this.taskRows(where.join(" AND "), ...params);
  }

  listMatters(status: "open" | "closed" | "all" = "open") {
    const rows = this.all(
      `SELECT m.*, c.name AS client_name, p.name AS practice_area, s.name AS stage_name,
         (SELECT COUNT(*) FROM tasks t WHERE t.matter_id = m.id AND t.status IN ('open','waiting')) AS open_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.matter_id = m.id AND t.status = 'open' AND t.due_date < ?) AS overdue_tasks,
         (SELECT MIN(t.due_date) FROM tasks t WHERE t.matter_id = m.id AND t.status = 'open') AS next_due
       FROM matters m LEFT JOIN contacts c ON c.id = m.client_id LEFT JOIN practice_areas p ON p.id = m.practice_area_id
       LEFT JOIN stages s ON s.id = m.stage_id
       ${status === "all" ? "" : "WHERE m.status = ?"}
       ORDER BY m.status, m.name`,
      ...(status === "all" ? [this.today()] : [this.today(), status]),
    );
    return rows;
  }

  getMatter(id: number) {
    const m = this.must(
      `SELECT m.*, c.name AS client_name, p.name AS practice_area FROM matters m
       LEFT JOIN contacts c ON c.id = m.client_id LEFT JOIN practice_areas p ON p.id = m.practice_area_id WHERE m.id = ?`,
      "Matter",
      id,
    );
    return {
      matter: m,
      stages: m.practice_area_id ? this.all("SELECT * FROM stages WHERE practice_area_id = ? ORDER BY position", m.practice_area_id) : [],
      roles: this.all("SELECT r.role, r.user_id, u.name FROM matter_roles r JOIN users u ON u.id = r.user_id WHERE r.matter_id = ? ORDER BY r.role", id),
      dates: this.all(
        "SELECT f.key, f.label, d.value FROM date_fields f LEFT JOIN matter_dates d ON d.field_key = f.key AND d.matter_id = ? ORDER BY f.label",
        id,
      ),
      checklists: this.all(
        `SELECT a.*, l.name,
           (SELECT COUNT(*) FROM tasks t WHERE t.application_id = a.id) AS total,
           (SELECT COUNT(*) FROM tasks t WHERE t.application_id = a.id AND t.status IN ('done','skipped')) AS finished
         FROM list_applications a JOIN task_lists l ON l.id = a.list_id WHERE a.matter_id = ? ORDER BY a.id`,
        id,
      ),
      tasks: this.taskRows("t.matter_id = ?", id),
      activity: this.all(
        `SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.matter_id = ? ORDER BY a.id DESC LIMIT 100`,
        id,
      ),
    };
  }

  listChecklists() {
    const lists = this.all(
      "SELECT l.*, p.name AS practice_area FROM task_lists l LEFT JOIN practice_areas p ON p.id = l.practice_area_id ORDER BY l.name",
    );
    for (const l of lists) {
      l.items = this.all("SELECT * FROM task_templates WHERE list_id = ? ORDER BY position", l.id).map((t) => ({
        id: t.id,
        key: t.key,
        title: t.title,
        description: t.description,
        role: t.role,
        anchor: t.anchor,
        offsetDays: t.offset_days,
        businessDays: !!t.business_days,
        dependsOn: JSON.parse(t.depends_on),
        priority: t.priority,
      }));
    }
    return lists;
  }

  setup() {
    const areas = this.all("SELECT * FROM practice_areas ORDER BY name");
    for (const a of areas) a.stages = this.all("SELECT * FROM stages WHERE practice_area_id = ? ORDER BY position", a.id);
    return {
      today: this.today(),
      users: this.all("SELECT * FROM users WHERE active = 1 ORDER BY name"),
      contacts: this.all("SELECT * FROM contacts ORDER BY name"),
      practiceAreas: areas,
      dateFields: this.all("SELECT * FROM date_fields ORDER BY label"),
      roles: this.all(
        "SELECT DISTINCT role FROM (SELECT default_role AS role FROM users UNION SELECT role FROM task_templates UNION SELECT role FROM matter_roles) WHERE role IS NOT NULL ORDER BY role",
      ).map((r) => r.role),
      holidays: this.all("SELECT * FROM holidays ORDER BY date"),
      automations: this.all(
        `SELECT a.*,
           CASE a.trigger WHEN 'stage_entered' THEN (SELECT name FROM stages WHERE id = a.trigger_ref) ELSE (SELECT name FROM task_lists WHERE id = a.trigger_ref) END AS trigger_name,
           CASE a.action WHEN 'apply_list' THEN (SELECT name FROM task_lists WHERE id = a.action_ref) ELSE (SELECT name FROM stages WHERE id = a.action_ref) END AS action_name
         FROM automations a ORDER BY a.id`,
      ),
    };
  }
}
