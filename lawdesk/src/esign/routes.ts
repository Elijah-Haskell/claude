// API routes for electronic signatures, under /api.
//
// The signer's routes (/esign/public/...) are `public: true`: the signer is not a Lawdesk
// user, and the unguessable token in their link is what protects them. The sign-in module
// must let these through without a session (or allow-list /api/esign/public/).

import type { DB } from "../db.ts";
import { EngineError } from "../engine.ts";
import { type Ctx, intParam } from "../http.ts";
import { documentsFor } from "../documents/routes.ts";
import { type PublicRoute, publicBaseUrl } from "../payments/routes.ts";
import { ESign, requestMeta } from "./esign.ts";
import { ProviderNotAvailable } from "./providers.ts";

const clocks = new WeakMap<DB, () => Date>();

/** Tests can fix the clock per database. */
export function setESignClock(db: DB, now: () => Date) {
  clocks.set(db, now);
}

export function esignFor(ctx: Pick<Ctx, "db" | "engine">): ESign {
  return new ESign(ctx.db, { engine: ctx.engine, documents: documentsFor(ctx), now: clocks.get(ctx.db) });
}

const body = (ctx: Ctx): Record<string, any> => (ctx.body && typeof ctx.body === "object" ? ctx.body : {});
const meta = (ctx: Ctx) => requestMeta(ctx.req as any);

function file(f: { filename: string; mime: string; data: Buffer }, disposition: "inline" | "attachment" = "inline") {
  const ascii = f.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return {
    __raw: true,
    contentType: f.mime,
    headers: { "Content-Disposition": `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.filename)}` },
    body: f.data,
  };
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ProviderNotAvailable) throw new EngineError(err.message, 409);
    throw err;
  }
}

export const routes: PublicRoute[] = [
  // ------------------------------------------------------------- staff
  { method: "GET", path: "/esign/settings", handler: (ctx) => esignFor(ctx).settings() },
  { method: "PATCH", path: "/esign/settings", handler: (ctx) => esignFor(ctx).updateSettings(body(ctx), ctx.userId) },
  { method: "GET", path: "/matters/:id/esign", handler: (ctx) => esignFor(ctx).forMatter(intParam(ctx, "id")) },
  { method: "GET", path: "/documents/:id/esign", handler: (ctx) => esignFor(ctx).forDocument(intParam(ctx, "id")) },
  {
    method: "POST",
    path: "/esign/requests",
    handler: (ctx) => {
      const b = body(ctx);
      if (!Number.isInteger(b.documentId)) throw new EngineError("documentId is required");
      return guard(() =>
        esignFor(ctx).send(
          { documentId: b.documentId, signerName: b.signerName, signerEmail: b.signerEmail, message: b.message, expiresDays: b.expiresDays, provider: b.provider },
          ctx.userId,
          publicBaseUrl(ctx),
        ),
      );
    },
  },
  { method: "GET", path: "/esign/requests/:id", handler: (ctx) => esignFor(ctx).request(intParam(ctx, "id")) },
  { method: "POST", path: "/esign/requests/:id/resend", handler: (ctx) => esignFor(ctx).resend(intParam(ctx, "id"), ctx.userId, publicBaseUrl(ctx)) },
  { method: "POST", path: "/esign/requests/:id/cancel", handler: (ctx) => esignFor(ctx).cancel(intParam(ctx, "id"), body(ctx).reason, ctx.userId) },
  {
    method: "GET",
    path: "/esign/requests/:id/signature",
    handler: (ctx) => {
      const png = esignFor(ctx).signatureImage(intParam(ctx, "id"));
      if (!png) throw new EngineError("No drawn signature on this request", 404);
      return { __raw: true, contentType: "image/png", body: png };
    },
  },

  // ------------------------------------------------- public: the signer
  { method: "GET", path: "/esign/public/:token", public: true, handler: (ctx) => esignFor(ctx).view(ctx.params.token, meta(ctx)) },
  { method: "GET", path: "/esign/public/:token/document", public: true, handler: (ctx) => file(esignFor(ctx).document(ctx.params.token, meta(ctx))) },
  { method: "GET", path: "/esign/public/:token/certificate", public: true, handler: (ctx) => file(esignFor(ctx).certificate(ctx.params.token), "attachment") },
  { method: "POST", path: "/esign/public/:token/consent", public: true, handler: (ctx) => esignFor(ctx).consent(ctx.params.token, body(ctx), meta(ctx)) },
  { method: "POST", path: "/esign/public/:token/decline", public: true, handler: (ctx) => esignFor(ctx).decline(ctx.params.token, body(ctx), meta(ctx)) },
  { method: "POST", path: "/esign/public/:token/sign", public: true, handler: (ctx) => esignFor(ctx).sign(ctx.params.token, body(ctx), meta(ctx)) },
];
