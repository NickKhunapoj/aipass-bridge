export class BrowserUploadUnavailableError extends Error {
  constructor() { super('AiPASS Web attachment upload is not configured from a verified UI flow'); this.name = 'BrowserUploadUnavailableError'; }
}

export async function uploadAttachments(_attachments, _context) { throw new BrowserUploadUnavailableError(); }
