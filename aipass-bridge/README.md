# AiPASS bridge

`aipass-bridge` is an unofficial, local protocol adapter that lets an
OpenAI-compatible coding client such as Cline use the logged-in
[AiPASS Web Chat](https://de.aipass.net/chat) as its model backend.

```text
Cline / VS Code ── OpenAI Chat Completions ──> aipass-bridge
                                                   │
                                             browser extension
                                                   │
                                           authenticated AiPASS Web Chat
```

The division of responsibility is deliberate:

- **AiPASS Web** is the remote model provider and retains its own system prompt.
- **aipass-bridge** adapts messages, sessions, a textual tool protocol, schema
  validation, and OpenAI-style SSE responses.
- **Cline** is the coding agent: it owns the transcript, filesystem, terminal,
  MCP, approvals, patches, and agent lifecycle. The bridge never runs tools.

## Important limitations

This is not an AiPASS API client. An authenticated `de.aipass.net` page sends
the actual request; its cookies stay in that browser page and are never read,
exported, stored, or proxied by Node.

AiPASS's native system instructions cannot be replaced. Cline `system` and
`developer` messages are compacted into the first **ordinary user-visible task
message** and are explicitly labelled as non-privileged context. Model behavior
can therefore differ from a normal OpenAI provider, and can differ between
AiPASS model families.

The web UI is unofficial integration surface. UI or request changes can break
the extension; AiPASS can reject content; all task context and tool results
sent through the bridge are processed remotely. There is no guarantee of
API-equivalent function-calling behavior.

Attachment uploads are intentionally **not enabled yet**. The bridge recognizes
explicit image data URLs so it can report a precise error, but it does not
silently drop them, base64-inline them into text, fetch remote URLs, read local
file paths, or invent an AiPASS upload endpoint. Implementing uploads requires
observing the logged-in AiPASS UI's real attach-and-send flow first.

Custom AiPASS-assistant binding is also optional and disabled by default. Set
`AIPASS_ASSISTANT_FIELD` only after capturing and verifying the actual
first-party new-chat form field; the bridge refuses a requested binding when it
has not been configured instead of guessing.

## Cline setup

1. Start the bridge from the repository root:

   ```powershell
   node aipass-bridge/bridge/server.mjs
   ```

   `npm run dev` is equivalent when npm is functioning on the host. Set
   `AIPASS_BRIDGE_API_KEY` first if you want the local endpoint to require a
   bearer token.

2. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select `aipass-bridge/extension`. Sign into AiPASS,
   open `https://de.aipass.net/chat`, and keep the tab open.

3. Confirm `http://127.0.0.1:8787/status` reports an extension connection.

4. In VS Code Cline choose **OpenAI Compatible** and set:

   ```text
   Base URL: http://127.0.0.1:8787/v1
   API Key: AIPASS_BRIDGE_API_KEY (or any non-empty value if unset)
   Model ID: one returned by http://127.0.0.1:8787/v1/models
   ```

The bridge binds to `127.0.0.1` by default. Do not expose it publicly.

## Cline request model

One Cline task maps to one freshly created AiPASS conversation. The bridge does
not select or reuse the account's latest normal chat. A client task/session id
header is used when available; otherwise the stable early task context is
fingerprinted. Sessions expire after one hour by default
(`AIPASS_CLINE_SESSION_TTL_MS`). They are in-memory only; a bridge restart
creates a fresh execution-context cache from Cline's canonical transcript.

The bridge keeps delivery metadata only: task-to-conversation mapping, selected
model, tool-set hash, message delivery hashes, pending call ids, delivered tool
result ids, attachment metadata, and a compact semantic checkpoint. It does not
persist prompts, source files, tool results, or AiPASS credentials by default.

On the first turn it sends a cooperative task contract, compact tool summaries,
the non-privileged client instructions, and the current user task. Later Cline
requests often resend their full transcript; only new user information and
`role: tool` results are sent upstream. A tool result is represented as:

```text
CLINE TOOL RESULT
call: call_123
tool: read_file
<result>
...
</result>
```

Long sessions use Cline as the source of truth. Once the approximate delivered
context exceeds `AIPASS_CLINE_CONTEXT_BYTES` (default `180000`), the bridge
creates a fresh AiPASS conversation with a compact checkpoint of the task goal,
latest decision, recent result summaries, tool contract, and pending work.

## Tool protocol

AiPASS Web does not expose Cline's OpenAI function-call interface directly, so
the model receives a compact textual protocol. The client-provided OpenAI tool
schemas stay local and authoritative. The model may request tools using only:

```text
ACTION read_file
INPUT
{"path":"src/server.mjs"}
END
```

Multiple blocks are allowed. Before emitting OpenAI `tool_calls`, the bridge
checks that every requested tool exists in the current Cline request, parses its
JSON, and validates it against the original schema. Unknown, malformed, or
schema-invalid calls fail closed; no tool is executed by the bridge. Valid calls
become normal OpenAI `assistant.tool_calls` responses with stable `call_…` ids,
including streamed `delta.tool_calls` chunks when `stream: true`.

## Failures and diagnostics

The extension reports only safe upstream diagnostics: bridge session id,
conversation id, semantic category, byte length, attachment count, model, and
HTTP status. It does not log message bodies, source, command output, schemas,
cookies, authorization headers, or credentials. A 403 does not mark the Cline
message or tool result as delivered. A missing/busy conversation, disconnected
extension/tab, interrupted stream, malformed tool request, or unverified
attachment upload returns a provider error to Cline instead of switching to an
unrelated chat or model.

No request rewriting, token substitution, content splitting, or source-line
omission is used to work around AiPASS access controls or filtering. If AiPASS
rejects a legitimate turn, reduce context through normal task compaction or
report the failure.

Set `AIPASS_DEBUG=1` (or `AIPASS_LOG_LEVEL=DEBUG`) for the safe metadata above.

## Existing terminal tools

```powershell
node aipass-bridge/chat.mjs
node aipass-bridge/agent.mjs "Explain this project" --root .
```

`agent.mjs` remains a separate local CLI with its own explicit file-action
format. It is dry-run by default; use `--apply` to write and `--allow-run` to
allow its shell action. It is not part of Cline's tool execution path.

## Tests and live validation

Run the suite with:

```powershell
node --test aipass-bridge/test/*.test.mjs
```

The tests use a scriptable extension stand-in, so they validate the HTTP and
browser-job protocol but **do not prove a live AiPASS account**. They cover
plain chat, initialization, system/developer normalization, arbitrary tools,
tool-call validation, multiple sessions, streaming calls, tool-result
continuation, idempotent transcripts, upstream rejection state, restart,
checkpointing, Cline model selection, and attachment failure behavior.

Live validation still required after signing in:

1. Plain Cline chat.
2. Read → tool result → final answer.
3. Read → edit → final answer.
4. A full read/search → test → edit → test loop.
5. One custom/MCP tool.
6. At least two AiPASS model families, including a system-prompt conflict case.
7. Image and file attachments only after observing and implementing the genuine
   AiPASS Web upload flow.
