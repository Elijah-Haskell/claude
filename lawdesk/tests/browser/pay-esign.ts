// Browser checks for online payments (test provider) and built-in e-signature.
// Called from smoke.ts once per viewport. Both viewports share one database, so each run
// makes its own invoice and its own document.

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { Billing } from "../../src/billing/billing.ts";

type Opts = {
  label: string;
  page: any;
  ctx: any;
  base: string;
  db: DatabaseSync;
  check: (name: string, fn: () => Promise<void>) => Promise<void>;
  noHorizontalScroll: () => Promise<void>;
  shots: string;
  matterId: number;
  billing: Billing;
};

// A tiny but well-formed one-page PDF.
function tinyPdf(text: string): string {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
}

export async function onlinePaymentAndSignatureChecks(o: Opts): Promise<void> {
  const { label, page, ctx, base, check, noHorizontalScroll, shots, matterId, billing } = o;

  await check(`${label}: settings shows online payments and signatures`, async () => {
    await page.goto(base + "/#/settings");
    await page.waitForSelector("#s-pay h2");
    await page.waitForSelector("#s-esign h2");
    await page.waitForFunction(() => !document.querySelector("#s-pay")?.textContent?.includes("Loading…"));
    await noHorizontalScroll();
    await page.locator("#s-pay").screenshot({ path: shots + `settings-payments-${label}.png` });
  });

  await check(`${label}: client pays an invoice online (test provider)`, async () => {
    billing.addExpense({ matterId, costCents: 12_345, description: `Filing fee (${label} smoke test)`, date: undefined as any });
    const inv = billing.finalize(billing.createDraft({ matterId }).id as number);
    await page.goto(base + `/#/matters/${matterId}`);
    const row = page.locator(".pay-card .pay-list > li", { hasText: `Invoice ${inv.number}` });
    await row.locator(".pay-online").click();
    await page.getByRole("button", { name: "Create payment link" }).click();
    const url: string = await page.locator(".share-url").inputValue();
    assert.match(url, /\/pay\.html\?t=/);
    await noHorizontalScroll();
    await page.screenshot({ path: shots + `pay-link-${label}.png` });

    const client = await ctx.newPage();
    await client.goto(url);
    await client.getByRole("button", { name: /^Pay \$.* by card$/ }).click();
    await client.waitForSelector(".test-actions");
    await client.screenshot({ path: shots + `pay-test-processor-${label}.png`, fullPage: true });
    await client.getByRole("button", { name: "Pay (simulate success)" }).click();
    await client.waitForFunction(() => !/being confirmed|Test payment page|Loading…/.test(document.body.innerText), null, { timeout: 25_000 }).catch(() => {});
    const shown: string = await client.evaluate(() => location.href + " | " + document.body.innerText);
    assert.match(shown, /Payment received/, shown);
    await client.screenshot({ path: shots + `pay-done-${label}.png`, fullPage: true });
    await client.close();

    assert.equal(billing.balance(inv.id as number), 0, "the invoice is paid in billing");
  });

  await check(`${label}: signer signs a document; status shows on the matter`, async () => {
    const docName = `Engagement letter ${label}.pdf`;
    const up = await page.evaluate(
      async ([id, filename, b64]: [number, string, string]) => {
        const r = await fetch(`/api/matters/${id}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "X-Requested-With": "lawdesk" },
          body: JSON.stringify({ filename, contentBase64: b64, onConflict: "rename" }),
        });
        return { ok: r.ok, text: await r.text() };
      },
      [matterId, docName, tinyPdf("Engagement letter")],
    );
    assert.ok(up.ok, up.text);

    await page.goto(base + `/#/matters/${matterId}`);
    await page.reload();
    await page.getByRole("button", { name: "Send a document for signature…" }).click();
    const sel = page.locator(".modal select").first();
    await page.waitForFunction(() => (document.querySelector(".modal select") as HTMLSelectElement | null)?.options.length! > 1);
    const value = await sel.evaluate((s: HTMLSelectElement, name: string) => [...s.options].find((x) => x.text.endsWith(name))?.value, docName);
    assert.ok(value, "document is offered");
    await sel.selectOption(value);
    await page.getByRole("button", { name: "Create signing link" }).click();
    const url: string = await page.locator(".share-url").inputValue();
    assert.match(url, /\/sign\.html\?t=/);
    await page.keyboard.press("Escape");

    const signer = await ctx.newPage();
    await signer.goto(url);
    await signer.waitForSelector("#open-doc");
    assert.ok(await signer.locator("#c-access").isDisabled(), "consent waits for the document to be opened");
    const [popup] = await Promise.all([ctx.waitForEvent("page"), signer.locator("#open-doc").click()]);
    await popup.close().catch(() => {});
    await signer.waitForFunction(() => !(document.querySelector("#c-access") as HTMLInputElement).disabled);
    await noHorizontalScrollOn(signer);
    await signer.screenshot({ path: shots + `sign-consent-${label}.png`, fullPage: true });
    await signer.locator("#c-access").check();
    await signer.locator("#c-agree").check();
    await signer.getByRole("button", { name: "Agree and continue" }).click();

    await signer.locator("#typed-name").fill("Pat Client");
    const box = await signer.locator("canvas.sig-pad").boundingBox();
    await signer.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
    await signer.mouse.down();
    for (let i = 1; i <= 12; i++) await signer.mouse.move(box.x + box.width * (0.15 + i * 0.05), box.y + box.height * (0.6 - Math.sin(i / 2) * 0.25));
    await signer.mouse.up();
    await signer.locator("#c-intent").check();
    await noHorizontalScrollOn(signer);
    await signer.screenshot({ path: shots + `sign-step-${label}.png`, fullPage: true });
    await signer.getByRole("button", { name: "Sign the document" }).click();
    await signer.getByText("Signed. Thank you.").waitFor();
    await signer.screenshot({ path: shots + `sign-done-${label}.png`, fullPage: true });
    await signer.close();

    await page.reload();
    const item = page.locator(".sign-card .sign-list > li", { hasText: docName.replace(/\.pdf$/, "") }).first();
    await item.getByText("Signed", { exact: true }).waitFor();
    await noHorizontalScroll();
    await page.locator(".sign-card").screenshot({ path: shots + `matter-signatures-${label}.png` });
  });
}

async function noHorizontalScrollOn(p: any) {
  const extra = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(extra <= 1, `signing page scrolls sideways by ${extra}px`);
}
