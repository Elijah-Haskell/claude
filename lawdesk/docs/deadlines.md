# Kansas court-deadline calculator (`src/deadlines/`)

> **VERIFY EVERY DATE.** This is a calculation aid, not legal advice. A lawyer must check each
> deadline against the current statute, the Kansas Supreme Court rules, the local rules of the judicial
> district and any order in the case. Local rules and court orders can shorten or lengthen a period,
> and the court can extend or change it. The holiday list may be incomplete. **Kansas state courts
> only: federal court (U.S. District Court for the District of Kansas, governed by Fed. R. Civ. P. 6 and
> D. Kan. local rules) is not covered**, nor are criminal, appellate-rule or agency periods.

The same disclaimer is returned in every computation (`DISCLAIMER`, `result.disclaimer`) and is
appended to every task created from a deadline.

## API

```ts
import { computeDeadline, deadlinesFor, deadlineToTaskInput, legalHolidays } from "./src/deadlines/index.ts";

computeDeadline({
  trigger: "2026-10-01",          // day of the event; "YYYY-MM-DDTHH:MM" for an hours period
  days: 30,                       // or hours: 48
  direction: "after",             // "after" (default) or "before" (counted back from e.g. a hearing)
  serviceMethod: "mail",          // hand | leaving | mail | clerk | fax | electronic (K.S.A. 60-205(b)(2))
  courtClosedDays: ["2026-11-27"],// days the clerk's office is inaccessible (K.S.A. 60-206(a)(3))
  extraHolidays: [{ date: "2026-12-24", name: "...", source: "..." }],
});
// => { date, time?, laterDateIfExtended?, lastDayEnds, steps[], warnings[], citations[], disclaimer }

deadlinesFor("entry_of_judgment", "2026-12-11", { serviceMethod: "mail" }); // => [{ rule, result }]
deadlineToTaskInput(result, { title: "File notice of appeal", matterId: 7 }); // => TaskInput for Engine.addTask
legalHolidays(2026);
```

Routes (`src/deadlines/routes.ts`): `GET /deadlines/rules`, `GET /deadlines/holidays/:year`,
`POST /deadlines/compute` (body is either the `computeDeadline` input, or `{ eventType, trigger,
serviceMethod?, courtClosedDays?, extraHolidays? }` to run the rules library).

`deadlineToTaskInput` sets the task's due date by hand (the engine stores it as locked, so later
holiday edits in the firm's own `holidays` table do not move it) and puts every step, warning,
source URL and the disclaimer in the description. Priority defaults to `high`.

## Time computation: K.S.A. 60-206

Source: <https://ksrevisor.gov/statutes/chapters/ch60/060_002_0006.html> (read November 2026;
history ends "L. 2017, ch. 75, § 2; L. 2020, ch. 4, § 3; March 19.").

