# Clio feature parity checklist

What Clio Manage and Clio Grow do, and where Lawdesk stands on each. The Clio column is paraphrased
from the cited pages (collected 2026-11-18 from search results over Clio's help center, pricing
pages and trade press; Clio's own site was not reachable from the build environment, so plan
details may need checking against the firm's account).

Status: **Built** (code and tests merged) · **Building** (in the current wave) · **Next** (planned) ·
**Not planned** (with the reason).

## Tasks and workflow

| Clio feature | Source | Lawdesk |
|---|---|---|
| Tasks with assignee, due date, matter, time tracked against them | [Manage Tasks](https://help.clio.com/hc/en-us/articles/9204917906971-Manage-Tasks-in-Clio-Manage) | Built; time against tasks: Building (billing screens) |
| Task types, status, time estimate | [Advanced Tasks](https://help.clio.com/hc/en-us/articles/9205859328923-Advanced-Tasks-Task-Types-Status-and-Estimate) | Next (task types and estimates) |
| Task lists (templates) assigned as a group | [Task Lists](https://help.clio.com/hc/en-150/articles/9206286672155-Task-Lists) | Built, and better: edits can update tasks already on matters |
| Task dependencies | (help article exists, contents not seen) | Built: tasks wait on others and date themselves when those finish |
| Matter stages board, up to 15 stages per practice area | [Matter Stages](https://help.clio.com/hc/en-us/articles/15083241879195-Matter-Stages) | Built (stage bar); kanban board view: Next |
| Automated workflow: stage change assigns a task list | [Automated Workflows](https://help.clio.com/hc/en-us/articles/35132279298843-Clio-Manage-Automated-Workflows) | Built, plus "checklist finished moves the stage" |

## Matters, contacts and permissions

| Clio feature | Source | Lawdesk |
|---|---|---|
| Conflict check while creating a matter, linked to the matter | [Create Matters](https://help.clio.com/hc/en-us/articles/9285959663131-Create-Matters) | Engine Built (name variants, related companies, audit trail); screens and new-matter step: Building |
| Custom fields on contacts and matters | [Custom Fields](https://help.clio.com/hc/en-us/articles/9285493193115-Get-Started-With-Custom-Fields) | Matter date fields Built; general custom fields: Next |
| Matter permissions (restrict to users) and custom roles | [Matter Permissions](https://help.clio.com/hc/en-us/articles/9286062516123-Matter-Permissions-and-Rates), [Custom Roles](https://help.clio.com/hc/en-us/articles/40062980685467-Overview-of-Custom-Role-Permissions) | Building (sign-in, roles, restricted matters) |
| Matter budgets with threshold alerts | [Matter's Dashboard](https://help.clio.com/hc/en-us/articles/16681289917595-Matter-s-Dashboard) | Next |

## Calendar and deadlines

| Clio feature | Source | Lawdesk |
|---|---|---|
| Court-rules deadlines (50 states, 2,300 jurisdictions), recalculating on trigger change | [Clio blog](https://www.clio.com/blog/rules-based-calendaring-software-law-firms/) | Kansas only, by design: K.S.A. 60-206 and 17 rules Built; screens Building |
| AI extraction of deadlines from court documents | [Clio calendaring](https://www.clio.com/features/legal-calendaring-software/) | Next (AI features, needs an AI provider key) |
| Firm, task and statute-of-limitations calendars; Google/Office 365 sync | [Calendar Settings](https://help.clio.com/hc/en-au/articles/9290016489883-Calendar-Set-Up-and-Settings) | Calendar and subscribe-by-link feed Built; screens Building; two-way Google/Outlook sync: Next (needs OAuth app registration) |

## Documents

| Clio feature | Source | Lawdesk |
|---|---|---|
| Storage, version history, full-text search | [Manage Documents](https://help.clio.com/hc/en-us/articles/14983923587867-Manage-Documents-in-Clio-Manage) | Built; screens and real uploads Building |
| Clio Drive / Launcher: open in Word and save back | [Clio Manage](https://www.clio.com/manage/) | Next (desktop helper; a different kind of build) |
| Templates with merge fields; signed copies saved back | [Get Started with Documents](https://help.clio.com/hc/en-us/articles/55085715266587-Get-Started-with-Documents) | Word template filling Built; e-signature Building |
| Combine documents: cover page, table of contents, Bates numbering | [Combine Documents](https://help.clio.com/hc/en-us/articles/43337504015387-Combine-or-Replace-Documents) | Next |
| Clio Draft: court form libraries for all 50 states | [Workflow automation](https://www.clio.com/features/legal-workflow-automation-software/) | Not planned beyond Kansas forms the firm uploads as templates |

## Time, billing and payments

| Clio feature | Source | Lawdesk |
|---|---|---|
| Hourly, flat and contingency fees | [Clio pricing](https://www.clio.com/pricing/) | Built |
| Time entries from documents, events, tasks, communications; timers | [Time Entries](https://help.clio.com/hc/en-au/articles/9289741706779-Time-Entries) | Timers and task-linked time Built; screens Building |
| LEDES 1998B/1998BI/XML export, UTBMS codes | [LEDES](https://help.clio.com/hc/en-us/articles/14078113389723-LEDES-Bills), [UTBMS](https://help.clio.com/hc/en-us/articles/9289762435099-UTBMS-Codes) | Next |
| Payment plans, interest, grace periods, early-payment discounts, automatic reminders | [Bill Settings](https://help.clio.com/hc/en-us/articles/14078692470427-Configure-General-Bill-Settings) | Next |
| Card and eCheck payments | [Clio pricing](https://www.clio.com/pricing/) | Building (Stripe-style provider plus a working test mode) |

## Trust and accounting

| Clio feature | Source | Lawdesk |
|---|---|---|
| Per-client, per-matter trust ledgers, three-way reconciliation | [Reconciliation](https://help.clio.com/hc/en-us/articles/21058568234267-Clio-Accounting-Operating-and-Trust-Reconciliation) | Building, to the Kansas handbook; needs accountant review before real use |
| Bank feeds (Plaid) and statement upload | [Banking](https://help.clio.com/hc/en-us/articles/21004158222235-Clio-Accounting-Banking) | Statement upload: Next; Plaid needs a paid account |
| Sync to QuickBooks or Xero | [Integrations](https://www.clio.com/features/integrations/) | Next (export first, live sync needs their app approval) |
| Full double-entry general ledger (Clio Accounting) | [Legal accounting](https://www.clio.com/features/legal-accounting-software/) | Not planned yet; keep QuickBooks for the firm's books |

## Client communication

| Clio feature | Source | Lawdesk |
|---|---|---|
| Client portal: secure messages, shared documents and bills | [Clio for Clients](https://www.clio.com/clients/) | Next (starts as soon as sign-in is merged) |
| Text messaging from a firm number | [Text Messaging](https://support.clio.com/hc/en-us/articles/5933926010523-Text-Messaging-in-Clio) | Next (needs a texting provider and carrier registration) |
| Email and call logs, Outlook/Gmail, per-matter Maildrop address | [Communicating](https://support.clio.com/hc/en-us/articles/115001166674-New-Clio-Experience-Communicating-with-Clients-and-Colleagues-) | Building (sending, logs, saved-email import); Maildrop needs a mail server: Next |

## Intake and CRM (Clio Grow)

| Clio feature | Source | Lawdesk |
|---|---|---|
| Intake forms, lead pipeline, e-signed retainers, appointment booking, email follow-ups | [Clio Grow](https://www.clio.com/ie/grow/) | Building |

## Reporting

| Clio feature | Source | Lawdesk |
|---|---|---|
| Billing, matter, client, revenue, productivity and trust reports; saved presets; scheduled runs | [Reports](https://help.clio.com/hc/en-us/articles/9290078155803-Clio-Manage-Reports-Presets-and-History) | Building (dashboard and reports); scheduled runs: Next |
| Custom report builder | [Custom Report Datasets](https://help.clio.com/hc/en-us/articles/57057959562011-Custom-Reports-Available-Datasets) | Next |

## AI

| Clio feature | Source | Lawdesk |
|---|---|---|
| Manage AI: draft bills and client updates, documents to deadlines and tasks | [AI Features](https://help.clio.com/hc/en-us/articles/41990965598491-AI-Features-in-Clio-Manage) | Next (needs an AI provider key and a firm on/off switch) |
| Clio Work / Vincent: cited legal research on the vLex library | [LawNext](https://www.lawnext.com/2026/04/clio-work-clios-ai-workspace-is-now-available-to-solo-and-smaller-law-firms-as-a-standalone-product.html) | Not planned: the research library is a licensed dataset |
| Agents that generate task roadmaps | [Artificial Lawyer](https://www.artificiallawyer.com/2026/04/08/clio-rolls-out-agents-for-work-and-vincent/) | Next, together with AI features |

## Platform

| Clio feature | Source | Lawdesk |
|---|---|---|
| Moving data in from Clio | [Rate limits](https://docs.developers.clio.com/api-docs/rate-limits) | Building (CSV import and API import) |
| 300+ app integrations, Zapier, API with webhooks | [Integrations](https://www.clio.com/integrations/) | Our own API exists; webhooks and Zapier: Next |
| Mobile apps | (no source found) | Works at phone width now; installable phone app: Next |
| Court e-filing (Texas and Georgia only) | [Clio pricing](https://www.clio.com/pricing/) | Not planned: Kansas filing goes through the state's own system |
| SOC 2 Type II and SOC 1 audits, HIPAA option, US/Canada hosting | [Clio security](https://www.clio.com/ca/security/) | Not yet: needs hosting decided first, then an audit if the firm wants one |
