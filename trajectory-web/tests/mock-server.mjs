// A stand-in for the Trajectory API, for the browser tests: the real tRPC server library with the production
// transformer (superjson) and the same procedure names, inputs and answers as server/routers.ts for the account and
// the saved plan. Sign in with Apple is accepted without checking the token (there is no Apple here); Pro is on when
// MOCK_PRO=1. Everything lives in memory.
//
//   node tests/mock-server.mjs            # http://127.0.0.1:4174
//   MOCK_PORT=4174 MOCK_PRO=1 node tests/mock-server.mjs
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

/** @type {Map<string, {id:string, userId:number, status:string, startedAt:number, result?:object}>} */
const jobs = new Map();

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
      if (elapsed < 1500) {
        const items = job.result.extraction.items.map((item) => ({ name: item.name, type: item.type, date: item.dueDate }));
        return { id: job.id, status: "running", progress: { stage: "reading", itemsFound: items.length, items, courseName: job.result.extraction.course.name }, elapsedMs: elapsed };
      }
      return { id: job.id, status: "done", result: job.result, elapsedMs: elapsed };
    }),
    planSemesterStrategy: protectedProcedure.input(z.any()).mutation(({ input }) => ({ planSummary: "Mock strategy.", taskPlans: (input?.tasks ?? []).map((task) => ({ taskId: task.id, rationale: "Mock.", priority: 3, sessions: [{ label: "Work", purpose: "practice", minutes: 60, earliestDaysBeforeDue: 5, targetDaysBeforeDue: 2 }] })), warnings: [] })),
    parseTasks: proProcedure.input(z.any()).mutation(() => ({ tasks: [], events: [], recurringEvents: [], summary: "Nothing to add." })),
    conversationalChat: proProcedure.input(z.any()).mutation(({ input }) => ({ type: "chat", reply: `Mock reply to: ${input?.message ?? ""}`, tasks: [], events: [], recurringEvents: [], newClasses: [], editBlocks: [], deadlineChanges: [] })),
    editSchedule: proProcedure.input(z.any()).mutation(() => ({ editBlocks: [], editRecurring: [], newEvents: [], newRecurring: [], summary: "Nothing changed.", noMatchFound: true, fallbackMessage: "Mock: nothing matched." })),
    analyzeSyllabus: proProcedure.input(z.any()).mutation(() => ({ title: "Mock study guide", summary: "Mock.", topics: [], sections: [] })),
    generatePracticeExam: proProcedure.input(z.any()).mutation(() => ({ questions: [] })),
    generateExamContent: proProcedure.input(z.any()).mutation(() => ({ studyGuide: "Mock guide", flashcards: [], practiceQuestions: [] })),
    reviewTest: proProcedure.input(z.any()).mutation(() => ({ gradedStatus: "ungraded", mistakes: [], concepts: [], practiceProblems: [] })),
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
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock Trajectory API on http://127.0.0.1:${PORT} (Pro ${PRO ? "on" : "off"})`);
});