| Step | Statute text relied on | What the code does |
|---|---|---|
| Scope | (a): "The following provisions apply in computing any time period specified in this chapter, in any local rule or court order or in any statute or administrative rule or regulation that does not specify a method of computing time." | Applies the steps below. |
| Exclude trigger day | (a)(1)(A): "Exclude the day of the event that triggers the period." | Day 1 is the day after (or before) the trigger. |
| Count every day | (a)(1)(B): "count every day, including intermediate Saturdays, Sundays and legal holidays." | Calendar days, no skipping. |
| Last day | (a)(1)(C): "include the last day of the period, but if the last day is a Saturday, Sunday or legal holiday, the period continues to run until the end of the next day that is not a Saturday, Sunday or legal holiday." | Rolls past weekend/holiday days. |
| Next day | (a)(5): "The 'next day' is determined by continuing to count forward when the period is measured after an event and backward when measured before an event." | `direction: "before"` rolls to the earlier day. |
| Hours | (a)(2): "(A) Begin counting immediately on the occurrence of the event that triggers the period; (B) count every hour, including hours during intermediate Saturdays, Sundays and legal holidays; and (C) if the period would end on a Saturday, Sunday or legal holiday, the period continues to run until the same time on the next day that is not a Saturday, Sunday or legal holiday." | Real elapsed hours in the court's time zone (default America/Chicago), then same wall-clock time on the next qualifying day. Warns when a daylight-saving change is crossed. |
| Clerk's office inaccessible | (a)(3): "Unless the court orders otherwise, if the clerk's office is inaccessible: (A) On the last day for filing under subsection (a)(1), then the time for filing is extended to the first accessible day that is not a Saturday, Sunday or legal holiday; or (B) during the last hour for filing under subsection (a)(2), then the time for filing is extended to the same time on the first accessible day that is not a Saturday, Sunday or legal holiday." | `courtClosedDays` on the last day extends it. For backward periods the statute is silent; the code moves earlier (safer) and warns. |
| End of last day | (a)(4): "the last day ends: (A) For electronic or telefacsimile filing, at midnight in the court's time zone; and (B) for filing by other means, when the clerk's office is scheduled to close." | Reported as `lastDayEnds`. |
| Legal holiday | (a)(6): "'Legal holiday' means any day declared a holiday by the president of the United States, the congress of the United States or the legislature of this state, or any day observed as a holiday by order of the Kansas supreme court. A half holiday is considered as other days and not as a holiday." | See *Legal holidays* below. |
| Mail / clerk service | (d): "When a party may or must act within a specified time after being served and service is made under K.S.A. 60-205(b)(2)(C) (mail), or (D) (leaving with the clerk), and amendments thereto, three days are added after the period would otherwise expire under subsection (a)." | Computes the period under (a) first (including the weekend roll), then adds 3 calendar days. Only `mail` and `clerk` qualify; hand, leaving, fax and electronic service add nothing. Not applied to backward periods. |
| Motions | (c)(1): "A written motion and notice of the hearing must be served at least seven days before that time specified for the hearing", with exceptions (ex parte; "when these rules set a different time"; a court order). (c)(2): "any opposing affidavit or declaration must be served at least one day before the hearing, unless the court permits service at another time." | Rules `motion-hearing-notice`, `opposing-affidavit-before-hearing`. |
| No extension | (b)(2): "A court must not extend the time to act under K.S.A. 60-250(b), 60-252(b), 60-259(b), (e) and (f) and 60-260(b)". | Noted on the 60-259 rules. |
| Emergencies | (e): "The chief justice of the Kansas supreme court may issue an order to extend or suspend computation rules or time limitations established in this section pursuant to K.S.A. 20-172". | Not modelled; check for such orders. |

