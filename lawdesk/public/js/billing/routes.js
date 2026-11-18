// Billing pages for the app router. app.js spreads BILLING_ROUTES into ROUTES.

import { timeView } from "./time.js";
import { expensesView } from "./expenses.js";
import { invoicesView } from "./invoices.js";
import { invoiceView } from "./invoice.js";
import { paymentsView } from "./payments.js";
import { statementView } from "./statements.js";
import { billingSettingsView } from "./settings.js";

const toTime = (_m, ctx) => {
  history.replaceState(null, "", "#/billing/time");
  return timeView([], ctx);
};

export const BILLING_ROUTES = [
  [/^#\/billing\/?$/, () => toTime],
  [/^#\/billing\/time$/, () => timeView],
  [/^#\/billing\/expenses$/, () => expensesView],
  [/^#\/billing\/invoices$/, () => invoicesView],
  [/^#\/billing\/invoices\/(\d+)$/, () => invoiceView],
  [/^#\/billing\/payments(?:\?.*)?$/, () => paymentsView],
  [/^#\/billing\/statements(?:\/(\d+))?(?:\?.*)?$/, () => statementView],
  [/^#\/billing\/settings$/, () => billingSettingsView],
];
