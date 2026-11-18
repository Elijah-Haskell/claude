// A small library of Kansas civil (Chapter 60) deadlines, each read from the source text.
// Only rules whose text was actually read are here; see docs/deadlines.md for what is missing.
//
// serviceAdjustment says whether K.S.A. 60-206(d) (3 more days after service by mail or by leaving
// with the clerk) can apply:
//   "yes"       the period runs "after being served" with a paper that is served under K.S.A. 60-205;
//   "no"        the period does not run from 60-205 service (e.g. from entry of judgment, from
//               service of the summons and petition, or counted back from a hearing);
//   "uncertain" the text does not settle it. The calculator does NOT add the days and warns instead,
//               because adding days that do not apply would give a deadline that is too late.

import type { ISODate } from "../dates.ts";
import { type ComputeInput, type DeadlineResult, type Direction, type ServiceMethod, DeadlineError, computeDeadline } from "./compute.ts";

export type ServiceAdjustment = "yes" | "no" | "uncertain";

export interface DeadlineRule {
  id: string;
  name: string;
  /** Event type key used by deadlinesFor. */
  trigger: EventType;
  /** Plain-English description of the trigger. */
  triggerLabel: string;
  days: number;
  direction: Direction;
  serviceAdjustment: ServiceAdjustment;
  citation: string;
  url: string;
  /** The operative words of the source. */
  quote: string;
  notes?: string;
}

export const EVENT_TYPES = {
  served_summons_and_petition: "Defendant served with the summons and petition",
  served_counterclaim_or_crossclaim: "Party served with a pleading stating a counterclaim or crossclaim",
  served_order_to_reply: "Party served with an order to reply to an answer",
  notice_of_ruling_on_60_212_motion: "Notice of the court's denial or postponement of a K.S.A. 60-212 motion",
  served_interrogatories: "Party served with interrogatories",
  served_production_request: "Party served with a request for production",
  served_admission_requests: "Party served with requests for admission",
  served_motion: "Party served with a motion (no statute or rule sets another time)",
  served_summary_judgment_motion: "Party served with a motion for summary judgment",
  served_summary_judgment_response: "Movant served with the response to its summary judgment motion",
  entry_of_judgment: "Entry of judgment",
  served_new_trial_motion: "Party served with a motion for new trial",
  served_notice_of_appeal: "Appellee served with a notice of appeal (and it is filed)",
  hearing_date: "Date set for a motion hearing",
} as const;

export type EventType = keyof typeof EVENT_TYPES;

const U = {
  "60-206": "https://ksrevisor.gov/statutes/chapters/ch60/060_002_0006.html",
  "60-212": "https://ksrevisor.gov/statutes/chapters/ch60/060_002_0012.html",
  "60-233": "https://ksrevisor.gov/statutes/chapters/ch60/060_002_0033.html",
  "60-234": "https://ksrevisor.gov/statutes/chapters/ch60/060_002_0034.html",
  "60-236": "https://ksrevisor.gov/statutes/chapters/ch60/060_002_0036.html",
  "60-259": "https://ksrevisor.gov/statutes/chapters/ch60/060_002_0059.html",
  "60-2103": "https://ksrevisor.gov/statutes/chapters/ch60/060_021_0003.html",
  r133: "https://16jd.kscourts.gov/KSCourts/media/KsCourts/Rules/Rule-133.pdf?ext=.pdf",
  r141: "https://6jd.kscourts.gov/Rules-Orders/Rules/Summary-Judgment",
};

const SCR_NOTE =
  "This period is set by a Kansas Supreme Court rule. K.S.A. 60-206(a) applies to periods in Chapter 60, local rules, court " +
  "orders, statutes and administrative regulations; it does not name Supreme Court rules, so confirm the computation method. " +
  "Whether the 60-206(d) mail days apply was not verified, so they are not added.";

