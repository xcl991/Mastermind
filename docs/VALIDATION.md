# Validation and operating boundaries

Mastermind includes tests for revision-safe storage, process contention, interrupted writes, recovery, retrieval, query limits, MCP transports, HTTP boundaries, and local infrastructure. Browser checks cover editing, navigation, mobile layout, structured views, and adversarial preview content. Tests use temporary synthetic workspaces.

Local validation has been performed on macOS arm64. The CI matrix targets Node 22/24 on Linux, macOS, and Windows, plus Chromium browser checks. Workflow configuration is not itself proof that every platform run has passed; consult the current repository Actions results.

## Covered scenarios

- Concurrent and stale-revision writes; originals and conflict drafts retained.
- History/trash restoration and rollback without overwriting newer content.
- Complete snapshots, checksum validation, new-directory restore, and malformed paths.
- Symlinks, traversal, invalid UTF-8/JSON, request size/depth limits, and request concurrency limits.
- Read-only state boundaries, graph import limits, and extension manifest validation.
- Official MCP SDK discovery and calls over stdio and local HTTP.
- Authenticated lifecycle control, duplicate start, occupied ports, and hard-kill recovery.
- Repeated read/query and revision-checked edit workloads.
- HTML/script/event sanitization, query values rendered as text, and nonexecution of embedded scripts.

## Limits

HTTP trusts the local machine and remains loopback-only. MCP bearer authentication is not a UI login or multiuser authorization system. This is not a public-hosting security certification.

Filesystem checks reduce accidental path escapes but do not sandbox a malicious local process with the same permissions. External editors do not participate in application locks. Backup requires all writers to stop; checksums and maintenance coordination do not create an atomic filesystem snapshot across independent programs.

Directory fsync support varies. Hard crash, power loss, disk-full behavior at every instruction, every filesystem, and long-duration soak scenarios have not been exhaustively tested. Stale ownership that cannot be verified requires inspection rather than automatic deletion.

Retrieval benchmarks use synthetic text and an approximate token counter. They do not measure a provider invoice or certify semantic answer quality. Compatibility covers documented capabilities, not all client versions, languages, or extensions.
