// Every feature module the server mounts. Each one lives in src/<module>/ and exports
// `routes: Route[]` from routes.ts; a module with its own tables also passes the SCHEMA
// from its schema.ts, which the server runs when it opens the database.

import type { Route } from "./http.ts";
import { routes as tasksRoutes } from "./tasks/routes.ts";

export interface Module {
  name: string;
  routes: Route[];
  /** SQL run when the database is opened (CREATE TABLE IF NOT EXISTS ...). */
  schema?: string;
}

export const modules: Module[] = [
  { name: "tasks", routes: tasksRoutes },
  // e.g. { name: "billing", routes: billingRoutes, schema: BILLING_SCHEMA },
];