export const RULES: DeadlineRule[] = [
  {
    id: "answer-petition",
    name: "Answer to petition",
    trigger: "served_summons_and_petition",
    triggerLabel: EVENT_TYPES.served_summons_and_petition,
    days: 21,
    direction: "after",
    serviceAdjustment: "no",
    citation: "K.S.A. 60-212(a)(1)(A)(i)",
    url: U["60-212"],
    quote: "A defendant must serve an answer: (i) Within 21 days after being served with the summons and petition",
    notes:
      "The summons and petition are served as process, not under K.S.A. 60-205(b)(2), so 60-206(d) does not add days. " +
      "Service by publication follows 60-212(a)(1)(A)(ii) (the time in the notice, at least 41 days from first publication) and is not computed here. " +
      "Serving a 60-212 motion changes the time (60-212(a)(2)). A different statute can set another time (\"Unless otherwise provided by law\").",
  },
  {
    id: "answer-counterclaim",
    name: "Answer to counterclaim or crossclaim",
    trigger: "served_counterclaim_or_crossclaim",
    triggerLabel: EVENT_TYPES.served_counterclaim_or_crossclaim,
    days: 21,
    direction: "after",
    serviceAdjustment: "yes",
    citation: "K.S.A. 60-212(a)(1)(B)",
    url: U["60-212"],
    quote: "a party must serve an answer to a counterclaim or crossclaim within 21 days after being served with the pleading that states the counterclaim or crossclaim",
  },
  {
    id: "reply-to-answer",
    name: "Reply to an answer (when ordered)",
    trigger: "served_order_to_reply",
    triggerLabel: EVENT_TYPES.served_order_to_reply,
    days: 21,
    direction: "after",
    serviceAdjustment: "uncertain",
    citation: "K.S.A. 60-212(a)(1)(C)",
    url: U["60-212"],
    quote: "a party must serve a reply to an answer within 21 days after being served with an order to reply, unless the order specifies a different time",
    notes: "Use the time in the order if it sets one. How the order is served decides whether 60-206(d) applies; not added here.",
  },
  {
    id: "responsive-pleading-after-motion",
    name: "Responsive pleading after a 60-212 motion is denied or postponed",
    trigger: "notice_of_ruling_on_60_212_motion",
    triggerLabel: EVENT_TYPES.notice_of_ruling_on_60_212_motion,
    days: 14,
    direction: "after",
    serviceAdjustment: "uncertain",
    citation: "K.S.A. 60-212(a)(2)(A)",
    url: U["60-212"],
    quote:
      "Unless the court sets a different time, serving a motion under this section alters these periods as follows: (A) If the court denies " +
      "the motion or postpones its disposition until trial, the responsive pleading must be served within 14 days after notice of the court's action",
    notes: "The period runs from \"notice\", not from being served, so 60-206(d) days are not added. A motion for a more definite statement that is granted runs 14 days from service of the more definite statement (60-212(a)(2)(B)).",
  },
  {
    id: "interrogatory-answers",
    name: "Answers and objections to interrogatories",
    trigger: "served_interrogatories",
    triggerLabel: EVENT_TYPES.served_interrogatories,
    days: 30,
    direction: "after",
    serviceAdjustment: "yes",
    citation: "K.S.A. 60-233(b)(2)",
    url: U["60-233"],
    quote:
      "The responding party must serve its answers and any objections within 30 days after being served with the interrogatories except that a " +
      "defendant may serve answers or objections within 45 days after being served with process.",
    notes: "A defendant may take until 45 days after being served with process, if that is later; compute that separately from the service-of-process date. Parties may stipulate to other times (K.S.A. 60-229).",
  },
  {
    id: "production-response",
    name: "Response to request for production",
    trigger: "served_production_request",
    triggerLabel: EVENT_TYPES.served_production_request,
    days: 30,
    direction: "after",
    serviceAdjustment: "yes",
    citation: "K.S.A. 60-234(b)(2)(A)",
    url: U["60-234"],
    quote:
      "The party to whom the request is directed must respond in writing within 30 days after being served, except that a defendant may " +
      "serve a response within 45 days after being served with process. A shorter or longer time may be stipulated to under K.S.A. 60-229",
    notes: "A defendant may take until 45 days after being served with process, if that is later; compute that separately.",
  },
  {
    id: "admission-responses",
    name: "Answers or objections to requests for admission",
    trigger: "served_admission_requests",
    triggerLabel: EVENT_TYPES.served_admission_requests,
    days: 30,
    direction: "after",
    serviceAdjustment: "yes",
    citation: "K.S.A. 60-236(a)(3)",
    url: U["60-236"],
    quote:
      "A matter is admitted unless, within 30 days after being served, the party to whom the request is directed serve on the requesting party " +
      "a written answer or objection ... except that a defendant may serve answers or objections within 45 days after being served with process.",
    notes: "Missing this deadline admits the matter. A defendant may take until 45 days after being served with process, if later. The time may be changed by stipulation (60-229) or court order.",
  },
  {
    id: "motion-response",
    name: "Response to a motion (general)",
    trigger: "served_motion",
    triggerLabel: EVENT_TYPES.served_motion,
    days: 7,
    direction: "after",
    serviceAdjustment: "uncertain",
    citation: "Kansas Supreme Court Rule 133(b)",
    url: U.r133,
    quote:
      "Except as otherwise provided by statute or these rules, the response must be filed no later than 7 days after service of the motion or as otherwise provided by the court.",
    notes: SCR_NOTE + " Many judicial districts have local rules on motion practice; check them.",
  },
  {
    id: "summary-judgment-response",
    name: "Response to motion for summary judgment",
    trigger: "served_summary_judgment_motion",
    triggerLabel: EVENT_TYPES.served_summary_judgment_motion,
    days: 21,
    direction: "after",
    serviceAdjustment: "uncertain",
    citation: "Kansas Supreme Court Rule 141(b)(2)",
    url: U.r141,
    quote: "no later than 21 days after service of the motion, unless the time is extended by local rule or court order.",
    notes: SCR_NOTE,
  },
  {
    id: "summary-judgment-reply",
    name: "Reply in support of summary judgment",
    trigger: "served_summary_judgment_response",
    triggerLabel: EVENT_TYPES.served_summary_judgment_response,
    days: 14,
    direction: "after",
    serviceAdjustment: "uncertain",
    citation: "Kansas Supreme Court Rule 141(c)",
    url: U.r141,
    quote: "Any reply must be filed and served ... no later than 14 days after service of the response, unless the time is extended by local rule or court order.",
    notes: SCR_NOTE,
  },
  {
    id: "new-trial-motion",
    name: "Motion for new trial",
    trigger: "entry_of_judgment",
    triggerLabel: EVENT_TYPES.entry_of_judgment,
    days: 28,
    direction: "after",
    serviceAdjustment: "no",
    citation: "K.S.A. 60-259(b)",
    url: U["60-259"],
    quote: "A motion for a new trial must be filed no later than 28 days after the entry of judgment.",
    notes: "The court may not extend this time: K.S.A. 60-206(b)(2) lists 60-259(b) among the periods that cannot be extended.",
  },
  {
    id: "alter-amend-motion",
    name: "Motion to alter or amend judgment",
    trigger: "entry_of_judgment",
    triggerLabel: EVENT_TYPES.entry_of_judgment,
    days: 28,
    direction: "after",
    serviceAdjustment: "no",
    citation: "K.S.A. 60-259(f)",
    url: U["60-259"],
    quote: "A motion to alter or amend a judgment must be filed no later than 28 days after the entry of judgment.",
    notes: "The court may not extend this time: K.S.A. 60-206(b)(2) lists 60-259(f) among the periods that cannot be extended.",
  },
  {
    id: "notice-of-appeal",
    name: "Notice of appeal (civil)",
    trigger: "entry_of_judgment",
    triggerLabel: EVENT_TYPES.entry_of_judgment,
    days: 30,
    direction: "after",
    serviceAdjustment: "no",
    citation: "K.S.A. 60-2103(a)",
    url: U["60-2103"],
    quote:
      "When an appeal is permitted by law from a district court to an appellate court, the time within which an appeal may be taken shall be 30 days from the entry of the judgment",
    notes:
      "A timely motion under K.S.A. 60-250(b), 60-252(b) or 60-259 terminates the running of the time, which then runs in full from the order " +
      "deciding that motion (60-2103(a)). The district court may extend the time up to 30 days for excusable neglect based on a failure to learn " +
      "of the entry of judgment. Other statutes set different appeal times for some case types (not covered here).",
  },
  {
    id: "new-trial-opposing-affidavits",
    name: "Opposing affidavits on a motion for new trial",
    trigger: "served_new_trial_motion",
    triggerLabel: EVENT_TYPES.served_new_trial_motion,
    days: 14,
    direction: "after",
    serviceAdjustment: "yes",
    citation: "K.S.A. 60-259(d)",
    url: U["60-259"],
    quote: "The opposing party has 14 days after being served to file opposing affidavits or declarations.",
  },
  {
    id: "cross-appeal",
    name: "Notice of cross-appeal",
    trigger: "served_notice_of_appeal",
    triggerLabel: EVENT_TYPES.served_notice_of_appeal,
    days: 21,
    direction: "after",
    serviceAdjustment: "uncertain",
    citation: "K.S.A. 60-2103(h)",
    url: U["60-2103"],
    quote:
      "the appellee shall, within 21 days after the notice of appeal has been served upon such appellee and filed with the clerk of the trial court, give notice of such appellee's cross-appeal.",
    notes: "The period runs from the later of service and filing of the notice of appeal: use that later date as the trigger. Appellate deadlines may be jurisdictional; the 60-206(d) mail days are not added.",
  },
  {
    id: "motion-hearing-notice",
    name: "Serve written motion and notice of hearing",
    trigger: "hearing_date",
    triggerLabel: EVENT_TYPES.hearing_date,
    days: 7,
    direction: "before",
    serviceAdjustment: "no",
    citation: "K.S.A. 60-206(c)(1)",
    url: U["60-206"],
    quote:
      "A written motion and notice of the hearing must be served at least seven days before that time specified for the hearing with the following exceptions: " +
      "(A) When the motion may be heard ex parte; (B) when these rules set a different time; or (C) when a court order ... sets a different time.",
    notes: "Counted backward from the hearing date (60-206(a)(5)). The date shown is the last day to serve.",
  },
  {
    id: "opposing-affidavit-before-hearing",
    name: "Serve opposing affidavit or declaration",
    trigger: "hearing_date",
    triggerLabel: EVENT_TYPES.hearing_date,
    days: 1,
    direction: "before",
    serviceAdjustment: "no",
    citation: "K.S.A. 60-206(c)(2)",
    url: U["60-206"],
    quote:
      "Except as otherwise provided in K.S.A. 60-259(d), and amendments thereto, any opposing affidavit or declaration must be served at least one day before the hearing, unless the court permits service at another time.",
    notes: "Counted backward from the hearing date (60-206(a)(5)).",
  },
];

