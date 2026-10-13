// A stand-in for the Trajectory API, for the browser tests: the real tRPC server library with the production
// transformer (superjson) and the same procedure names, inputs and answers as server/routers.ts for the account and
// the saved plan. Sign in with Apple is accepted without checking the token (there is no Apple here); Pro is on when
// MOCK_PRO=1. Everything lives in memory.
//
//   node tests/mock-server.mjs            # http://127.0.0.1:4174
//   MOCK_PORT=4174 MOCK_PRO=1 node tests/mock-server.mjs
//   MOCK_GCAL=1: every account has a Google Calendar connection made before (server/google-calendar.ts REST routes).
import http from "node:http";
import { randomUUID } from "node:crypto";
import { initTRPC, TRPCError } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import superjson from "superjson";
import { z } from "zod";

const PORT = Number(process.env.MOCK_PORT ?? 4174);
const PRO = process.env.MOCK_PRO === "1";
const PRO_REQUIRED_ERR_MSG = "This is a Trajectory Pro feature. Upgrade to Pro to keep using it.";
const FREE_SYLLABUS_LIMIT_ERR_MSG = "Your free plan includes one syllabus import, and it has been used. Upgrade to Trajectory Pro to import more syllabi.";

/** @type {Map<string, {id:number, openId:string, name:string, email:string|null, loginMethod:string, lastSignedIn:Date}>} */
const users = new Map();
/** @type {Map<string, string>} token -> openId */
const sessions = new Map();
/** @type {Map<number, {header:{revision:number, savedAt:string, deviceId:string, chars:number}, snapshot:string}>} */
const plans = new Map();
/** @type {Map<number, number>} userId -> free syllabus imports used */
const imports = new Map();
let nextUserId = 1;

// ── Google Calendar (server/google-calendar.ts): a connection made before connecting was retired ──
const GCAL = process.env.MOCK_GCAL === "1";
/** @type {Map<number, {connected:boolean, lastSync:string|null, events:object[]}>} */
const gcal = new Map();
function gcalFor(userId) {
  let row = gcal.get(userId);
  if (!row) {
    row = {
      connected: GCAL,
      lastSync: GCAL ? new Date().toISOString() : null,
      events: GCAL
        ? [
            { id: 1, googleEventId: "mock-shift", calendarId: "primary", title: "Barista shift", description: null, startDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), endDate: null, startTime: "17:00", endTime: "21:00", isAllDay: false, isRecurring: false, status: "active", syncedAt: new Date().toISOString() },
            { id: 2, googleEventId: "mock-dentist", calendarId: "primary", title: "Dentist", description: null, startDate: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), endDate: null, startTime: "09:30", endTime: "10:15", isAllDay: false, isRecurring: false, status: "active", syncedAt: new Date().toISOString() },
          ]
        : [],
    };
    gcal.set(userId, row);
  }
  return row;
}
/** The signed-in user of a REST request (its Bearer token), or null. */
function userOf(req) {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const openId = token ? sessions.get(token) : undefined;
  return openId ? users.get(openId) ?? null : null;
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
/** GET /api/gcal/status|events, POST /api/gcal/sync|disconnect|connect, with the real server's answers. True when handled. */
function gcalRoutes(req, res, pathname) {
  if (!pathname.startsWith("/api/gcal/")) return false;
  const user = userOf(req);
  if (pathname === "/api/gcal/status" && req.method === "GET") {
    if (!user) return sendJson(res, 200, { connected: false, syncEnabled: false, channelActive: false, lastSync: null }), true;
    const row = gcalFor(user.id);
    return sendJson(res, 200, { connected: row.connected, syncEnabled: row.connected, channelActive: row.connected, lastSync: row.lastSync }), true;
  }
  if (!user) return sendJson(res, 401, { error: "Not authenticated" }), true;
  const row = gcalFor(user.id);
  if (pathname === "/api/gcal/events" && req.method === "GET") return sendJson(res, 200, { connected: row.connected, lastSync: row.lastSync, events: row.connected ? row.events : [] }), true;
  if (pathname === "/api/gcal/sync" && req.method === "POST") {
    if (!row.connected) return sendJson(res, 500, { error: "Sync failed" }), true;
    row.lastSync = new Date().toISOString();
    return sendJson(res, 200, { synced: row.events.length }), true;
  }
  if (pathname === "/api/gcal/disconnect" && req.method === "POST") {
    row.connected = false;
    row.events = [];
    row.lastSync = null;
    return sendJson(res, 200, { success: true }), true;
  }
  if (pathname === "/api/gcal/connect" && req.method === "POST") return sendJson(res, 503, { error: "Google Calendar is not configured on this server." }), true;
  return false;
}

function newToken(openId) {
  const token = `mock.${randomUUID()}`;
  sessions.set(token, openId);
  return token;
}

const t = initTRPC.context().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    const appCode = error.code === "FORBIDDEN" ? (error.message === PRO_REQUIRED_ERR_MSG ? "PRO_REQUIRED" : error.message === FREE_SYLLABUS_LIMIT_ERR_MSG ? "FREE_SYLLABUS_LIMIT" : null) : null;
    return appCode ? { ...shape, data: { ...shape.data, appCode } } : shape;
  },
});
const publicProcedure = t.procedure;
const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Please login (10001)" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
const proProcedure = protectedProcedure.use(({ next }) => {
  if (!PRO) throw new TRPCError({ code: "FORBIDDEN", message: PRO_REQUIRED_ERR_MSG });
  return next();
});

