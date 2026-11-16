# Editing workflows and recovery

Mastermind workflows use the same revision-checked Markdown storage as the editor. They never execute note text, template expressions, or imported archive contents. All mutations reject read-only vaults.

## Rename and move

Call `previewRename(vault, {path, targetPath, expectedRevision, updateLinks:true})` first. The preview returns `planHash`, the canonical `source`, `target`, changed-file revisions, replacement counts, warnings, and a `blocked` array. Preview reads source files and does not create a state directory. Submit the same arguments plus `planHash` to `applyRename`. If a relevant file changed after the preview, the plan is rejected.

Supported rewrites include wikilinks with aliases, heading/block fragments, ordinary Markdown links, image links, and reference-style link occurrences. Reference occurrences become explicit inline links; their original definitions remain. Outgoing links in a moved note are adjusted to preserve their resolved targets, including direct local attachments. Source spans are checked against the actual bytes before replacement. An ambiguous/unsupported span, overlapping link, or unresolved relative link in the moving note blocks the rename.

Only active Markdown links in indexed Markdown notes are rewritten. Links in code/comments, arbitrary frontmatter strings, HTML, ignored/hidden files, external applications, and unindexed files are not rewritten. The preview always states this boundary. `updateLinks:false` intentionally leaves other notes' backlinks unchanged. Case-only or Unicode-normalization-only renames require an intermediate distinct filename; this avoids accidental replacement on case-insensitive filesystems. Existing destinations are never overwritten.

A rename creates the new destination, updates backlink files with their own revision checks, then moves the original into recoverable trash. Before any source mutation, `.mastermind/workflows/<id>.json` stores a durable journal with checksummed before/after snapshots. Each completed step updates this journal. Maximum scope: 300 changed notes and 16 MiB of raw snapshots.

This is a recoverable sequence, **not an atomic transaction across files or applications**. Other editors can change files during the sequence. A failure may leave some links updated while both paths exist; the returned error names the workflow ID.

## Recovery

`listWorkflows(vault)` returns the latest 100 journal summaries with phases and any conflicts. `recoverWorkflow(vault, {workflowId, action:'rollback'})` is an explicit operation; it is never replayed automatically on startup.

For rename rollback:

- Restore the original source first if it is absent; refuse to overwrite a changed source.
- Revert a backlink only when its revision still matches the workflow's written revision. Already-original files are left alone.
- Keep externally changed or missing backlink files untouched and report conflicts. A file whose completed write was not durably recorded is retained as uncertain, even if its bytes match the planned output.
- Remove the new destination into trash only if its revision still matches and no remaining indexed backlink targets it. If anything is uncertain, keep both copies.
- Repeated rollback after `rolled-back` is idempotent.

A `rollback-conflict` journal retains all snapshots. Resolve the reported files manually and retry if appropriate. Do not delete journal/history/trash data merely to silence a conflict. Checksums and a vault-root identity are verified before journal recovery.

All cooperating processes must share the same `stateDir`; individual file writes and workflow mutations have separate locks and revision checks. External editors do not participate in these locks, and a narrow filesystem race still exists between a final check and rename.

## Task checkboxes

`updateTask(vault, {path, line, completed, expectedRevision})` toggles one checkbox and preserves other bytes, including CRLF. The line must parse as an active Markdown task. Fenced/indented code, HTML comments, workspace `%%` comments, and frontmatter checkbox examples are rejected. Supported statuses are `[ ]`, `[x]`, and `[X]`; other custom task statuses are not silently converted. The exact current note revision is required.

## Properties

`updateProperties(vault, {path, properties, remove, expectedRevision})` changes top-level YAML fields using the YAML document parser, retaining comments where the parser can preserve them and leaving the body bytes untouched. Invalid YAML, duplicate mapping keys, excessive aliases, non-JSON values, and prototype-related keys are rejected. Field values can be strings, finite numbers, booleans, null, bounded arrays, or plain objects. Body content is never generated or reformatted by this operation.

## Templates

`createFromTemplate(vault, {path, templatePath, title, date, time})` creates a new Markdown file. Alternatively provide an inline `template` string instead of `templatePath`. These sources are mutually exclusive. Templates are limited to 16 KiB and can use only `{{title}}`, `{{date}}`, `{{time}}`, and `{{path}}`. Unknown placeholders fail clearly. No JavaScript, shell, Templater, or plugin code runs. Date/time defaults are UTC (`YYYY-MM-DD`, `HH:mm`); callers may provide an explicit local date/time. An existing destination causes a conflict. `expectedTemplateRevision` optionally pins a file-backed template.

## ZIP restore

`previewRestore(vault, {archiveBase64})` validates a ZIP and returns a reviewable file list, checksums, conflicts, and `planHash`. `applyRestore(vault, {archiveBase64, planHash})` creates only absent notes. Any existing destination blocks the entire plan before normal execution; a concurrent create can still interrupt execution and is never overwritten.

The restore contract is deliberately narrow:

- 1–300 `.md` files; optional `mastermind-backup-manifest.json` with matching revisions.
- Maximum 8 MiB ZIP, 16 MiB expanded total, 2 MiB per file.
- UTF-8 note contents and UTF-8/ASCII filenames; no binary control data.
- CRC and manifest hash verification; ZIP central/local headers and sizes must agree.
- No symlinks, special files, duplicate/case-colliding paths, hidden paths, traversal, encrypted ZIP, ZIP64, multi-disk archives, or unsupported compression.
- Non-Markdown attachments/plugins/state are not restored by this workflow.

Restore operations use the same workflow journals. Rollback moves only unchanged restored files whose creation was recorded as complete into trash and preserves any files edited afterward. Journals remain available after interruption. For full vault backups including attachments, use a filesystem backup independently; the current web backup/restore feature concerns Markdown notes.

## Validation

`node --test tests/workflows.test.mjs` exercises actual file mutations, dry-run behavior, backlink rewriting, interrupted renames, non-clobber recovery, code-excluded task toggles, YAML body preservation, template injection rejection, archive path/symlink/size/CRC checks, and read-only enforcement. These fixtures do not establish zero-defect behavior on every filesystem or compatibility with all third-party plugins.
