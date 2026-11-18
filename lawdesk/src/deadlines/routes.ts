// API for the Kansas deadline calculator. Every response carries the disclaimer.

import type { Route } from "../http.ts";
import { EngineError } from "../engine.ts";
import { DISCLAIMER, DeadlineError, computeDeadline } from "./compute.ts";
import { legalHolidays, SUPREME_COURT_ORDERS } from "./holidays.ts";
import { EVENT_TYPES, RULES, deadlinesFor } from "./rules.ts";

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
];
