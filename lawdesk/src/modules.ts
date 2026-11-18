// Every feature module the server mounts. Each one lives in src/<module>/ and exports
// `routes: Route[]` from routes.ts; a module with its own tables also passes the SCHEMA
// from its schema.ts, which the server runs when it opens the database.

import type { Route } from "./http.ts";
import { routes as tasksRoutes } from "./tasks/routes.ts";
import { routes as deadlinesRoutes } from "./deadlines/routes.ts";
import { routes as conflictsRoutes } from "./conflicts/routes.ts";
import { SCHEMA as CONFLICTS_SCHEMA } from "./conflicts/schema.ts";
import { routes as billingRoutes } from "./billing/routes.ts";
import { SCHEMA as BILLING_SCHEMA } from "./billing/schema.ts";
import { routes as documentsRoutes } from "./documents/routes.ts";
import { SCHEMA as DOCUMENTS_SCHEMA } from "./documents/schema.ts";
import { routes as calendarRoutes } from "./calendar/routes.ts";
import { SCHEMA as CALENDAR_SCHEMA } from "./calendar/schema.ts";
import { routes as reportsRoutes } from "./reports/routes.ts";
import { routes as emailRoutes } from "./email/routes.ts";
import { SCHEMA as EMAIL_SCHEMA } from "./email/schema.ts";
import { routes as trustRoutes } from "./trust/routes.ts";
import { SCHEMA as TRUST_SCHEMA } from "./trust/schema.ts";
import { routes as contactsRoutes } from "./contacts/routes.ts";
import { SCHEMA as CONTACTS_SCHEMA } from "./contacts/schema.ts";
import { routes as intakeRoutes } from "./intake/routes.ts";
import { SCHEMA as INTAKE_SCHEMA } from "./intake/schema.ts";
import { routes as clioImportRoutes } from "./clio_import/routes.ts";
import { SCHEMA as CLIO_IMPORT_SCHEMA } from "./clio_import/schema.ts";
import { routes as paymentsRoutes } from "./payments/routes.ts";
import { SCHEMA as PAYMENTS_SCHEMA } from "./payments/schema.ts";
import { routes as esignRoutes } from "./esign/routes.ts";
import { SCHEMA as ESIGN_SCHEMA } from "./esign/schema.ts";
import { routes as authRoutes } from "./auth/routes.ts";
import { SCHEMA as AUTH_SCHEMA } from "./auth/schema.ts";

export interface Module {
  name: string;
  routes: Route[];
  /** SQL run when the database is opened (CREATE TABLE IF NOT EXISTS ...). */
  schema?: string;
}

export const modules: Module[] = [
  { name: "tasks", routes: tasksRoutes },
  { name: "deadlines", routes: deadlinesRoutes },
  { name: "conflicts", routes: conflictsRoutes, schema: CONFLICTS_SCHEMA },
  { name: "billing", routes: billingRoutes, schema: BILLING_SCHEMA },
  { name: "documents", routes: documentsRoutes, schema: DOCUMENTS_SCHEMA },
  { name: "calendar", routes: calendarRoutes, schema: CALENDAR_SCHEMA },
  { name: "reports", routes: reportsRoutes },
  { name: "email", routes: emailRoutes, schema: EMAIL_SCHEMA },
  // After billing: trust entries refer to billing invoices and payments.
  { name: "trust", routes: trustRoutes, schema: TRUST_SCHEMA },
  { name: "contacts", routes: contactsRoutes, schema: CONTACTS_SCHEMA },
  { name: "intake", routes: intakeRoutes, schema: INTAKE_SCHEMA },
  { name: "clio_import", routes: clioImportRoutes, schema: CLIO_IMPORT_SCHEMA },
  // After billing and documents: their tables are referenced.
  { name: "payments", routes: paymentsRoutes, schema: PAYMENTS_SCHEMA },
  { name: "esign", routes: esignRoutes, schema: ESIGN_SCHEMA },
  // Sign-in, accounts and matter access. The server checks permissions before every route (src/auth/guard.ts).
  { name: "auth", routes: authRoutes, schema: AUTH_SCHEMA },
];
