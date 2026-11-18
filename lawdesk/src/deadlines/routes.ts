// API for the Kansas deadline calculator. Every response carries the disclaimer.

import type { Ctx, Route } from "../http.ts";
import { tx } from "../db.ts";
import { EngineError } from "../engine.ts";
import { Calendar } from "../calendar/calendar.ts";
import { DISCLAIMER, DeadlineError, computeDeadline, deadlineToTaskInput, weekday, type DeadlineResult } from "./compute.ts";
import { legalHolidays, SUPREME_COURT_ORDERS } from "./holidays.ts";
import { EVENT_TYPES, RULES, applyRule, deadlinesFor, ruleById, type DeadlineRule } from "./rules.ts";

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof DeadlineError || e instanceof RangeError) throw new EngineError(e.message, 400);
    throw e;
  }
}

export const routes: Route[] = [
  {
    method: "GET",
    path: "/deadlines/rules",
    handler: () => ({ disclaimer: DISCLAIMER, eventTypes: EVENT_TYPES, rules: RULES }),
  },
  {
    method: "GET",
    path: "/deadlines/holidays/:year",
    handler: (ctx) =>
      guard(() => ({
        disclaimer: DISCLAIMER,
        year: Number(ctx.params.year),
        holidays: legalHolidays(Number(ctx.params.year)),
        supremeCourtOrdersLoaded: SUPREME_COURT_ORDERS.map((o) => ({ order: o.order, url: o.url, covers: o.covers })),
      })),
  },
  {
    // Body: { trigger, days | hours, direction?, serviceMethod?, courtClosedDays?, extraHolidays?, timeZone? }
    //   or: { eventType, trigger, serviceMethod?, courtClosedDays?, extraHolidays? } to run the rules library.
    method: "POST",
    path: "/deadlines/compute",
    handler: (ctx) =>
      guard(() => {
        const b = ctx.body ?? {};
        if (b.ruleId !== undefined) {
          const { rule, result } = runRule(b);
          return { disclaimer: DISCLAIMER, rule, result };
        }
        if (b.eventType !== undefined) {
          const deadlines = deadlinesFor(b.eventType, b.trigger, {
            serviceMethod: b.serviceMethod,
            courtClosedDays: b.courtClosedDays,
            extraHolidays: b.extraHolidays,
          });
          return { disclaimer: DISCLAIMER, deadlines };
        }
        return { ...computeDeadline(b), disclaimer: DISCLAIMER };
      }),
  },
  {
    // Compute a deadline and put it on a matter in one step: an all-day (or, for an hours period,
    // timed) calendar event of kind court_deadline, source "deadlines", and a high-priority task
    // made by deadlineToTaskInput. The date is recomputed here, never taken from the client.
    // Body: the compute input ({ ruleId, trigger, serviceMethod?, courtClosedDays? } or a custom
    // { trigger, days | hours, direction? }) plus { matterId, title?, assigneeId?, attendees? }.
    method: "POST",
    path: "/deadlines/add-to-matter",
    handler: (ctx) => addToMatter(ctx),
  },
];

function runRule(b: any): { rule: DeadlineRule; result: DeadlineResult } {
  const rule = typeof b.ruleId === "string" ? ruleById(b.ruleId) : undefined;
  if (!rule) throw new EngineError(`Unknown rule "${b.ruleId}"`, 400);
  return applyRule(rule, b.trigger, { serviceMethod: b.serviceMethod || null, courtClosedDays: b.courtClosedDays, extraHolidays: b.extraHolidays });
}

function addToMatter(ctx: Ctx) {
  const b = ctx.body ?? {};
  const matterId = Number(b.matterId);
  if (!Number.isInteger(matterId) || matterId <= 0) throw new EngineError("Choose the matter to add this deadline to");
  const matter = ctx.db.prepare("SELECT id, name, number FROM matters WHERE id = ?").get(matterId) as any;
  if (!matter) throw new EngineError("Matter not found", 404);
  const { rule, result } = guard(() => {
    if (b.ruleId !== undefined) return runRule(b);
    const r = computeDeadline({
      trigger: b.trigger,
      days: b.days,
      hours: b.hours,
      direction: b.direction,
      serviceMethod: b.serviceMethod || null,
      courtClosedDays: b.courtClosedDays,
      extraHolidays: b.extraHolidays,
    });
    return { rule: null as DeadlineRule | null, result: r };
  });
  const custom = !rule;
  const title =
    typeof b.title === "string" && b.title.trim()
      ? b.title.trim().slice(0, 300)
      : rule
        ? `${rule.name} due`
        : `Deadline: ${b.days ? `${b.days} days` : `${b.hours} hours`} ${b.direction === "before" ? "before" : "after"} ${b.trigger}`;
  const assigneeId = b.assigneeId == null || b.assigneeId === "" ? null : Number(b.assigneeId);
  const attendees: number[] = Array.isArray(b.attendees) ? b.attendees : assigneeId ? [assigneeId] : [];
  const taskInput = deadlineToTaskInput(result, { title, matterId, assigneeId, priority: "high" });
  const actor = ctx.userId;
  const cal = new Calendar(ctx.db);
  return tx(ctx.db, () => {
    const sourceRef = custom ? `custom:${b.days ? `${b.days}d` : `${b.hours}h`}:${b.direction === "before" ? "before" : "after"}:${b.trigger}` : `${rule!.id}:${b.trigger}`;
    const { event, conflicts } = cal.createEvent(
      {
        title,
        matterId,
        kind: "court_deadline",
        source: "deadlines",
        sourceRef,
        allDay: !result.time,
        start: result.time ? `${result.date}T${result.time}` : result.date,
        end: result.time ? `${result.date}T${result.time}` : result.date,
        attendees,
        // A week and a day ahead (all-day reminders count back from the start of the day).
        reminders: result.time ? [10080, 1440, 120] : [10080, 1440],
        notes: taskInput.description,
      },
      actor,
    );
    const taskId = ctx.engine.addTask(taskInput, actor);
    const task = ctx.engine.getTask(taskId);
    return {
      disclaimer: DISCLAIMER,
      result,
      rule,
      event,
      task,
      conflicts,
      summary: `${title}: ${weekday(result.date)} ${result.date}${result.time ? ` at ${result.time}` : ""}, added to ${matter.number ? matter.number + " " : ""}${matter.name}`,
    };
  });
}
