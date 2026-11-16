# Agent interoperability contract

Mastermind 0.3 implements MCP stdio and local Streamable HTTP with JSON responses. Compatibility means a client can negotiate one of the advertised protocol versions and use the implemented capabilities. It does not mean every agent, future protocol revision, cloud runtime, or model has been tested.

## Transports

- Stdio: run the Node CLI `mcp` entry point directly. The client owns the process; stdout carries newline-delimited JSON-RPC only.
- HTTP: the application exposes `/mcp` when enabled by its server configuration. Use a Streamable HTTP client and send both `application/json` and `text/event-stream` in `Accept`. JSON request replies are returned directly; accepted notifications receive 202 with no body. GET and DELETE receive 405. There is no SSE, legacy SSE, server push, resumability, or MCP session ID.
- HTTP supports versions 2025-11-25, 2025-06-18 and 2025-03-26. Stdio also negotiates 2024-11-05. Unrecognized proposals negotiate the latest supported version; clients decide whether to proceed. Unsupported HTTP version headers are rejected.
- HTTP is loopback-only with Host/Origin validation, 4 MiB request bodies and 16 concurrent requests. An optional bearer secret must be supplied from a server environment/configuration, never generated from a provider API key or echoed in exported config. It is local shared-secret authentication, not OAuth or remote multiuser authorization.

The transport follows the supported subset of the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Official SDK tests exercise real HTTP requests and stdio discovery; they do not establish compatibility with untested commercial client versions.

## Discovery and capabilities

`initialize` advertises tools, resources, and prompts. It does not advertise subscriptions, list-change notifications, completion, logging control, tasks, sampling, elicitation, or roots. Unknown methods return JSON-RPC errors. Tool schemas use recursive validation; unknown properties, invalid source receipts, prototype fields, wrong types and out-of-range values are rejected before execution.

Profiles control the offered tools:

| Profile | Capability |
| --- | --- |
| minimal | get_context, get_section, project_map |
| research | Minimal plus search, list, bounded reads, graph navigation; query/task-list/health tools when wired by the application |
| full | Research plus revision-safe writes, findings, task/property updates, template creation, structured .base/.canvas writes and rename preview/apply when implemented |

Read-only vaults omit mutation tools even in the full profile. Optional tools are listed only when the application supplies their implementation; they are not stubbed successes. `rename_note` defaults to preview and requires the preview's `planHash` for apply. A rename plan does not grant permission beyond the user's requested edit.

`update_properties` accepts selected arbitrary safe property names and recursively validated JSON values, bounded to 64 KiB, 4,000 characters per string and 100 entries per collection. It requires the current note revision. `create_from_template` requires `expectedRevision:null` and exactly one `templatePath` or inline `template`; optional `expectedTemplateRevision` pins a stored template. It supports only title/date/time/path substitution and never replaces an existing note. `write_document` validates `.base` YAML and `.canvas` JSON before a revision-checked write; null creates only. Formulas and scripts are not executed. Creation responses carry path/revision receipts rather than echoing document bodies.

`resources/list` exposes `mastermind://guide` and `mastermind://capabilities`. The resource template `mastermind://note/{path}{?startLine,endLine}` reads a URL-encoded vault-relative path with default 80 lines, at most 200 lines/18,000 characters. Output includes its revision and delivered line range. Resource URIs do not grant access outside the selected vault.

`prompts/list` offers `vault_research(question)` and `note_review(path)`. They generate instructions for the client; they do not invoke a model or modify notes.

## Context and cost

Use a specific query and an initial estimated budget around 1,000 tokens. Read a known heading directly when that is cheaper. Keep citations and source revisions. The server never calls a model API. UTF-8 bytes/3 is an estimator, not the provider tokenizer; tool schema, request framing, history, output and cache pricing are separate.

Delta suppression is opt-in and belongs to explicit context receipts/session IDs, not HTTP transport sessions. Use a unique random `sessionId` per agent conversation; reset it after compaction, history loss, or switching clients. Otherwise earlier evidence could be omitted even though the model no longer has it. No automatic saving of generated answers occurs: `save_finding` is a separate authorized write and source freshness is not truth verification.

## Client configuration exports

`clientConfig()` returns data without writing global/project configuration. Merge only the named server into the intended client config; do not replace an existing config file.

| Format | Shape / intended host |
| --- | --- |
| json / claude | `mcpServers.mastermind`; Claude Code stdio or HTTP |
| cursor | `mcpServers.mastermind`; named stdio type or HTTP URL |
| codex | `[mcp_servers.mastermind]` TOML |
| copilot | Native Copilot `mcpServers.mastermind`, explicit tools selection |
| vscode | Editor-managed `.vscode/mcp.json` top-level `servers`; legacy Local harness compatibility |
| opencode | OpenCode V2 `mcp.servers.mastermind`; V1 configuration is different |

HTTP exports use `transport:'http'`, an explicit `url`, and optional `tokenEnv:'MASTERMIND_MCP_TOKEN'`. They contain only environment-variable references. Generic JSON intentionally refuses a token reference because interpolation is not universal. The stdio export preserves the chosen vault, read-only flag, external state directory, exclusions, and profile.

Configuration tests verify each exported schema and preserve vault scope, read-only mode, and profile selection. Commercial client sessions have not all been run; consult the host documentation for the installed version.

DeepSeek and Venice can supply models to a compatible agent host. A provider API alone does not run stdio tools. For a client without MCP, use CLI `context --text` or copy from the context panel. Remote/cloud agents cannot reach another machine's loopback endpoint automatically.

## Reference workflows and skill bundle

The packaged `skills/mastermind/SKILL.md` follows the open SKILL.md structure. It is an original Mastermind workflow, not a copy or automatic installation of third-party skills. It combines bounded retrieval, source provenance, explicit saving and vault health checks. Its existence in this repository does not register it with a client; place it in the selected client's supported skill location when desired.

Mastermind separates retrieval from explicit saving, preserves source provenance, and checks vault health. Its packaged skill uses the Mastermind API and storage engine; open-format compatibility does not imply support for third-party plugin runtimes.