Service methods (K.S.A. 60-205(b)(2), <https://ksrevisor.gov/statutes/chapters/ch60/060_002_0005.html>):
(A) "Handing it to the person"; (B) leaving it at the office or dwelling; (C) "mailing it to the person's last
known address, in which event service is complete upon mailing"; (D) "leaving it with the court clerk if the
person has no known address"; (E) fax, complete "upon receipt of a confirmation generated by the transmitting
machine"; (F) "serving it by electronic means when authorized by supreme court rule or a local rule".
For mail, the trigger is the mailing date.

### Where the text is unclear, the calculator takes the earlier date

1. **3 added days ending on a weekend or holiday.** 60-206(d) says the days are "added after the period
   would otherwise expire under subsection (a)", but not whether (a)(1)(C) applies again to the new last
   day. The calculator shows the earlier date as `date`, reports the next business day as
   `laterDateIfExtended`, and warns. Example: mailed Mon 2026-11-02, 30 days: (a) gives Wed Dec 2; +3 =
   **Sat Dec 5** (shown), Mon Dec 7 only if the weekend rule applies again.
2. **Closed court on a backward period**: moved earlier, with a warning.
3. **Rules marked `serviceAdjustment: "uncertain"`** never get the 3 days, and warn when service was by
   mail or clerk.

## Legal holidays

60-206(a)(6) counts days declared by four authorities. What the code generates:

* **Kansas legislature: K.S.A. 35-107(a)** (<https://ksrevisor.gov/statutes/chapters/ch35/035_001_0007.html>,
  history "L. 1969, ch. 218, § 1; L. 1973, ch. 181, § 1; L. 2005, ch. 111, § 1; July 1."): "On and after
  January 1, 2006, the following days are declared to be legal public holidays and are to be observed as
  such": New Year's Day, January 1; Martin Luther King, Jr. Day, the third Monday in January; President's
  Day, the third Monday in February; Memorial Day, the last Monday in May; Independence Day, July 4; Labor
  Day, the first Monday in September; Columbus Day, the second Monday in October; Veterans' Day, "the
  eleventh day in November"; Thanksgiving Day, the fourth Thursday in November; Christmas Day, December 25.
  The section has no rule moving a holiday that falls on a weekend.
* **Congress: 5 U.S.C. 6103(a)** (<https://www.law.cornell.edu/uscode/text/5/6103>): the same days plus
  "Juneteenth National Independence Day, June 19." 6103(b) moves Saturday/Sunday holidays, but only "For
  the purpose of statutes relating to pay and leave of employees", so it is **not** applied.
  Inauguration Day (6103(c)) is limited to pay and leave of employees in the D.C. area and is not included.
* **Kansas Supreme Court orders** (only those actually read):
  * Administrative Order 2022-CC-080, "Re: Calendar Year 2023 Holidays"
    (<https://16jd.kscourts.gov/KSCourts/media/KsCourts/Orders/2022-CC-080.pdf?ext=.pdf>): Jan 2, Jan 16,
    Feb 20, May 29, Jun 19, Jul 4, Sep 4, Oct 9, Nov 10, Nov 23, Nov 24, Dec 25, 2023.
  * Administrative Order 2024-CC-081, "Re: Calendar Year 2025 Holidays"
    (<https://2jd.kscourts.gov/KSCourts/media/KsCourts/Orders/2024-CC-081.pdf?ext=.pdf>): Jan 1, Jan 20,
    Feb 17, May 26, Jun 19, Jul 4, Sep 1, Oct 13, Nov 11, Nov 27, Nov 28, Dec 25, 2025.
  * Administrative Order 2024-CC-105, "Re: National Day of Mourning"
    (<https://2jd.kscourts.gov/KSCourts/media/KsCourts/Orders/2024-CC-105.pdf>): January 9, 2025; "The
    National Day of Mourning will be observed as a holiday for time computation purposes."
* **The President**: not generated. Pass such days as `extraHolidays`.

Weekday "observed" dates (Jan 2, 2023; Nov 10, 2023) appear only because a Supreme Court order lists them.
When a computation touches a year with no loaded order (2026 onward at the time of writing), a warning
says so. For periods counted forward a missing holiday can only make the shown date earlier than the true
deadline; for periods counted backward it can make it later, and the warning says that too.

Holidays are generated for 2022–2100 only; earlier years are refused because the lists were read in
their current form.

## Rules library (`src/deadlines/rules.ts`)

`serviceAdjustment`: `yes` = 60-206(d) applies on its text ("after being served" with a paper served
under 60-205); `no` = the period does not run from 60-205 service; `uncertain` = not verified, never added.

| id | Period | Trigger | Mail days | Source and operative words |
|---|---|---|---|---|
| answer-petition | 21 days after | served with summons and petition | no | K.S.A. 60-212(a)(1)(A)(i) <https://ksrevisor.gov/statutes/chapters/ch60/060_002_0012.html>: "A defendant must serve an answer: (i) Within 21 days after being served with the summons and petition". Publication: (a)(1)(A)(ii), not computed. |
| answer-counterclaim | 21 days after | served with counterclaim/crossclaim | yes | K.S.A. 60-212(a)(1)(B): "within 21 days after being served with the pleading that states the counterclaim or crossclaim" |
| reply-to-answer | 21 days after | served with order to reply | uncertain | K.S.A. 60-212(a)(1)(C): "within 21 days after being served with an order to reply, unless the order specifies a different time" |
| responsive-pleading-after-motion | 14 days after | notice of denial/postponement of a 60-212 motion | uncertain | K.S.A. 60-212(a)(2)(A): "the responsive pleading must be served within 14 days after notice of the court's action" |
| interrogatory-answers | 30 days after | served with interrogatories | yes | K.S.A. 60-233(b)(2) <https://ksrevisor.gov/statutes/chapters/ch60/060_002_0033.html>: "within 30 days after being served with the interrogatories except that a defendant may serve answers or objections within 45 days after being served with process." |
| production-response | 30 days after | served with request for production | yes | K.S.A. 60-234(b)(2)(A) <https://ksrevisor.gov/statutes/chapters/ch60/060_002_0034.html>: "must respond in writing within 30 days after being served, except that a defendant may serve a response within 45 days after being served with process." |
| admission-responses | 30 days after | served with requests for admission | yes | K.S.A. 60-236(a)(3) <https://ksrevisor.gov/statutes/chapters/ch60/060_002_0036.html>: "A matter is admitted unless, within 30 days after being served, ..." (45 days after process for a defendant). |
| motion-response | 7 days after | served with a motion | uncertain | Kansas Supreme Court Rule 133(b) <https://16jd.kscourts.gov/KSCourts/media/KsCourts/Rules/Rule-133.pdf?ext=.pdf>: "Except as otherwise provided by statute or these rules, the response must be filed no later than 7 days after service of the motion or as otherwise provided by the court." |
| summary-judgment-response | 21 days after | served with SJ motion | uncertain | Rule 141(b)(2) <https://6jd.kscourts.gov/Rules-Orders/Rules/Summary-Judgment>: "no later than 21 days after service of the motion, unless the time is extended by local rule or court order." |
| summary-judgment-reply | 14 days after | served with SJ response | uncertain | Rule 141(c): "no later than 14 days after service of the response, unless the time is extended by local rule or court order." |
| new-trial-motion | 28 days after | entry of judgment | no | K.S.A. 60-259(b) <https://ksrevisor.gov/statutes/chapters/ch60/060_002_0059.html>: "A motion for a new trial must be filed no later than 28 days after the entry of judgment." Not extendable (60-206(b)(2)). |
| alter-amend-motion | 28 days after | entry of judgment | no | K.S.A. 60-259(f): "A motion to alter or amend a judgment must be filed no later than 28 days after the entry of judgment." Not extendable. |
| new-trial-opposing-affidavits | 14 days after | served with new-trial motion | yes | K.S.A. 60-259(d): "The opposing party has 14 days after being served to file opposing affidavits or declarations." |
| notice-of-appeal | 30 days after | entry of judgment | no | K.S.A. 60-2103(a) <https://ksrevisor.gov/statutes/chapters/ch60/060_021_0003.html>: "the time within which an appeal may be taken shall be 30 days from the entry of the judgment". Tolled by timely 60-250(b), 60-252(b), 60-259 motions; up to 30 more days for excusable neglect in learning of the judgment. |
| cross-appeal | 21 days after | notice of appeal served and filed | uncertain | K.S.A. 60-2103(h): "within 21 days after the notice of appeal has been served upon such appellee and filed with the clerk of the trial court". Use the later of service and filing. |
| motion-hearing-notice | 7 days before | hearing date | no | K.S.A. 60-206(c)(1) (above). |
| opposing-affidavit-before-hearing | 1 day before | hearing date | no | K.S.A. 60-206(c)(2) (above). |

## Worked examples (all in the tests)

* Interrogatories mailed Thu 2026-10-01: 30 days → Sat Oct 31 → (a)(1)(C) → Mon Nov 2; (d) +3 → **Thu Nov 5**.
* Judgment entered Fri 2026-12-11: new-trial motion **Fri 2027-01-08**; notice of appeal: 30 days → Sun Jan 10 → **Mon Jan 11**.
* Hearing Mon 2026-12-07: serve motion by **Mon Nov 30**; opposing affidavit: Sun Dec 6 → backward → **Fri Dec 4**.
* 2023: Tue Oct 24 + 30 = Thanksgiving Nov 23 → Fri Nov 24 (Order 2022-CC-080) → **Mon Nov 27**.
* Fri 2026-12-04 + 28 = New Year's Day 2027 (Fri) → **Mon 2027-01-04**.

## Known gaps

* **Kansas Supreme Court holiday orders for 2026 and 2027 were not read.** A district court page lists them as
  Administrative Orders 2025-CC-117 and 2026-CC-093 (<https://www.dc18.org/holiday-schedule>), but the order
  text could not be found or loaded. Add them to `SUPREME_COURT_ORDERS` once read; until then the Friday
  after Thanksgiving 2026 (Nov 27) and any weekday observance of Saturday, July 4, 2026 are **not** holidays
  in the calculator. The 2024 order was not read either.
* Presidential holiday declarations (e.g. federal closures by executive order) are not generated; whether a
  given order "declared a holiday" is a judgment call for the lawyer.
* Whether 60-206 governs periods set by Kansas Supreme Court rules (Rules 133, 141), and whether 60-206(d)
  adds 3 days to them, was not verified.
* Whether (a)(1)(C) applies again after the 60-206(d) days are added (see above).
* How electronic filing interacts with "inaccessible" in (a)(3) (e-filing may be open when the building is not).
* Not covered: local rules of each judicial district; K.S.A. 60-250(b), 60-252(b), 60-260(b) periods (text not read);
  Kansas Supreme Court appellate rules (docketing, briefs); limited actions (Chapter 61); criminal (Chapter 22);
  probate; statutes of limitation; federal court (D. Kan.).
* Hours periods do not support the 60-206(d) added days.
