import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentParts, unsupportedUploadMessage } from '../bridge/attachments.mjs';
import { BrowserUploadUnavailableError, uploadAttachments } from '../extension/attachment-upload.mjs';

test('maps an explicit image data URL to an in-memory browser attachment record', () => {
  const result = contentParts([{ type: 'text', text: 'inspect this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]);
  assert.equal(result.text, 'inspect this');
  assert.deepEqual({ kind: result.attachments[0].kind, mimeType: result.attachments[0].mimeType, bytes: result.attachments[0].bytes }, { kind: 'image', mimeType: 'image/png', bytes: 1 });
  assert.match(unsupportedUploadMessage(result.attachments), /No attachment was sent/);
});

test('browser upload seam fails clearly until a logged-in UI flow is verified', async () => {
  await assert.rejects(uploadAttachments([{ id: 'attachment_0' }], {}), BrowserUploadUnavailableError);
});

test('does not treat remote URLs or local file references as uploadable data', () => {
  assert.throws(() => contentParts([{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }]), /data URL/);
  assert.throws(() => contentParts([{ type: 'file', file_id: 'local-path' }]), /not uploaded automatically/);
});