const SYLLABUS_INPUT = z.object({
  pdfUrl: z.string().optional(),
  pdfUrls: z.array(z.string()).optional(),
  rawText: z.string().optional(),
  courseName: z.string().default(""),
  today: z.string(),
  semesterStart: z.string().optional(),
  semesterEnd: z.string().optional(),
});

/** The one free syllabus per account, as the server's ledger enforces it. */
function claimImport(userId) {
  const used = imports.get(userId) ?? 0;
  if (used >= 1 && !PRO) throw new TRPCError({ code: "FORBIDDEN", message: FREE_SYLLABUS_LIMIT_ERR_MSG });
  imports.set(userId, used + 1);
}

/** A tiny reading: every line "Name - YYYY-MM-DD" becomes an item (enough for the browser test). */
function fakeExtraction(input) {
  const items = [];
  for (const line of (input.rawText ?? "").split("\n")) {
    const match = /^(.+?)\s*[-–]\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(line.trim());
    if (match) items.push({ name: match[1], type: /exam|midterm|final/i.test(match[1]) ? "exam" : /quiz/i.test(match[1]) ? "quiz" : "assignment", dueDate: match[2], dueTime: null, dateText: match[2], dateConfidence: "explicit", dateEvidence: line.trim(), weightPercent: null, notes: null });
  }
  return {
    count: items.length,
    extraction: {
      course: { name: input.courseName || "Mock Course", code: null, meetingDays: [], startTime: null, endTime: null, location: null, instructor: null },
      items,
      term: null,
      warnings: [],
    },
  };
}

/** How long a fake reading runs; its live list grows over that time (docs/live-import.md), then the result is ready. */
const JOB_MS = Number(process.env.MOCK_JOB_MS ?? 1500);
/** @type {Map<string, {id:string, userId:number, status:string, startedAt:number, result?:object}>} */
const jobs = new Map();

// ── The study tools' AI answers (server/study-ai.ts): small, realistic, in the shapes lib/study-parsers.ts accepts ──

/** ai.analyzeSyllabus: a study guide (StudyGuideOutput) for the course named, with topics of every importance. */
function mockStudyGuide(input) {
  const title = String(input?.courseName ?? "").trim() || "Mock Course";
  return {
    courseTitle: title,
    examDate: "",
    overview: `A term of ${title}: what each week covers and which ideas carry the exam.`,
    topics: [
      { title: "Cell structure", week: "Week 1", description: "Organelles, membranes and how a cell keeps itself apart from its surroundings.", keyTerms: ["nucleus", "ribosome", "membrane"], importance: "high" },
      { title: "Genetics", week: "Week 2", description: "How traits pass from one generation to the next, from Mendel to DNA.", keyTerms: ["allele", "genotype"], importance: "medium" },
      { title: "Lab safety", week: "Week 3", description: "The rules of the lab and why each one exists.", keyTerms: ["PPE"], importance: "low" },
    ],
    studyTips: ["Work the problems before reading the answers.", "Review the key terms of each topic out loud."],
  };
}

