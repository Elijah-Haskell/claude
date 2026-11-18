// What each kind of Clio file can hold, and the column headings we recognise for it.
//
// Two sets of headings are recognised:
//   - Clio's own migration-template headings (first_name, open_date, activity_user, ...). These
//     are documented by Clio and listed with sources in docs/clio-import.md.
//   - Headings as they are likely to appear in Clio's "Excel ready CSV" exports and on-screen
//     column names ("Display Number", "Responsible Attorney", ...). Clio does not publish the
//     export column list, so these are best guesses. That is why every column can be re-assigned
//     by hand on the mapping step, and why an unrecognised heading is never a failure.

export type Kind = "contacts" | "matters" | "tasks" | "calendar" | "time" | "expenses" | "trust_balances";

export const KINDS: Kind[] = ["contacts", "matters", "tasks", "calendar", "time", "expenses", "trust_balances"];

export interface FieldDef {
  key: string;
  label: string;
  /** true = every row needs it. A string names a group where at least one field must be filled. */
  required?: boolean | string;
  help?: string;
  /** Headings that select this field automatically (compared without case, spaces or punctuation). */
  aliases: string[];
}

export interface KindDef {
  kind: Kind;
  label: string;
  /** Plain-English line for the screen. */
  about: string;
  /** Kinds that should be imported first. */
  after: Kind[];
  fields: FieldDef[];
}

const ID = (what: string): FieldDef => ({
  key: "clio_id",
  label: `Clio ${what} ID`,
  help: "If the file has Clio's ID number, re-importing updates the same record instead of adding another.",
  aliases: ["id", "clio id", `${what} id`, `${what}_id`],
});

const MATTER_REF: FieldDef[] = [
  {
    key: "matter",
    label: "Matter",
    help: "The matter number (or name) as it appears in Clio.",
    aliases: ["matter", "matter number", "display number", "display_number", "matter display number", "matter name", "matter description"],
  },
  { key: "matter_clio_id", label: "Clio matter ID", aliases: ["matter id", "matter_id", "matter clio id"] },
];

