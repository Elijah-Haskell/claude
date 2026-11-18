// Signature providers. Lawdesk ships a built-in flow (the signer signs on Lawdesk's own
// pages). The interface lets a hosted service such as DocuSign or Dropbox Sign plug in
// later; those adapters are stubs only and refuse to run. Nothing here talks to them yet.

export interface SendInput {
  requestId: number;
  documentName: string;
  documentBytes: Buffer;
  mime: string;
  signer: { name: string; email: string | null };
  message: string | null;
  expiresAt: string;
}

export interface SendResult {
  /** The provider's id for the envelope / signature request, if it has one. */
  externalId: string | null;
}

export interface ESignProvider {
  readonly name: string;
  /** Hand the document to the provider. The built-in provider keeps it here and does nothing. */
  send(input: SendInput): Promise<SendResult>;
  cancel(externalId: string | null): Promise<void>;
  /** Hosted providers report status by webhook; the built-in flow never does. */
  verifyWebhook?(rawBody: string, headers: Record<string, string | string[] | undefined>): void;
}

export class ProviderNotAvailable extends Error {
  status = 409;
}

export class BuiltinProvider implements ESignProvider {
  readonly name = "builtin";
  async send(): Promise<SendResult> {
    return { externalId: null };
  }
  async cancel(): Promise<void> {}
}

/** Placeholder. A real adapter would use DocuSign's eSignature REST API (envelopes). */
export class DocuSignProvider implements ESignProvider {
  readonly name = "docusign";
  async send(): Promise<SendResult> {
    throw new ProviderNotAvailable("DocuSign is not connected. Use the built-in signing for now.");
  }
  async cancel(): Promise<void> {
    throw new ProviderNotAvailable("DocuSign is not connected.");
  }
}

/** Placeholder. A real adapter would use the Dropbox Sign API (signature requests). */
export class DropboxSignProvider implements ESignProvider {
  readonly name = "dropboxsign";
  async send(): Promise<SendResult> {
    throw new ProviderNotAvailable("Dropbox Sign is not connected. Use the built-in signing for now.");
  }
  async cancel(): Promise<void> {
    throw new ProviderNotAvailable("Dropbox Sign is not connected.");
  }
}

export function esignProvider(name: string = "builtin"): ESignProvider {
  if (name === "builtin") return new BuiltinProvider();
  if (name === "docusign") return new DocuSignProvider();
  if (name === "dropboxsign") return new DropboxSignProvider();
  throw new ProviderNotAvailable(`Unknown signature provider "${name}"`);
}