/** ai.generatePracticeExam: as many questions as asked (PracticeExamOutput), cycling through the three kinds. */
function mockPracticeExam(input) {
  const count = Math.max(1, Math.min(40, Number(input?.questionCount) || 15));
  const title = String(input?.courseName ?? "").trim() || "Practice Exam";
  const questions = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 3;
    if (kind === 0) questions.push({ type: "multiple_choice", question: `Which organelle holds the cell's DNA? (${i + 1})`, options: ["Ribosome", "Nucleus", "Mitochondrion", "Golgi apparatus"], answerIndex: 1, answer: "Nucleus", explanation: "The nucleus holds the chromosomes.", topic: "Cell structure", difficulty: "easy" });
    else if (kind === 1) questions.push({ type: "true_false", question: `Alleles are alternative forms of a gene. (${i + 1})`, options: [], answerIndex: -1, answer: "True", explanation: "By definition.", topic: "Genetics", difficulty: "medium" });
    else questions.push({ type: "short_answer", question: `Explain what a genotype is. (${i + 1})`, options: [], answerIndex: -1, answer: "The set of alleles an organism carries for a trait.", explanation: "As opposed to the phenotype, which is what shows.", topic: "Genetics", difficulty: "hard" });
  }
  return { courseTitle: title, estimatedMinutes: Math.max(10, Math.ceil(count * 1.5)), questions, dropped: 0 };
}

/** ai.generateExamContent: material for the topics given (ExamContentResult, with how much of the notes was read). */
function mockExamContent(input) {
  const topics = (Array.isArray(input?.topics) ? input.topics : []).filter((topic) => typeof topic === "string" && topic.trim());
  const named = topics.length > 0 ? topics : ["Topics from my material"];
  const raw = typeof input?.rawInput === "string" ? input.rawInput : "";
  return {
    topicExpansions: named.map((title) => ({ title, explanation: `${title}: what it is, why it matters and how it is used.`, keyPoints: [`Define ${title} in one sentence.`, `Know one worked example of ${title}.`], commonMistakes: `Mixing up ${title} with a neighbouring idea.` })),
    keyConcepts: named,
    bigPictureSummary: `This exam ties together ${named.join(", ")}.`,
    importantDefinitions: named.map((title) => ({ term: title, definition: `The working definition of ${title}.` })),
    flashcards: named.flatMap((title) => [{ front: `What is ${title}?`, back: `The working definition of ${title}.` }, { front: `Give an example of ${title}.`, back: `A worked example of ${title}.` }]),
    practiceQuestions: named.map((title) => ({ question: `Explain ${title} in your own words.`, answer: `${title} is the idea the course builds on here (a short model answer).` })),
    inputTruncated: raw.length > 60_000,
    inputChars: raw.length,
    usedChars: Math.min(raw.length, 60_000),
  };
}

/** ai.reviewTest: a graded test with two marked mistakes (TestReviewOutput). */
function mockTestReview(input) {
  const title = String(input?.courseName ?? "").trim() || "Principles of Finance";
  return {
    gradedStatus: "graded",
    courseTitle: title,
    score: "78 of 100",
    mistakes: [
      { questionNumber: "4", studentAnswer: "ROE = net income / total assets", correctAnswer: "ROE = net income / equity", explanation: "Dividing by total assets gives return on assets, not return on equity.", concept: "DuPont identity" },
      { questionNumber: "7", studentAnswer: "12%", correctAnswer: "16%", explanation: "Net income of 40 over equity of 250 is 16%.", concept: "Return on equity" },
    ],
    conceptsToReview: ["DuPont identity", "Return on equity"],
    practiceProblems: [{ question: "A firm has net income of 40 and equity of 250. What is its ROE?", answer: "16%", concept: "Return on equity" }],
    encouragement: "Most of this paper is right: the two slips are the same idea.",
  };
}

