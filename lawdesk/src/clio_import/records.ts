// The common shape of everything imported, whether it came from a CSV file or the Clio API.
// The CSV reader (normalize.ts) and the API reader (api_map.ts) both produce these; the
// importer (importer.ts) only ever sees these.

import type { ISODate } from "../dates.ts";

/** A reference to something in Clio: by Clio ID (API, or a CSV with an ID column) or by name/number. */
export interface Ref {
  clioId?: string | null;
  name?: string | null;
}

export interface ContactRec {
  type: "contact";
  key: string;
  kind: "person" | "company";
  name: string;
  email: string | null;
  phone: string | null;
  /** Anything with no field of its own in Lawdesk (other emails, address, job title...). */
  extra: string[];
  notes: string | null;
}

export interface MatterRec {
  type: "matter";
  key: string;
  number: string | null;
  name: string;
  status: "open" | "closed";
  clioStatus: string | null;
  openedOn: ISODate | null;
  closedOn: ISODate | null;
  client: (Ref & { kind?: "person" | "company" }) | null;
  practiceArea: string | null;
  responsible: Ref | null;
  originating: Ref | null;
  extra: string[];
}

export interface TaskRec {
  type: "task";
  key: string;
  title: string;
  description: string | null;
  due: ISODate | null;
  done: boolean;
  completedOn: ISODate | null;
  priority: "low" | "normal" | "high";
  clioStatus: string | null;
  matter: Ref | null;
  assignee: Ref | null;
}

export interface EventRec {
  type: "event";
  key: string;
  title: string;
  allDay: boolean;
  /** All-day: YYYY-MM-DD. Timed: a UTC instant (2026-03-09T15:00:00Z). */
  start: string;
  end: string | null;
  location: string | null;
  notes: string | null;
  matter: Ref | null;
}

export interface ActivityRec {
  type: "activity";
  key: string;
  kind: "time" | "expense";
  clioType: string | null;
  date: ISODate;
  matter: Ref | null;
  user: Ref | null;
  description: string;
  /** Time: minutes worked. Expense: not used. */
  minutes: number;
  /** Time: hourly rate in cents (or the flat fee for a fixed-fee entry). Expense: unit cost. */
  rateCents: number | null;
  /** Clio's own total in cents, when the file or API gives one. */
  totalCents: number | null;
  /** Expense: total cost in cents. Fixed-fee time: the flat amount. */
  amountCents: number | null;
  flat: boolean;
  billable: boolean;
  billed: boolean;
  billNumber: string | null;
  code: string | null;
  receipt: string | null;
}

export interface TrustRec {
  type: "trust";
  key: string;
  client: string | null;
  matter: Ref | null;
  balanceCents: number;
  account: string | null;
  asOf: ISODate | null;
}

export interface UserRec {
  type: "user";
  key: string;
  name: string;
  email: string | null;
  active: boolean;
  role: string | null;
}

export type Rec = ContactRec | MatterRec | TaskRec | EventRec | ActivityRec | TrustRec | UserRec;

/** Problems found reading one row. Errors stop the row; warnings don't. */
export interface RowResult {
  line: number;
  rec: Rec | null;
  errors: string[];
  warnings: string[];
}