export function ruleById(id: string): DeadlineRule | undefined {
  return RULES.find((r) => r.id === id);
}

export interface RuleDeadline {
  rule: DeadlineRule;
  result: DeadlineResult;
}

export interface DeadlinesForOptions {
  serviceMethod?: ServiceMethod | null;
  courtClosedDays?: ISODate[];
  extraHolidays?: ComputeInput["extraHolidays"];
}

/** Apply one rule to a trigger date. */
export function applyRule(rule: DeadlineRule, triggerDate: ISODate, opts: DeadlinesForOptions = {}): RuleDeadline {
  const sm = opts.serviceMethod ?? null;
  const addService = rule.serviceAdjustment === "yes" ? sm : null;
  const result = computeDeadline({
    trigger: triggerDate,
    days: rule.days,
    direction: rule.direction,
    serviceMethod: addService,
    courtClosedDays: opts.courtClosedDays,
    extraHolidays: opts.extraHolidays,
  });
  const head = `Rule: ${rule.name}, ${rule.citation} (${rule.url}): "${rule.quote}"`;
  result.steps.unshift(head);
  if (rule.serviceAdjustment === "uncertain" && sm && (sm === "mail" || sm === "clerk")) {
    result.warnings.unshift(
      `Service was by ${sm}, but whether K.S.A. 60-206(d) adds 3 days to this period was not verified, so no days were added. ` +
        `The date shown is the earlier (safer) date.`,
    );
  }
  if (rule.serviceAdjustment === "no" && sm) {
    result.steps.push(`No 60-206(d) days were added: ${rule.notes ?? "this period does not run from service under K.S.A. 60-205."}`);
  }
  if (rule.notes) result.warnings.push(`${rule.citation}: ${rule.notes}`);
  result.citations.unshift({ cite: rule.citation, url: rule.url });
  return { rule, result };
}

/** Every library deadline that runs from an event of this type. */
export function deadlinesFor(eventType: EventType | string, triggerDate: ISODate, opts: DeadlinesForOptions = {}): RuleDeadline[] {
  if (!(eventType in EVENT_TYPES)) {
    throw new DeadlineError(`Unknown event type "${eventType}". Known: ${Object.keys(EVENT_TYPES).join(", ")}`);
  }
  return RULES.filter((r) => r.trigger === eventType).map((r) => applyRule(r, triggerDate, opts));
}
