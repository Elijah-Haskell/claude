/**
 * Ground truth transcribed BY HAND from the "Semester Schedule - Fall 2026" page (an embedded IMAGE, not
 * text) of a real college syllabus (FINC-3100, Principles of Finance). Names/contacts are deliberately omitted.
 *
 * Why it matters (real-world traps this page contains):
 *  - Dates have NO year ("26-Aug"); the year comes from the title "Fall 2026".
 *  - Deliverables are grid columns: one row can hold a quiz AND a homework (e.g. 14-Sep: Quiz 4 + HW 1).
 *  - 30 quizzes + 10 homeworks + 3 exams = 43 dated deliverables, all on class dates (Mon/Wed/Fri).
 *  - No meeting TIME anywhere on the page (only the days), no term start/end dates besides the first class
 *    and the final-exam slot, and no due TIMES except the final ("Online exam due by 12 noon").
 *  - Breaks are highlighted rows: Fall Break (Fri 16-Oct), Thanksgiving (Wed 25-Nov and Fri 27-Nov), Study Day (Wed 9-Dec);
 *    Labor Day (Mon 7-Sep) is annotated but the class is still numbered (ambiguous on purpose).
 *  - Exam scopes are implied by "Review of Exam N" rows: Exam 1 = Topics 1-4, Exam 2 = Topics 5-8 (+9 review), Exam 3 = Topics 9-10.
 *  - Text extraction of the PDF returns nothing for this page: only a vision-capable read can see it.
 */
export interface ScheduleRow {
  week: number;
  /** Class number, or null for a no-class row. */
  cls: number | null;
  day: "Mon" | "Tue" | "Wed" | "Thu" | "Fri";
  /** As printed, no year. */
  printedDate: string;
  /** ISO date (year 2026 inferred from the "Fall 2026" title). */
  date: string;
  topic: string;
  quiz?: number;
  hw?: number;
  exam?: number;
  note?: string;
}

export const FINC3100_TITLE = "FINC-3100: Principles of Finance";
export const FINC3100_TERM_LABEL = "Fall 2026";

