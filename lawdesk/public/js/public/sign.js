// The signer's page: /sign.html?t=<token>.
// Steps: open the document, read and accept the consent to sign electronically (or ask for
// paper), type your name, optionally draw a signature, confirm intent, sign.

import { h } from "../dom.js";
import { icon } from "../ui/icons.js";
import { call, param, frame, show } from "./common.js";

const KIND = { kind: "Document signing" };

/** A numbered step heading; a finished step shows a tick instead of its number. */
function stepHead(n, title, state) {
  return h(
    "h2.sign-step-title",
    h("span.sign-num" + (state ? "." + state : ""), { "aria-hidden": "true" }, state === "done" ? icon("check", { size: 14 }) : String(n)),
    h("span", title),
  );
}

const token = param("t");
const base = `/esign/public/${encodeURIComponent(token || "")}`;
const fileUrl = `/api${base}/document`;
let v = null;

async function load() {
  if (!token)
    return show(frame("", { ...KIND, tone: "warning" }, h("h1", "Signing link not found"), h("p.public-lead", "Please check the link you were sent.")));
  try {
    v = await call("GET", base);
  } catch (err) {
    return show(frame("", { ...KIND, tone: "warning" }, h("h1", "Signing link not found"), h("p.public-lead", err.message)));
  }
  draw();
}

function closed(title, text) {
  show(frame(v.firmName, { ...KIND, tone: "neutral" }, h("h1", title), h("p.public-lead", text)));
}

function draw() {
  if (v.status === "signed") return signedView();
  if (v.status === "declined") return closed("You chose paper", `${v.firmName} has been told and will send you a paper copy to sign.`);
  if (v.status === "cancelled")
    return closed("This request was withdrawn", `${v.firmName} withdrew this signing request. Please contact them if you have questions.`);
  if (v.status === "expired") return closed("This link has expired", `Please ask ${v.firmName} for a new signing link.`);

  const docStep = h(
    "section.sign-step",
    stepHead(1, "Read the document", v.consented ? "done" : "current"),
    v.message ? h("blockquote.sign-message", h("span.sign-message-from", `A note from ${v.firmName}`), v.message) : null,
    h(
      "div.sign-doc-card",
      h("span.sign-doc-icon", icon("file-text", { size: 22 })),
      h("div.sign-doc-text", h("span.sign-doc-name", v.documentName), h("span.sign-doc-hint", "Opens in a new tab, or downloads, depending on your device.")),
      h(
        "a.btn",
        {
          href: fileUrl,
          target: "_blank",
          rel: "noopener",
          id: "open-doc",
          onclick: () => setTimeout(() => ((v.documentViewed = true), enableConsent()), 300),
        },
        icon("external-link", { size: 15 }),
        h("span.btn-label", "Open the document"),
      ),
    ),
    v.previewText ? h("details.sign-preview", h("summary", "Or read the text here"), h("pre.sign-text", v.previewText)) : null,
  );

  const access = h("input", { type: "checkbox", id: "c-access" });
  const agree = h("input", { type: "checkbox", id: "c-agree" });
  const cErr = h("p.error-text", { role: "alert" });
  const consentBtn = h("button.btn.primary", { type: "button", onclick: doConsent }, "Agree and continue");
  const paperBtn = h("button.btn", { type: "button", onclick: () => askForPaper(cErr) }, "I'd rather sign on paper");
  function enableConsent() {
    access.disabled = !v.documentViewed;
    hint.hidden = v.documentViewed;
  }
  const hint = h("p.sign-hint", icon("info", { size: 14 }), h("span", "Open the document first."));
  const consentStep = h(
    "section.sign-step",
    stepHead(2, "Agree to sign electronically", "current"),
    h(
      "div.consent-text",
      String(v.consentText)
        .split("\n\n")
        .map((p, i) => (i === 0 ? h("h3", p) : h("p", p))),
    ),
    h("label.check-line", access, h("span", "I opened the document and could read it.")),
    hint,
    h("label.check-line", agree, h("span", "I agree to use electronic records and signatures for this document.")),
    cErr,
    h("div.form-actions.left", consentBtn, paperBtn),
  );
  enableConsent();

  async function doConsent() {
    cErr.textContent = "";
    try {
      await call("POST", `${base}/consent`, { agree: agree.checked, canAccess: access.checked, consentVersion: v.consentVersion });
      v.consented = true;
      draw();
    } catch (err) {
      cErr.textContent = err.message;
    }
  }

  show(
    frame(
      v.firmName,
      KIND,
      h("h1", "Review and sign"),
      h("p.public-lead", `For ${v.signerName}. This link works until ${new Date(v.expiresAt).toLocaleDateString()}.`),
      docStep,
      v.consented
        ? h("section.sign-step", stepHead(2, "Agree to sign electronically", "done"), h("p.sign-hint", "You agreed to sign electronically."))
        : consentStep,
      v.consented ? signStep() : h("section.sign-step.upcoming", stepHead(3, "Sign", "")),
    ),
  );
}