export const KIND_DEFS: Record<Kind, KindDef> = {
  contacts: {
    kind: "contacts",
    label: "Contacts",
    about: "People and companies. Import these first, so matters can find their clients.",
    after: [],
    fields: [
      ID("contact"),
      { key: "type", label: "Person or company", aliases: ["type", "contact type"] },
      { key: "name", label: "Full name", required: "name", aliases: ["name", "full name", "display name", "contact name", "contact"] },
      { key: "first_name", label: "First name", required: "name", aliases: ["first_name", "first name", "given name"] },
      { key: "middle_name", label: "Middle name", aliases: ["middle_name", "middle name"] },
      { key: "last_name", label: "Last name", required: "name", aliases: ["last_name", "last name", "surname", "family name"] },
      { key: "company", label: "Company", required: "name", aliases: ["company", "company name", "company_name", "organization", "organisation", "business name"] },
      { key: "title", label: "Title (Mr., Dr.)", aliases: ["title", "prefix", "salutation"] },
      { key: "job_title", label: "Job title", aliases: ["job_title", "job title", "position"] },
      { key: "email", label: "Email", aliases: ["email_address", "email", "email address", "primary email", "primary email address", "primary_email_address", "e-mail"] },
      { key: "email2", label: "Other email", aliases: ["secondary email", "secondary email address", "secondary_email_address", "other email"] },
      { key: "phone", label: "Phone", aliases: ["primary_phone", "primary phone", "phone", "phone number", "primary phone number", "primary_phone_number", "business phone", "work phone"] },
      { key: "phone2", label: "Other phone", aliases: ["secondary phone", "secondary phone number", "secondary_phone_number", "mobile", "mobile phone", "cell", "home phone"] },
      { key: "street", label: "Street address", aliases: ["business_street", "business street", "street", "address", "street address", "address street", "primary address street", "address line 1"] },
      { key: "city", label: "City", aliases: ["business_city", "business city", "city", "address city", "primary address city"] },
      { key: "state", label: "State", aliases: ["business_state", "business state", "state", "province", "address state", "primary address state", "state/province"] },
      { key: "postal_code", label: "ZIP code", aliases: ["business_postal_code", "business postal code", "postal code", "postal_code", "zip", "zip code", "address zip", "primary address postal code"] },
      { key: "country", label: "Country", aliases: ["country", "business country", "address country"] },
      { key: "notes", label: "Notes", aliases: ["notes", "note", "contact notes"] },
    ],
  },
  matters: {
    kind: "matters",
    label: "Matters",
    about: "Files and cases. Import after contacts. The responsible attorney becomes the matter's attorney.",
    after: ["contacts"],
    fields: [
      ID("matter"),
      { key: "number", label: "Matter number", aliases: ["custom_number", "display_number", "display number", "matter number", "number", "matter #", "file number"] },
      { key: "name", label: "Matter name (Clio's description)", required: true, aliases: ["description", "matter description", "matter name", "name", "matter"] },
      { key: "client_name", label: "Client", required: "client", aliases: ["client", "client name", "client display name"] },
      { key: "client_first_name", label: "Client first name", required: "client", aliases: ["client_first_name", "client first name"] },
      { key: "client_last_name", label: "Client last name", required: "client", aliases: ["client_last_name", "client last name"] },
      { key: "client_company_name", label: "Client company", required: "client", aliases: ["client_company_name", "client company name", "client company"] },
      { key: "client_clio_id", label: "Clio client ID", aliases: ["client id", "client_id"] },
      { key: "status", label: "Status (Open, Pending, Closed)", aliases: ["status", "matter status"] },
      { key: "practice_area", label: "Practice area", aliases: ["practice_area", "practice area", "area of law", "practice area name"] },
      { key: "open_date", label: "Open date", aliases: ["open_date", "open date", "opened", "opened date", "date opened"] },
      { key: "close_date", label: "Close date", aliases: ["close_date", "close date", "closed", "closed date", "date closed"] },
      { key: "pending_date", label: "Pending date", aliases: ["pending_date", "pending date"] },
      { key: "responsible_attorney", label: "Responsible attorney", aliases: ["responsible_attorney", "responsible attorney", "responsible lawyer", "responsible solicitor"] },
      { key: "originating_attorney", label: "Originating attorney", aliases: ["originating_attorney", "originating attorney", "originating lawyer", "originating solicitor"] },
      { key: "location", label: "Location", aliases: ["location"] },
      { key: "client_reference", label: "Client reference", aliases: ["client_reference", "client reference", "client reference number"] },
      { key: "note", label: "Notes", aliases: ["note", "notes", "matter notes"] },
    ],
  },
  tasks: {
    kind: "tasks",
    label: "Tasks",
    about: "To-dos. Import after matters and people.",
    after: ["matters"],
    fields: [
      ID("task"),
      { key: "title", label: "Task", required: true, aliases: ["subject", "name", "task name", "title", "task"] },
      { key: "description", label: "Details", aliases: ["description", "task description", "detail", "details"] },
      { key: "due", label: "Due date", aliases: ["due_date", "due date", "due_at", "due at", "due"] },
      { key: "complete", label: "Done (1 or 0)", aliases: ["complete", "completed", "is complete", "done"] },
      { key: "status", label: "Status", aliases: ["status", "task status"] },
      { key: "completed_at", label: "Date finished", aliases: ["completed_at", "completed at", "completed date", "completed on", "date completed"] },
      { key: "priority", label: "Priority", aliases: ["priority"] },
      { key: "assignee", label: "Assigned to", aliases: ["assignee", "assigned to", "assignee name", "assigned user", "responsible"] },
      { key: "assignee_clio_id", label: "Clio assignee ID", aliases: ["assignee id", "assignee_id"] },
      ...MATTER_REF,
    ],
  },
  calendar: {
    kind: "calendar",
    label: "Calendar",
    about: "Appointments and court dates. Import after matters.",
    after: ["matters"],
    fields: [
      ID("calendar entry"),
      { key: "title", label: "Title", required: true, aliases: ["subject", "summary", "title", "name", "event"] },
      { key: "start_date", label: "Start date", required: true, aliases: ["start_date", "start date", "start", "start at", "start_at", "starts", "date"] },
      { key: "start_time", label: "Start time", aliases: ["start_time", "start time"] },
      { key: "end_date", label: "End date", aliases: ["end_date", "end date", "end", "end at", "end_at", "ends"] },
      { key: "end_time", label: "End time", aliases: ["end_time", "end time"] },
      { key: "all_day", label: "All day", aliases: ["all_day", "all day", "all-day", "is all day"] },
      { key: "location", label: "Location", aliases: ["location", "where"] },
      { key: "description", label: "Notes", aliases: ["description", "notes", "details"] },
      ...MATTER_REF,
    ],
  },
  time: {
    kind: "time",
    label: "Time entries",
    about: "Hours recorded in Clio. Unbilled time becomes ready to bill here; billed time is kept as history.",
    after: ["matters"],
    fields: [
      ID("activity"),
      { key: "type", label: "Entry type", help: "TimeEntry, ExpenseEntry, FixedFee... Rows marked as expenses are imported as expenses.", aliases: ["type", "activity type", "entry type"] },
      { key: "date", label: "Date", required: true, aliases: ["date", "activity date", "entry date"] },
      ...MATTER_REF,
      { key: "user", label: "Timekeeper", required: true, aliases: ["activity_user", "user", "user name", "timekeeper", "firm user", "billed by"] },
      { key: "user_clio_id", label: "Clio user ID", aliases: ["user id", "user_id"] },
      { key: "description", label: "Description", aliases: ["note", "notes", "narrative", "description", "entry description"] },
      { key: "activity_category", label: "Activity category", aliases: ["activity_description", "activity description", "activity category", "category"] },
      { key: "hours", label: "Hours", aliases: ["quantity", "hours", "quantity in hours", "quantity_in_hours", "duration", "time"] },
      { key: "rate", label: "Rate", aliases: ["price", "rate", "hourly rate"] },
      { key: "total", label: "Amount", help: "Clio's total for the entry. Used for the reconciliation report.", aliases: ["total", "amount", "total amount", "value"] },
      { key: "non_billable", label: "Non-billable", aliases: ["non_billable", "non-billable", "nonbillable", "no charge"] },
      { key: "billable", label: "Billable", aliases: ["billable"] },
      { key: "billed", label: "Billed", help: "Billed, Unbilled, or yes/no.", aliases: ["billed", "bill status", "billing status", "invoice status", "bill state"] },
      { key: "bill_number", label: "Bill number", aliases: ["bill number", "bill", "invoice number", "invoice", "bill #"] },
      { key: "utbms_activity_code", label: "UTBMS activity code", aliases: ["utbms_activity_code", "utbms activity code", "activity code"] },
      { key: "utbms_task_code", label: "UTBMS task code", aliases: ["utbms_task_code", "utbms task code", "task code"] },
      { key: "utbms_expense_code", label: "UTBMS expense code", aliases: ["utbms_expense_code", "utbms expense code", "expense code"] },
      { key: "expense_type", label: "Expense type", aliases: ["expense_type", "expense type", "expense category", "cost type"] },
      { key: "vendor_name", label: "Vendor", aliases: ["vendor_name", "vendor", "vendor name", "payee"] },
      { key: "reference", label: "Reference", aliases: ["reference", "receipt", "receipt number", "check number"] },
    ],
  },
  expenses: {
    kind: "expenses",
    label: "Expense entries",
    about: "Costs recorded in Clio (filing fees, copies). Unbilled costs become ready to bill; billed costs are kept as history.",
    after: ["matters"],
    fields: [], // filled below: the same columns as time entries
  },
  trust_balances: {
    kind: "trust_balances",
    label: "Trust balances (report only)",
    about:
      "Each matter's trust balance from Clio's trust report. Nothing is posted to trust: the balances are listed for the accountant to check and sign off before they are entered.",
    after: ["matters"],
    fields: [
      { key: "client", label: "Client", aliases: ["client", "client name", "contact"] },
      ...MATTER_REF,
      { key: "balance", label: "Trust balance", required: true, aliases: ["trust balance", "client account balance", "trust account balance", "trust funds", "balance", "trust"] },
      { key: "account", label: "Bank account", aliases: ["account", "bank account", "trust account", "client account"] },
      { key: "as_of", label: "As of date", aliases: ["as of", "as of date", "date", "balance date"] },
    ],
  },
};
KIND_DEFS.expenses.fields = KIND_DEFS.time.fields.map((f) => (f.key === "user" ? { ...f, required: false } : f.key === "hours" ? { ...f, label: "Quantity", help: "Blank counts as 1." } : f));

