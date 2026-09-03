const dataUrl = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i;

function dataAttachment(url, index) {
  const match = dataUrl.exec(url);
  if (!match) throw new Error(`attachments[${index}] must use a data URL until browser upload support is verified`);
  if (!match[2]) throw new Error(`attachments[${index}] must be base64 encoded`);
  const mimeType = match[1] || 'application/octet-stream';
  const data = Buffer.from(match[3], 'base64');
  if (!data.length) throw new Error(`attachments[${index}] is empty`);
  return { id: `attachment_${index}`, name: `attachment-${index}`, mimeType, kind: mimeType.startsWith('image/') ? 'image' : 'file', source: 'client-data-url', bytes: data.length, data: data.toString('base64') };
}

export function contentParts(content, label = 'message content') {
  if (typeof content === 'string') return { text: content, attachments: [] };
  if (content == null) return { text: '', attachments: [] };
  if (!Array.isArray(content)) throw new Error(`${label} must be text or a content array`);
  let text = ''; const attachments = [];
  for (const part of content) {
    if (part?.type === 'text' || part?.type === 'input_text') { text += String(part.text ?? ''); continue; }
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof url !== 'string') throw new Error(`${label} image_url requires a URL`);
      attachments.push(dataAttachment(url, attachments.length)); continue;
    }
    if (part?.type === 'input_image') {
      const url = part.image_url ?? part.url;
      if (typeof url !== 'string') throw new Error(`${label} input_image requires image_url`);
      attachments.push(dataAttachment(url, attachments.length)); continue;
    }
    if (part?.type === 'file' || part?.type === 'input_file') throw new Error(`${label} file attachments need an explicit data URL; file references are not uploaded automatically`);
    throw new Error(`unsupported ${label} content type: ${part?.type ?? 'unknown'}`);
  }
  return { text, attachments };
}

export function unsupportedUploadMessage(attachments) {
  const kinds = [...new Set(attachments.map((attachment) => attachment.kind))].join(' and ');
  return `${kinds || 'attachment'} upload is not enabled: the authenticated AiPASS Web UI upload flow has not been verified in this environment. No attachment was sent.`;
}