// Withdraw consent / ask for paper. Offered until the moment of signing (consent text, item 3).
async function askForPaper(errEl) {
  if (!confirm("Ask to sign on paper instead? This signing link will stop working, and the firm will send you a paper copy.")) return;
  const reason = prompt("Would you like to tell the firm why? (optional)") || null;
  try {
    await call("POST", `${base}/decline`, { reason });
    v.status = "declined";
    draw();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

function signStep() {
  const name = h("input#typed-name", { autocomplete: "name", maxlength: 200, placeholder: v.signerName, "aria-label": "Type your full name" });
  const pad = signaturePad();
  const intent = h("input", { type: "checkbox", id: "c-intent" });
  const err = h("p.error-text", { role: "alert" });
  const btn = h(
    "button.btn.primary.large",
    {
      type: "button",
      onclick: async () => {
        err.textContent = "";
        btn.disabled = true;
        try {
          await call("POST", `${base}/sign`, { typedName: name.value, signaturePng: pad.drawn() ? pad.png() : null, intent: intent.checked });
          v = await call("GET", base);
          draw();
        } catch (e) {
          err.textContent = e.message;
          btn.disabled = false;
        }
      },
    },
    "Sign the document",
  );
  return h(
    "section.sign-step",
    stepHead(3, "Sign", "current"),
    h("label.field.sign-label", h("span.field-label", "Type your full name"), name),
    h("div.field.sign-label", h("span.field-label", "Draw your signature", h("span.field-optional", " (optional)")), pad.el),
    h("label.check-line", intent, h("span", `I intend to sign “${v.documentName}”. My typed name and any signature I drew are my electronic signature.`)),
    err,
    h("div.form-actions.left", btn, h("button.btn", { type: "button", onclick: () => askForPaper(err) }, "I'd rather sign on paper")),
    h("p.public-fine", "When you sign, the time, your IP address and your browser are recorded in a certificate of completion kept with the document."),
  );
}

function signaturePad() {
  const canvas = h("canvas.sig-pad", { width: 600, height: 180, "aria-label": "Signature drawing area" });
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let any = false;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * canvas.width) / r.width, ((e.clientY - r.top) * canvas.height) / r.height];
  };
  const style = () => {
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--brand-800").trim() || "#1b2d4b";
  };
  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drawing = true;
    style();
    const [x, y] = pos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 0.1, y + 0.1);
    ctx.stroke();
    any = true;
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const [x, y] = pos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  });
  const end = () => (drawing = false);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  const clear = h(
    "button.btn.small.ghost.sig-clear",
    { type: "button", onclick: () => (ctx.clearRect(0, 0, canvas.width, canvas.height), (any = false)) },
    "Clear",
  );
  return {
    el: h("div.sig-wrap", canvas, h("span.sig-line", { "aria-hidden": "true" }, "Sign here"), clear),
    drawn: () => any,
    png: () => canvas.toDataURL("image/png"),
  };
}

function signedView() {
  show(
    frame(
      v.firmName,
      { ...KIND, tone: "success" },
      h("h1", "Signed. Thank you."),
      h("p.public-lead", `You signed “${v.documentName}”${v.signedAt ? ` on ${new Date(v.signedAt).toLocaleString()}` : ""}.`),
      v.copiesAvailable
        ? h(
            "div.form-actions.left",
            h("a.btn", { href: fileUrl, target: "_blank", rel: "noopener" }, icon("file-text", { size: 15 }), h("span.btn-label", "Download the document")),
            h("a.btn", { href: `/api${base}/certificate` }, icon("circle-check", { size: 15 }), h("span.btn-label", "Download the certificate")),
          )
        : null,
      h("p.public-fine", "Keep a copy for your records. You can also ask the firm for a paper copy."),
    ),
  );
}

load();