const appRouter = t.router({
  auth: t.router({
    me: publicProcedure.query(({ ctx }) => ctx.user),
    apple: publicProcedure
      .input(z.object({ identityToken: z.string().min(1), appleUserId: z.string().min(1), email: z.string().optional(), givenName: z.string().optional(), familyName: z.string().optional(), authorizationCode: z.string().optional() }))
      .mutation(({ input }) => {
        const openId = `apple:${input.appleUserId}`;
        let user = users.get(openId);
        if (!user) {
          user = { id: nextUserId++, openId, name: [input.givenName, input.familyName].filter(Boolean).join(" ") || "Trajectory Student", email: input.email ?? null, loginMethod: "apple", lastSignedIn: new Date() };
          users.set(openId, user);
        }
        return { sessionToken: newToken(openId), user };
      }),
    refresh: protectedProcedure.mutation(({ ctx }) => ({ sessionToken: newToken(ctx.user.openId) })),
    logout: publicProcedure.mutation(() => ({ success: true })),
  }),
  account: t.router({
    delete: protectedProcedure.mutation(({ ctx }) => {
      users.delete(ctx.user.openId);
      plans.delete(ctx.user.id);
      for (const [token, openId] of sessions) if (openId === ctx.user.openId) sessions.delete(token);
      return { success: true, appleRevoked: false };
    }),
    recheckPro: protectedProcedure.mutation(() => ({ pro: PRO })),
  }),
  plan: t.router({
    header: protectedProcedure.query(({ ctx }) => plans.get(ctx.user.id)?.header ?? null),
    load: protectedProcedure.query(({ ctx }) => plans.get(ctx.user.id) ?? null),
    save: protectedProcedure
      .input(z.object({ baseRevision: z.number().int().min(0), snapshot: z.string().min(2), deviceId: z.string().max(64), force: z.boolean().optional() }))
      .mutation(({ ctx, input }) => {
        const current = plans.get(ctx.user.id);
        const revision = current?.header.revision ?? 0;
        if (!input.force && revision !== input.baseRevision) return { saved: false, header: current?.header ?? null };
        const header = { revision: revision + 1, savedAt: new Date().toISOString(), deviceId: input.deviceId, chars: input.snapshot.length };
        plans.set(ctx.user.id, { header, snapshot: input.snapshot });
        return { saved: true, header };
      }),
  }),
  ai: t.router({
    uploadFile: protectedProcedure.input(z.object({ base64: z.string(), mimeType: z.string(), purpose: z.string().optional() })).mutation(() => ({ url: `https://files.mock.local/${randomUUID()}` })),
    uploadSyllabus: protectedProcedure.input(z.object({ fileName: z.string(), base64Data: z.string(), mimeType: z.string() })).mutation(() => ({ url: `https://files.mock.local/${randomUUID()}` })),
    extractDocxText: protectedProcedure.input(z.object({ base64Data: z.string() })).mutation(() => ({ text: "Mock document text.\nQuiz 1 - 2026-11-03" })),
    extractSyllabus: protectedProcedure.input(SYLLABUS_INPUT).mutation(({ ctx, input }) => {
      claimImport(ctx.user.id);
      return fakeExtraction(input);
    }),
    startSyllabusExtraction: protectedProcedure.input(SYLLABUS_INPUT).mutation(({ ctx, input }) => {
      claimImport(ctx.user.id);
      const id = randomUUID();
      jobs.set(id, { id, userId: ctx.user.id, status: "running", startedAt: Date.now(), result: fakeExtraction(input) });
      return { jobId: id };
    }),
    syllabusExtractionStatus: protectedProcedure.input(z.object({ jobId: z.string() })).query(({ ctx, input }) => {
      const job = jobs.get(input.jobId);
      if (!job || job.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "This syllabus reading has expired. Please upload the file again." });
      const elapsed = Date.now() - job.startedAt;
      if (elapsed < JOB_MS) {
        // The list grows with the clock: the first item a fifth of the way in, every item by the end (the course's name once there is one).
        const found = job.result.extraction.items.slice(0, Math.floor((job.result.extraction.items.length * Math.min(1, Math.max(0, elapsed - JOB_MS / 5) / (JOB_MS * 0.6))) + 0.5));
        const items = found.map((item) => ({ name: item.name, type: item.type, date: item.dueDate }));
        return { id: job.id, status: "running", progress: { stage: elapsed > JOB_MS * 0.85 ? "finishing" : "reading", itemsFound: items.length, items, courseName: items.length > 0 ? job.result.extraction.course.name : null }, elapsedMs: elapsed };
      }
      return { id: job.id, status: "done", result: job.result, elapsedMs: elapsed };
    }),
    planSemesterStrategy: protectedProcedure.input(z.any()).mutation(({ input }) => ({ planSummary: "Mock strategy.", taskPlans: (input?.tasks ?? []).map((task) => ({ taskId: task.id, rationale: "Mock.", priority: 3, sessions: [{ label: "Work", purpose: "practice", minutes: 60, earliestDaysBeforeDue: 5, targetDaysBeforeDue: 2 }] })), warnings: [] })),
    parseTasks: proProcedure.input(z.any()).mutation(() => ({ tasks: [], events: [], recurringEvents: [], summary: "Nothing to add." })),
    conversationalChat: proProcedure.input(z.any()).mutation(({ input }) => {
      const message = String(input?.message ?? "");
      const empty = { tasks: [], events: [], recurringEvents: [], newClasses: [], editBlocks: [], deadlineChanges: [] };
      // "Add <something>" answers as the real server does for new work: one task to review, due in a week.
      if (/^add\s+\S/i.test(message)) {
        const today = /^\d{4}-\d{2}-\d{2}$/.test(String(input?.today)) ? String(input.today) : new Date().toISOString().slice(0, 10);
        const due = new Date(`${today}T12:00:00`);
        due.setDate(due.getDate() + 7);
        const task = { name: message.replace(/^add\s+/i, "").trim(), courseName: "", estimatedMinutes: 60, difficulty: 3, dueDate: `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}` };
        return { ...empty, type: "schedule", reply: `I found 1 task: **${task.name}**. Check it, then add it.`, tasks: [task] };
      }
      return { ...empty, type: "chat", reply: `Mock reply to: ${message}` };
    }),
    editSchedule: proProcedure.input(z.any()).mutation(() => ({ editBlocks: [], editRecurring: [], newEvents: [], newRecurring: [], summary: "Nothing changed.", noMatchFound: true, fallbackMessage: "Mock: nothing matched." })),
    analyzeSyllabus: proProcedure.input(z.any()).mutation(({ input }) => mockStudyGuide(input)),
    generatePracticeExam: proProcedure.input(z.any()).mutation(({ input }) => mockPracticeExam(input)),
    generateExamContent: proProcedure.input(z.any()).mutation(({ input }) => mockExamContent(input)),
    reviewTest: proProcedure.input(z.any()).mutation(({ input }) => mockTestReview(input)),
  }),
});

const trpc = createHTTPHandler({
  router: appRouter,
  createContext: ({ req }) => {
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const openId = token ? sessions.get(token) : undefined;
    return { user: openId ? users.get(openId) ?? null : null };
  },
});

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
    res.setHeader("Vary", "Origin");
  }
}

const server = http.createServer((req, res) => {
  cors(req, res);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (url.pathname === "/api/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
    return;
  }
  if (url.pathname === "/api/auth/logout") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true }));
    return;
  }
  if (url.pathname.startsWith("/api/trpc")) {
    req.url = req.url.slice("/api/trpc".length) || "/";
    trpc(req, res);
    return;
  }
  if (gcalRoutes(req, res, url.pathname)) return;
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock Trajectory API on http://127.0.0.1:${PORT} (Pro ${PRO ? "on" : "off"}, Google Calendar ${GCAL ? "connected" : "not connected"})`);
});