export const FINC3100_ROWS: ScheduleRow[] = [
  { week: 1, cls: 1, day: "Wed", printedDate: "26-Aug", date: "2026-08-26", topic: "Class Introduction - Review Syllabus and Semester Schedule" },
  { week: 1, cls: 2, day: "Fri", printedDate: "28-Aug", date: "2026-08-28", topic: "Topic 1: Financial Statements - Balance Sheet (pp. 2-11)" },
  { week: 2, cls: 3, day: "Mon", printedDate: "31-Aug", date: "2026-08-31", topic: "Topic 1: Financial Statements - Balance Sheet (pp. 2-11)" },
  { week: 2, cls: 4, day: "Wed", printedDate: "2-Sep", date: "2026-09-02", topic: "Topic 1: Financial Statements - B/S and Income Statement (pp. 12-17)", quiz: 1 },
  { week: 2, cls: 5, day: "Fri", printedDate: "4-Sep", date: "2026-09-04", topic: "Topic 1: Financial Statements - I/S and Statement of Cash Flows (pp. 18-23)" },
  { week: 3, cls: 6, day: "Mon", printedDate: "7-Sep", date: "2026-09-07", topic: "Topic 1: Financial Statements - SSE and SCF (pp. 18-23)", note: "Labor Day" },
  { week: 3, cls: 7, day: "Wed", printedDate: "9-Sep", date: "2026-09-09", topic: "Topic 1: Financial Statements - Practice Problem #1A", quiz: 2 },
  { week: 3, cls: 8, day: "Fri", printedDate: "11-Sep", date: "2026-09-11", topic: "Topic 1: Financial Statements - Practice Problem #1B", quiz: 3 },
  { week: 4, cls: 9, day: "Mon", printedDate: "14-Sep", date: "2026-09-14", topic: "Topic 2: Financial Statement Analysis - Ratios and DuPont Analysis (pp. 24-29)", quiz: 4, hw: 1 },
  { week: 4, cls: 10, day: "Wed", printedDate: "16-Sep", date: "2026-09-16", topic: "Topic 2: Financial Statement Analysis - Ratios and DuPont Analysis (pp. 24-29)" },
  { week: 4, cls: 11, day: "Fri", printedDate: "18-Sep", date: "2026-09-18", topic: "Topic 2: Financial Statement Analysis - Practice Problem 2A", quiz: 5 },
  { week: 5, cls: 12, day: "Mon", printedDate: "21-Sep", date: "2026-09-21", topic: "Topic 2: Financial Statement Analysis - Common-Size and Growth (pp. 30-33)", quiz: 6 },
  { week: 5, cls: 13, day: "Wed", printedDate: "23-Sep", date: "2026-09-23", topic: "Topic 2: Financial Statement Analysis - Practice Problem 2B", quiz: 7 },
  { week: 5, cls: 14, day: "Fri", printedDate: "25-Sep", date: "2026-09-25", topic: "Topic 2: Financial Statement Analysis - Practice Problem 2B" },
  { week: 6, cls: 15, day: "Mon", printedDate: "28-Sep", date: "2026-09-28", topic: "Topic 3: Short-Term Forecasting and Financial Planning (pp. 34-37)", quiz: 8, hw: 2 },
  { week: 6, cls: 16, day: "Wed", printedDate: "30-Sep", date: "2026-09-30", topic: "Topic 3: Short-Term Forecasting - Practice Problem 3A", quiz: 9 },
  { week: 6, cls: 17, day: "Fri", printedDate: "2-Oct", date: "2026-10-02", topic: "Topic 3: Short-Term Forecasting - Practice Problem 3B", quiz: 10 },
  { week: 7, cls: 18, day: "Mon", printedDate: "5-Oct", date: "2026-10-05", topic: "Topic 4: Working Capital Management - Cash Conversion Cycle (pp. 38-39)", quiz: 11, hw: 3 },
  { week: 7, cls: 19, day: "Wed", printedDate: "7-Oct", date: "2026-10-07", topic: "Topic 4: Cash Budget (pp. 42-43) and Practice Problem 4A", quiz: 12 },
  { week: 7, cls: 20, day: "Fri", printedDate: "9-Oct", date: "2026-10-09", topic: "Topic 4: Cash Budget - Practice Problem 4B", quiz: 13, note: "Review of Exam 1" },
  { week: 8, cls: 21, day: "Mon", printedDate: "12-Oct", date: "2026-10-12", topic: "Topic 5: Time Value of Money (pp. 44-47)", quiz: 14, hw: 4 },
  { week: 8, cls: 22, day: "Wed", printedDate: "14-Oct", date: "2026-10-14", topic: "Topic 5: Time Value of Money - Practice Problems", quiz: 15, exam: 1 },
  { week: 8, cls: null, day: "Fri", printedDate: "16-Oct", date: "2026-10-16", topic: "Fall Break - No Classes", note: "break" },
  { week: 9, cls: 23, day: "Mon", printedDate: "19-Oct", date: "2026-10-19", topic: "Topic 5: Time Value of Money - Practice Problems" },
  { week: 9, cls: 24, day: "Wed", printedDate: "21-Oct", date: "2026-10-21", topic: "Topic 5: Time Value of Money - Practice Problems" },
  { week: 9, cls: 25, day: "Fri", printedDate: "23-Oct", date: "2026-10-23", topic: "Topic 5: Time Value of Money - Practice Problems", quiz: 16 },
  { week: 10, cls: 26, day: "Mon", printedDate: "26-Oct", date: "2026-10-26", topic: "Topic 6: Interest Rates (pp. 48-51)", quiz: 17, hw: 5 },
  { week: 10, cls: 27, day: "Wed", printedDate: "28-Oct", date: "2026-10-28", topic: "Topic 6: Interest Rates, Risk and Return - Practice Problem 6A", quiz: 18 },
  { week: 10, cls: 28, day: "Fri", printedDate: "30-Oct", date: "2026-10-30", topic: "Topic 6: Interest Rates, Risk and Return - Practice Problem 6B", quiz: 19 },
  { week: 11, cls: 29, day: "Mon", printedDate: "2-Nov", date: "2026-11-02", topic: "Topic 7: Bonds and Bond Pricing (pp. 52-59)", hw: 6 },
  { week: 11, cls: 30, day: "Wed", printedDate: "4-Nov", date: "2026-11-04", topic: "Topic 7: Bonds and Bond Pricing - Practice Problem 7A", quiz: 20 },
  { week: 11, cls: 31, day: "Fri", printedDate: "6-Nov", date: "2026-11-06", topic: "Topic 7: Bonds and Bond Pricing - Practice Problem 7B", quiz: 21 },
  { week: 12, cls: 32, day: "Mon", printedDate: "9-Nov", date: "2026-11-09", topic: "Topic 8: Stock Valuation (pp. 60-64)", quiz: 22, hw: 7 },
  { week: 12, cls: 33, day: "Wed", printedDate: "11-Nov", date: "2026-11-11", topic: "Topic 8: Stock Valuation - Practice Problem 8A", quiz: 23 },
  { week: 12, cls: 34, day: "Fri", printedDate: "13-Nov", date: "2026-11-13", topic: "Topic 8: Stock Valuation - Practice Problem 8B", quiz: 24 },
  { week: 13, cls: 35, day: "Mon", printedDate: "16-Nov", date: "2026-11-16", topic: "Topic 9: Cost of Capital (pp. 65-67)", quiz: 25, hw: 8, note: "Review for Exam 2" },
  { week: 13, cls: 36, day: "Wed", printedDate: "18-Nov", date: "2026-11-18", topic: "Topic 9: Cost of Capital - Practice Problems 9A" },
  { week: 13, cls: 37, day: "Fri", printedDate: "20-Nov", date: "2026-11-20", topic: "Topic 9: Cost of Capital - Practice Problems 9B", quiz: 26 },
  { week: 14, cls: 38, day: "Mon", printedDate: "23-Nov", date: "2026-11-23", topic: "Topic 10: Capital Budgeting (pp. 68-72)", quiz: 27, hw: 9, exam: 2 },
  { week: 14, cls: null, day: "Wed", printedDate: "25-Nov", date: "2026-11-25", topic: "Thanksgiving Break - No Classes", note: "break" },
  { week: 14, cls: null, day: "Fri", printedDate: "27-Nov", date: "2026-11-27", topic: "Thanksgiving Break - No Classes", note: "break" },
  { week: 15, cls: 39, day: "Mon", printedDate: "30-Nov", date: "2026-11-30", topic: "Topic 10: Capital Budgeting - Practice Problem (pp. 73-80)" },
  { week: 15, cls: 40, day: "Wed", printedDate: "2-Dec", date: "2026-12-02", topic: "Topic 10: Capital Budgeting - Practice Problem (pp. 73-80)", quiz: 28 },
  { week: 15, cls: 41, day: "Fri", printedDate: "4-Dec", date: "2026-12-04", topic: "Topic 10: Capital Budgeting - Practice Problem (pp. 73-80)", quiz: 29 },
  { week: 16, cls: 42, day: "Mon", printedDate: "7-Dec", date: "2026-12-07", topic: "Review for Exam 3", quiz: 30, hw: 10 },
  { week: 16, cls: null, day: "Wed", printedDate: "9-Dec", date: "2026-12-09", topic: "Study Day - No Class", note: "break" },
  { week: 16, cls: null, day: "Tue", printedDate: "15-Dec", date: "2026-12-15", topic: "Final Exam Time Slot: 10:00 to 11:50 AM (Online exam due by 12 noon)", exam: 3, note: "final" },
];

/** Non-text facts from the text pages of the same syllabus. */
export const FINC3100_TEXT_FACTS = {
  courseCode: "FINC-3100-A",
  isAsynchronous: false,
  meetingDays: ["Mon", "Wed", "Fri"] as const,
  meetingTime: null as string | null, // NOT in the document
  location: "Westerman Hall 120",
  grading: [
    { name: "Quizzes", count: 30, points: 300, weightPercent: 43, pointsEach: 10 },
    { name: "Homework (Excel)", count: 10, points: 100, weightPercent: 14, pointsEach: 10 },
    { name: "Exams", count: 3, points: 300, weightPercent: 43, pointsEach: 100 },
  ],
  policies: ["Quizzes are timed, taken on Canvas, no make-ups", "Late homework: -3 points up to 24h late, -5 up to one week, none after"],
} as const;

/** Counts a correct extraction must reproduce. */
export const FINC3100_EXPECTED = { quizzes: 30, homeworks: 10, exams: 3, deliverables: 43, breakDates: ["2026-10-16", "2026-11-25", "2026-11-27", "2026-12-09"] as const };