/** Headings compared without case, spaces, underscores or punctuation. */
export function headingKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9#]+/g, "");
}

/**
 * Guess which column holds each field. Each column is used at most once; an exact heading match
 * wins over a later field's looser claim. Returns { fieldKey: columnIndex }.
 */
export function guessMapping(kind: Kind, headers: string[]): Record<string, number> {
  const fields = KIND_DEFS[kind].fields;
  const keys = headers.map(headingKey);
  const used = new Set<number>();
  const out: Record<string, number> = {};
  // Pass 1: alias order matters (first alias = the strongest name for the field), so walk aliases by rank.
  const maxAliases = Math.max(...fields.map((f) => f.aliases.length));
  for (let rank = 0; rank < maxAliases; rank++) {
    for (const f of fields) {
      if (f.key in out) continue;
      const a = f.aliases[rank];
      if (!a) continue;
      const i = keys.findIndex((k, idx) => !used.has(idx) && k === headingKey(a));
      if (i >= 0) {
        out[f.key] = i;
        used.add(i);
      }
    }
  }
  return out;
}

/** Check a mapping from the screen: known fields, real columns, no column used twice. */
export function checkMapping(kind: Kind, headers: string[], mapping: unknown): Record<string, number> {
  const fields = new Set(KIND_DEFS[kind].fields.map((f) => f.key));
  const out: Record<string, number> = {};
  if (!mapping || typeof mapping !== "object") return out;
  for (const [k, v] of Object.entries(mapping as Record<string, unknown>)) {
    if (!fields.has(k) || v == null || v === "") continue;
    const i = Number(v);
    if (!Number.isInteger(i) || i < 0 || i >= headers.length) throw Object.assign(new Error(`Column ${v} for ${k} is not in the file`), { status: 400 });
    out[k] = i;
  }
  return out;
}

/** Fields that are required (or required-as-a-group) but have no column. */
export function missingRequired(kind: Kind, mapping: Record<string, number>): string[] {
  const missing: string[] = [];
  const groups = new Map<string, FieldDef[]>();
  for (const f of KIND_DEFS[kind].fields) {
    if (f.required === true && !(f.key in mapping)) missing.push(f.label);
    else if (typeof f.required === "string") groups.set(f.required, [...(groups.get(f.required) ?? []), f]);
  }
  for (const fs of groups.values()) if (!fs.some((f) => f.key in mapping)) missing.push(fs.map((f) => f.label).join(" or "));
  return missing;
}
