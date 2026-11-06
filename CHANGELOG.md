# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to semantic versioning after the bootstrap line is established.


## [Unreleased]

## [1.1.32] - 2026-11-06

### Added
- Tmux prompt, steering and settled-result transport up to 128 KiB UTF-8; exact-job live inspection retains only the latest assistant prefix up to 8 KiB, not a full transcript.
- Nullable per-job token/context/elapsed telemetry, partial observed tool-write evidence and reporting-only `may_write` evaluation. Neither evidence nor globs grant write permission or prove a filesystem diff.
- Tmux `maxTurns` from 1 to 1024 as a per-job provider-request cap; trusted declared direct extension tools; finite offline-catalog fallback selection before dispatch only, with at most seven ordered run fallbacks and frozen selected-model reuse.
- Explicit prepare/start/discard for reviewed tmux result-context continuation into a new worker/session/run/task under current policy: complete 32 KiB prompt, 16 private owner-lifetime sources, 16 reviews and five-minute review expiry. Only the conservative exact-file import/resource subset is supported; no full history, fork, reconnect or historical resume.

### Fixed
- Preserve current standalone/team/native resource behavior outside the stricter continuation preflight; restore current-authority and cancellation guards on public worker close while retaining internal cleanup after revocation.
- Observe pre-submission continuation startup failure atomically for its exact still-current owner, without granting execution authority or overwriting a replaced/disposed owner.

### Changed
- Document the tested subset and its refusals. Isolated offline Pi/tmux fixtures are not normal-operator-environment acceptance; workflows, staged coding, automation, general MCP, manual/assisted permissions and full-transcript UI remain unsupported on tmux.
- Exclude the blocked capability-broker experiment from build, package and test discovery. Its socket-cleanup design is not shipped or integrated. Npm publication is separate from this Git release.

## [1.1.31] - 2026-11-05

### Added
- Up to eight independent persistent tmux workers per controller, with exact worker/job routing and isolated cancellation, close, and result retention.
- Configured tmux teams with atomic member/leader slot reservation, bounded FIFO member execution, leader aggregation, exact parent cancellation, and immutable member results.

### Changed
- Worker capacity includes setup, idle, closing, and unconfirmed cleanup. Disposal cleans every owned worker; standalone concurrency and the native default are unchanged.

## [1.1.30] - 2026-11-04

### Added
- Opt-in standalone tmux workers that keep the same interactive Pi session open between tasks, with explicit human takeover/return and close controls.
- Exact per-task results, bounded local control, and owned-process cleanup on disposal or parent loss. Native execution remains the default.
- Offline real-Pi acceptance fixtures for shared control, result immutability, cancellation, setup refusal, disposal, and parent-crash cleanup.
- Larra-only MCP gateways and named aliases for tmux workers, with normalized operation denies, recursive-controller blocking, bounded per-call subprocesses, and cancellation cleanup.

### Fixed
- Preserve the current job's bounded partial assistant text when cancellation appends an empty error message; never substitute another job's text or label it a successful result.

### Changed
- Document the opt-in tmux preview, Larra setup and permission limits, and the distinction between synthetic Pi/tmux acceptance and the actual Larra read-only bridge check; update npm installation guidance for the already-published native release.

## [1.1.29] - 2026-11-02

### Fixed
- Avoid repeated general-purpose wrapping work for long, unbroken printable ASCII in the coding overlay. Preserve exact displayed text, padding, existing limits, and the Unicode/whitespace fallback without adding a retained cache.

### Changed
- Clarify installation, single-copy migration, worker results, model costs, and current limitations on the GitHub page. Npm publication is pending; a tmux backend and interactive terminal takeover are not shipped.

## [1.1.28] - 2026-11-01

### Changed
- Replace the GitHub-page logo with the updated animated Clankers artwork and regenerate its matching non-animated alternative. Runtime behavior and saved data remain unchanged.

## [1.1.27] - 2026-11-01

### Added
- Original animated uni-wheel robot logo with 1980s CRT/neon styling and a linked non-animated alternative.

### Changed
- Rename the GitHub repository to `rustytensor/pi-clankers`; update package metadata, installation links, and the public page.
- Document removing the old Pi source declaration before adding the renamed repository URL. Saved-data paths, compatibility aliases, and runtime behavior remain unchanged.

## [1.1.26] - 2026-11-01

### Added
- Canonical `/clankers` command with `/clank` short alias, and `clankers_control` structured tool.
- Canonical `pi-clankers-automation` executable alongside the existing `pi-zerg-automation` alias, both using the same CLI.

### Changed
- Rename the package and public branding to Clankers (`pi-clankers`); align metadata and runtime version to 1.1.26.
- Use current owner handle `rustytensor` for GitHub/npm/X references. The Git repository slug remains `rustytensor/pi-zerg-swarm`; historical attribution and contact email are unchanged.
- Document unsupported dual installation: inspect `pi list`, then remove or disable the exact old declaration across personal/project settings and explicit extension paths before adding a different source. Old v1.1.25 copies do not cooperate; no dual-install guard or automatic global configuration edits are provided. Do not delete saved data.
- `/zerg`, `/zerg-swarm`, and `/swarm` remain functional aliases; deprecated `zerg_control` shares the same controller without per-call warnings.
- SDK export names, stored data paths, session/result protocol identifiers, authority values, and runtime permission boundaries remain unchanged. No dependency changes or npm publication are implied.
- Updating the same unpinned Git URL retains one package identity; a v1.1.25 pin requires explicitly selecting v1.1.26.

## [1.1.25] - 2026-10-31

### Added
- Native worker completion notices and `agents.result` / `agents.results` retrieval, with exact assistant text, explicit truncation, execution identities and preserved failure/abort output.
- Optional checked JSON results using a bounded offline Ajv draft-07 profile, without remote references or data coercion.
- Reporting-only `may_write` globs and observed write-path violations, with explicit incomplete coverage rather than sandbox claims.

### Changed
- Worker handoffs use result delivery instead of automatic communication-file writes. Existing run summaries remain bounded previews.
- Completion notices stay bound to the initiating Pi session; retained results survive notification failure and restore as historical data without replay.

## [1.1.24] - 2026-10-09

### Added

- An original, self-contained 1980s-style pixel-art swarm logo for the GitHub landing page, with accessible SVG title and description.
- An explicit non-affiliation note distinguishing the project's original agent-drone artwork from Blizzard characters and assets.

### Changed

- Refresh README branding and make structured-control action help easier to find. Runtime behavior and approval boundaries are unchanged.

## [1.1.23] - 2026-10-09

### Added

- Bounded, read-only `zerg_control` help: a grouped public-action directory and exact-action topics with arguments, examples, side effects, and authority restrictions.
- A typed public-action catalog shared by structured help, the tool schema's action enum, and accepted-action discovery; trusted-only approval and recovery execution APIs remain excluded.

### Fixed

- Unknown structured-control actions now return bounded, sanitized errors with a help hint. Malformed help requests fail explicitly without initializing workflows, changing state, or launching work.

## [1.1.22] - 2026-10-09

### Added

- A visual GitHub feature showcase with four accessible, self-contained SVG diagrams for native swarms, workflow orchestration, the management control room, and explicit recovery.
- Outcome-focused introductions and navigation covering agent teams, typed workflow graphs, staged coding approvals, exact-session observation and messaging, background activity, and local read-only automation.

### Changed

- Replace obsolete planned-runtime architecture guidance with the implemented native execution and workflow model, while retaining the detailed reference and authority boundaries.
- Include public diagram assets in the explicit package allowlist so README illustrations remain available to packaged readers. Runtime behavior is unchanged.

## [1.1.21] - 2026-10-09

### Added

- Compact, bounded background activity below Pi's editor for locally observable standalone agents, team queues/leaders and workflows, with exact identity deduplication, honest phases/progress and inert recovered-history labels.
- Configurable Alt+G management opener sharing `/zerg config`, dedicated human UI preferences, independent strip visibility, active-versus-pending reload status, and conservative Pi/user/extension/terminal-equivalence conflict checks with command fallback.

### Changed

- Cached, event-coalesced observation and active-only elapsed updates isolate rendering failures and lifecycle cleanup from native execution, approvals, tools/models and workflow authority. Existing editor/footer/widgets and non-interactive operation remain independent.
- Run test files serially without relaxing lifecycle or performance assertions; quota acceptance validates complete read-event sets without assuming parallel tool completion order.

## [1.1.20] - 2026-10-07

### Added

- A foreground Linux-local `pi-zerg-automation` runner for explicitly enabled, hash-approved read-only workflow profiles. Strict four-field UTC occurrence requests carry no task, input, model, permission, or approval overrides; fixed inputs and the full potential graph are validated from trusted configuration.
- Isolated state/session/agent locations, same-manager exclusive ownership, atomic event-to-attempt reservation before native scheduling, historical duplicate/conflict inspection, bounded retention with monotonic rejection/rate/clock floors, and no queue, catch-up, replay or unsafe takeover.
- Reviewed custom scoped UTF-8 reading through public Pi SDK APIs with sealed resources, one explicit physical model/thinking policy, environment credential references, pinned safe model metadata, and cumulative read/admission/provider-preparation/runtime/output bounds.
- Public profile/hash, admission and runner APIs; complete disabled-profile setup, manual foreground commands and a disarmed stable-occurrence external-wrapper example. Scheduler installation, publication, hard spending guarantees, OS sandboxing and DLP remain outside scope.

### Fixed

- Keep foreground automation alive through deadline cancellation and cleanup; persist final outcomes before the last settled owner release, and retain uncertainty instead of claiming reconnection or closure.
- Hard quota refusals cancel the bound run so failed delivery cannot become a successful duplicate. Inert recovery evidence verifies the already-prepared writer without reacquisition; ordinary internal persistence ownership and conservative unknown/nonreusable source semantics remain unchanged.

## [1.1.19] - 2026-10-06

### Added

- Restricted, versioned JavaScript-subset workflow authoring with immutable data/step handles, explicit references and dependencies, display-only phases, typed conditions, bounded repeat feedback, existing aggregation and supported coding requests. Accepted source lowers to the existing validated declarative engine; submitted JavaScript is never executed.
- Separate bounded `workflows.scripts.validate`, `compile`, `inspect`, `save` and explicit local-file `import` controls with slash-command/alias parity. Validation and inspection remain inert, while save/import never imply start or grant approval.
- Deterministic source/compiler/graph hashes and bounded authored-address/source-location provenance in frozen definitions, existing progress views and snapshots. Unsupported compiler formats require migration; restart does not recompile source or restore authority.
- Two public read-only examples with equivalent declarative graphs, a precise language guide, focused adversarial regressions and opt-in isolated SDK, regular/fullscreen Pi-host and offline packed-layout acceptance fixtures.

### Changed

- Parsing uses pinned TypeScript 5.9.3 as a declared runtime dependency in an owned, deadline-limited compiler child. Source, token, nesting, AST, literal, expansion, output and diagnostic budgets are explicit; cancellation/disposal drains owned parser work. These bounds are not an OS sandbox or full JavaScript/Claude feature parity.
- Authored worst-case family admission checks include native and coding operations without increasing engine limits or adding another scheduler, runner, approval registry or recovery system. Existing Stage 8C uncertainty and historical-result-reuse restrictions remain unchanged.

### Fixed

- Recovery-test approval polling now recognizes an in-time pending gate observed after a delayed timer wake, while rejecting gates created at or after the original deadline; runtime approvals and the ten-second test deadline are unchanged.
- Authoring save rechecks owner/caller cancellation after reentrant lazy workflow initialization, preventing a definition from being saved after its owner is disposed.

## [1.1.18] - 2026-10-06

### Added

- Opt-in durable workflow recovery with inert startup and read-only `workflows.recovery.inspect` / `prepare`, immutable original status evidence, and separate current owner, receipt, artifact, and destination observations.
- Trusted-host-only exact recovery confirmation, explicit bounded execution-address selection, selection-bound fingerprints, one durable linked child, and fresh generation-bound execution through the existing scheduler; no model-callable recovery grant or restored approvals.
- Optional exact-request-bound `inspectNativeSettlement` host observation, defaulting to unknown without positive caller-owned lifecycle proof. A settled return must attest irreversible exact owned-work closure, not temporary idleness or revocable permission. PID/supervisor absence alone is not settlement; enum reads do not certify an adversarial host's hidden revocation, and no generic SDK native closure provider is supplied.
- Monitor flow: prepare, read-only recommendation reprepare, arm/render full exact proof, then explicit host confirmation. Stale or clipped proof cannot authorize.
- New isolated actual SDK and regular/fullscreen Pi-host recovery fixtures with owned process interruption and narrowly sealed loopback transport closure proof. Applied-source transport journeys and independent release review pass. Scripted evidence is not power-loss, manual visual, real-model quality, or universal compatibility certification.

### Changed

- Recovery fencing uses the existing authoritative snapshot writer, Linux boot/PID/start identity, lifetime generation and exclusive claim, expected-head checks, save-before-publication, and failure poisoning; inspection never acquires ownership or cleans retained evidence.
- Managed candidate carry is separate from completed native-result reuse: fresh implementation approval, a new writer, new checks, independent review, and separate application approval are required. Already-satisfied paths stay read-only and are not rewritten; fully satisfied zero-write completion remains blocked pending an explicit observation-completion path.
- Linked attempts retain cumulative three-attempt/256-admission family limits, per-repeat writer/correction allowances, anchors, and provenance. Unknown dependency/environment contracts disable generic native/check/review result reuse and normally give repeat frontier zero; deterministic aggregates recompute. Uncertain receipts remain uncertain without effect attribution, and no automatic Git, installation, publication, or recovery replay is introduced.

## [1.1.17] - 2026-10-04

### Added

- Opt-in version-3 coding workflows with separate trusted implementation and application approvals, exact attempt/policy/baseline/candidate binding, revocation, and no model-facing approval action. Existing version-1 and version-2 workflows remain read-only.
- Bounded, owned text-file staging; a single controlled writer; deterministic approved checks; independent read-only native review; and corrections using the existing repeat scheduler. Application rechecks freshness, preserves unrelated changes, and records per-file partial outcomes without automatic rollback or Git operations.
- Sealed native coding tools, compact exact-attempt approval inspection, trusted interactive confirmation, coding monitor evidence, and a compile-tested disposable-project example.
- A bundled Linux/Python check supervisor with subreaper and pidfd support, bounded output/timeouts, cancellation and descendant cleanup. Project checks run with host permissions, not a filesystem or network sandbox; no dependencies are installed automatically.
- Regression and actual isolated SDK plus regular/fullscreen Pi-host acceptance for real staged edits/checks/review/correction/application, denial, stale-target rejection, cancellation, and fresh-process recovery with zero replay. Scripted loopback acceptance is not manual visual or real-model coding-quality evidence.

### Changed

- Package allowlist and explicit subpath exports include the public workflow modules, example, and check supervisor; private transfer artifacts remain excluded.
- Coding recovery retains inspectable evidence but restores no approval authority. Mutating retries and unsafe forgetting are refused; durable execution resumption remains outside this release.

## [1.1.16] - 2026-10-04

### Added

- Opt-in version-2 read-only workflows with deterministic, schema-checked scalar conditions, bounded boolean composition, explicit conditional skip reasons, and failure-honest conditional aggregation. False admission conditions start no native session.
- Bounded, non-nested repeat-until body DAGs with schema-validated initial state and feedback, explicit final-output selection, sequential iteration cleanup barriers, and honest non-convergence diagnostics. Body fan-out shares the existing workflow-wide permits and family budgets.
- Iteration-qualified unit/native provenance, input-and-transition-bound retry reuse, strict bounded snapshot validation, and inert recovery without worker replay or restored execution authority.
- Exact iteration/body/unit monitor navigation, selection and termination reasons, compact default lists, public authoring types, and a separate documented refinement example. Existing version-1 definitions and the `read-only-review` preset retain their behavior.
- Focused model/runtime/control/UI regressions and isolated actual SDK plus regular/fullscreen Pi-host conditional and looping acceptance, including fresh-process checkpoint recovery. Scripted loopback evidence is not manual visual acceptance or real-model quality evidence.

### Changed

- Worst-case graph budgeting includes repeat counts, all conditional branches, body fan-out, and existing retry attempts without increasing the existing workflow limits. Bounded iteration counts do not guarantee bounded provider cost or wall-clock duration.

## [1.1.15] - 2026-10-04

### Added

- Minimal declarative read-only workflows through `workflows.*` structured actions and `/zerg workflows`: validated named dependency graphs, bounded fan-out, deterministic aggregation, background progress, pause/resume, cancellation, and explicit fresh retries.
- A discover → parallel review → verify → deduplicate/report preset. Reports retain failed coverage, verification disagreement, and original native identities; model verdicts are evidence, not ground truth.
- A separate workflow monitor with phase/unit/result drill-down, exact native coding-view links, stale-selection guards, and rendered retry confirmation. Default lists omit intermediate results and per-unit identity dumps.
- Frozen definitions, declared JSON inputs, agents and model selections; read-only builtin tool intersection, owned setup-through-cleanup permits, and bounded workflow state in the existing snapshot store. Recovery never reconnects or automatically replays work.
- Focused model/scheduler/control/UI regressions and opt-in isolated localhost SDK/real Pi terminal fixtures. Automated terminal evidence is not manual visual acceptance, external-model quality, or universal extension compatibility.

### Changed

- Package allowlist includes workflow model/runtime modules and the workflow UI. No second agent runtime or transcript store is introduced.
- Active workflow units reject input-changing operator messages; ordinary native messaging remains unchanged. Explicit workflow retry/new-run controls preserve frozen-input semantics.

## [1.1.14] - 2026-10-03

### Fixed

- Recheck canonical read-only, cancellation, caller-signal, and owner state after observable launch publication, including bridge fallback; own native cancellation handles before publishing startup. Persist canonical state after reentrant listeners.
- Preserve observed terminal outcomes and original identities when an adapter rejects or throws. Uncertain thrown launches require manual inspection rather than automatic retry; legacy messaging respects read-only and pre-aborted requests.
- Isolate abort and unsubscribe failures so sibling cleanup still runs; clean up adapters after registration failure.
- Reserve viewer capacity before asynchronous saved-history loading and admit tool updates only with bounded current-call evidence, preventing retired tool cards from returning.
- Require last-rendered identity proof for chooser actions; harden UI cleanup, untrusted text/error formatting, terminal-control stripping before trusted theme styling, and narrow-width rendering.
- Bound snapshots to 64 MiB of serialized UTF-8, including growth during reads; reject nonregular files without FIFO hangs. Use exclusive temporary creation and owned-file cleanup on failed saves, preserving existing snapshots on size refusal.
- Preserve an already-enabled read-only setting during recovery. Keep valid regular-target snapshot symlink loads compatible; saving still replaces the configured link rather than its target.

### Added

- Focused lifecycle, history, UI, persistence, and fixture-safety regressions; credential-free bounded SDK/PTY fixtures with owned-process cleanup checks.
- A deterministic coding journey using genuine SDK read/edit/test tools, independent review and verification, exact messaging, explicitly approved fresh continuation, cancellation, and fresh-process recovery without replay. Scripted responses are integration evidence, not model-quality or manual visual certification.

## [1.1.13] - 2026-10-03

### Added

- Explicit continuation through `session.continuation.prepare` / `start` / `discard`, `/zerg sessions continue`, and coding-view **n**. A separate literal-task editor and current-authority review require **Ctrl+Y** confirmation; existing **b** branch inspection and **c** live messaging keep their meanings.
- Non-executing preparation binds the exact source tuple, native entry and fingerprint, literal task, current definition/model/tools/permissions, and bounded known resource inputs. Owner-local, expiring, one-use approval rejects stale source/policy, conflicting admission, cancellation, and read-only execution. Historical permissions remain unknown.
- Fresh task/run/Pi identities and durable explicit lineage for only the selected agent. Public native context projection preserves compaction and context edits; an exclusively created destination imports history without opening or modifying the original, replaying queues, reviving siblings, or restoring historical authority.
- Normal Pi resources, extensions, skills, and hooks after authorization, with a final admission/model check immediately before the provider request. Startup side effects are authorized, not rolled back or sandboxed; inherited assistant output cannot count as new-task completion.
- Core/UI regressions, isolated localhost public-SDK coverage including normal-hook read-only/model drift, and actual regular/fullscreen continuation and fresh-restart PTYs. Existing live composer and messaging compatibility checks remain covered.

### Changed

- Package allowlist and documentation include the native history/continuation modules and separate review UI. Recovery preserves inspectable lineage but never restores approval tokens, reconnects, or automatically executes.

### Fixed

- A shutdown polling race in continuation/composer terminal smoke controllers no longer reports a successful host exit as premature; explicit host-result and exit-code checks remain intact.

## [1.1.12] - 2026-10-03

### Added

- Read-only team/run communication timeline through `/zerg timeline`, `timeline.list`, and management tree/detail **t**. Exact AND filters, stable row IDs, bounded previews, explicit omission notices, paused/follow scrolling, and full-identity details work without a terminal UI dependency for structured/text inspection.
- Identity-checked **v** navigation from the last rendered selected timeline row to its exact coding view, with a fresh timeline instance on return. Missing/stale proof never selects another row or leader; viewer close leaves runner ownership and task-final SDK disposal unchanged.
- Distinct current operator receipts, provenance-linked native output/handoffs, recorded events, and current run/member snapshots. Historical scope survives missing live references; output is not inferred to be an addressed reply, and current status is not invented transition history.
- Focused projection/control/UI regressions, an isolated localhost public-SDK timeline fixture, and actual regular/fullscreen Pi PTY coverage for concurrent exact workers, literal filter paste, queue consumption, coding round trips, resize, saved history, and fresh restart without replay or native-file changes.

### Changed

- Command help, package contents, and workspace guidance include the timeline. Existing snapshot/native JSONL stores, exact messaging receipts, legacy chooser behavior, and lifecycle semantics remain unchanged; no transcript mirror, automatic sibling wakeup, reconnect, or resume is introduced.

## [1.1.11] - 2026-10-03

### Added

- Explicit live agent composer in the exact-session coding overlay: **c** to edit, Enter for newlines, **Ctrl+S** to send, **Alt+M** for follow-up/steering, and Escape to retain the draft before closing. Historical branches and saved, captured, completed, disconnected, or read-only sessions cannot send.
- Additive `session.message.send` / `session.messages.list` structured actions and `/zerg sessions send` / `messages` commands. Literal custom-message content bypasses command/template/input expansion; exact parent/member/Pi IDs prevent fallback routing, and globally unique caller IDs prevent accidental resends or retargeting.
- Bounded intent/receipt ledger with separate transport and persistence states, opt-in pre-enqueue snapshot barriers, and restart quarantine without replay. Native consumption is distinguished from queue acceptance, provider acknowledgement, completion, and transcript durability; save failures preserve observed transport status.
- Admission rechecks for read-only/cancellation changes, isolated messaging cleanup, bounded/sanitized drafts and receipts, stale-response protection, and visible whole-packet paste rejection. Viewer close remains independent of runner cancellation and task-final SDK disposal.
- Regression coverage plus isolated localhost public-SDK and actual regular/fullscreen Pi PTY messaging fixtures for literal multiline input, routing/deduplication, queue consumption, cancellation, history inspection, resize, and close-without-abort behavior.

### Changed

- Known operator-message content is visible in native raw history without exposing opaque custom metadata. Command help, package contents, and workspace guidance include the new composer and receipt controls; legacy messaging remains unchanged.

## [1.1.10] - 2026-10-02

### Added

- Read-only native coding overlay via `/zerg sessions [parent-run-id]` and management tree/detail **v**, with exact parent/member/Pi-session selection, streamed text/thinking/tool cards, paused scrolling, and local raw-branch inspection. `/zerg sessions list` provides a bounded noninteractive fallback.
- Owner-scoped live transcript observers and validated read-only native JSONL loading. Existing viewers preserve bounded detached captures; new views can inspect saved history without reconnecting, replaying prompts, changing the active leaf, or retaining completed SDK runtimes.
- Bounded extraction, omission notices, terminal-control sanitization, observer fault isolation, exact header/provenance/graph checks, and regular-file/symlink/race protections. Raw history is explicitly distinguished from effective model context.
- Focused UI/history/lifecycle regressions, a localhost-only public SDK transcript fixture, and an isolated actual Pi PTY smoke fixture for regular/fullscreen rendering, resize, closing without abort, and byte-identical saved-history inspection.

### Fixed

- Preserved final displayed output on observer detachment; reconciled finalized native entries after event dispatch, retired tool cards, and kept persisted results authoritative over transient events.
- Kept newly admitted team sessions discoverable in open choosers, isolated redraw/shutdown failures, and prevented aborted loads from exhausting viewer handles.
- Reserved display space for truncation notices so bounded tail content and full session identity remain visible; transient tool clipping is explicitly marked.

## [1.1.9] - 2026-10-02

### Added

- Native Pi session references mapping exact parent/member runs and agent definitions to Pi-assigned session IDs and file locators, including leaders, workers, and concurrent runs of the same definition. Existing structured `runs.list` / `runs.show` expose isolated typed references; slash run summaries remain bounded.
- Immutable, versioned provenance entries and names in native Pi histories before extension binding or prompting, without adding identity metadata to model context or duplicating transcripts. Allocated file locators do not imply that Pi has written a transcript.
- Localhost-only Pi SDK and state regressions for native identity, context exclusion, lazy persistence, concurrent/team mapping, startup and cleanup failures, cancellation, snapshot isolation, and restart with no automatic prompts or transcript-file mutation.

### Changed

- Opt-in Zerg snapshot recovery detaches all restored attached references, including terminal parent runs, without claiming reconnection or confirmed disposal. Session runtimes still dispose after tasks; history viewing, long-lived conversations, workspace messaging, and resume controls remain future work.

### Fixed

- Ensured SDK cleanup still runs after native registration, subscription, provenance publication, or extension-binding failures. References report confirmed disposal only when SDK cleanup returns; throwing cleanup leaves an unavailable reference rather than a false live attachment.

## [1.1.8] - 2026-10-02

### Fixed

- Native execution now rejects unsupported fork requests, configured `maxTurns`, and nonempty `fallbackModels` instead of silently ignoring them. Preflight checks the resolved run and selected leader/member definitions before SDK session startup or coordination-directory creation, including workers queued behind the concurrency limit.
- Reports a bounded, actionable unsupported-option error while preserving cancellation precedence and truthful foreground control/tool errors and eventual background run/task failures.
- Preserves fresh native defaults and capability forwarding to external adapters or acknowledged slash bridges. This patch does not implement native turn budgets, model failover, or inherited parent context.

### Added

- Localhost-only Pi SDK regression coverage for inherited capability settings, zero extension/session/provider startup on rejection, whole-team validation, cancellation, default success, and control/tool/slash/native-fallback behavior.

## [1.1.7] - 2026-10-02

### Added

- Configurable per-run native team worker concurrency through `/zerg run --concurrency <n>` (or `--concurrency=<n>`) and structured `zerg_control` run `concurrency`, accepting positive safe integers and defaulting to 8.
- FIFO worker admission covering asynchronous session setup and execution, with the resolved limit recorded in run metadata; this is not a global, provider-wide, or external-adapter limit.
- Localhost-only Pi SDK regression coverage for default/custom limits, startup bounds, failure drainage, queued cancellation, disposal, foreground abort, shutdown, and native bridge fallback.

### Changed

- Workers release their slots on failure or setup rejection so remaining queued workers continue; the leader runs after worker settlement, preserving required-worker failure aggregation and handoffs.
- Cancellation prevents queued workers and the leader from starting; skipped workers receive cancelled progress without misleading start timestamps. Admitted workers remain marked as starting through extension startup.

## [1.1.6] - 2026-10-02

### Fixed

- Failed native team runs and tasks when a required worker fails or is independently cancelled, rather than allowing a successful leader to mask the outcome; preserved overall cancellation precedence.
- Propagated aggregate failures through foreground control/tool errors and eventual background run status, including bridge-native execution.
- Preserved leader and successful-worker handoffs, complete leader error details, and structured member failure diagnostics; terminalized worker progress after setup rejection without overwriting existing completion timestamps.

### Added

- Expanded localhost-only Pi SDK regression coverage for mixed worker outcomes, setup and leader failures, task status, cancellation after worker failure, and preserved handoffs.

## [1.1.5] - 2026-10-02

### Fixed

- Isolated throwing state subscribers so later subscribers still receive independent snapshots and committed updates return successfully, with bounded diagnostics that cannot interrupt publication.
- Rejected cyclic, excessively deep, or excessive-work extension metadata with clear errors before state updates commit, including sparse arrays and repeatedly shared object graphs.
- Preserved independent cloning of valid shared metadata, safe own `__proto__` properties, and existing cycle-safe log-data pruning.

### Added

- Regression coverage for subscriber failure isolation, failing diagnostic sinks, metadata traversal bounds, and atomic rejection of invalid state updates.

## [1.1.4] - 2026-10-02

### Fixed

- Classified native completion from the final assistant outcome: errors and incomplete responses fail, aborted responses cancel, and handoffs contain assistant text rather than reasoning or tool metadata.
- Propagated foreground failures and cancellation through structured control results and tool error status.
- Cancelled pending native fallback launches on interrupt, disposal, and session shutdown; aborted active sessions and prevented late bridge events or repeated interrupts from reviving terminal runs.
- Propagated foreground abort signals and kept member progress terminal when cancellation occurs during session startup.
- Preserved explicit empty tool lists and enforced alias-aware deny precedence, including restrictions on the generic Larra gateway.
- Preserved the selected team's identity and member plan, rejected missing members before launch, and stopped implicitly choosing a team when its leader is launched directly.
- Routed native operator messages to the requested live run/member, rejected ambiguous routes, and reported Pi's queued/handled acknowledgement instead of claiming delivery.
- Removed the obsolete Arria identity from native leader prompts.

### Changed

- Native launches explicitly reject unsupported manual/assisted permission modes rather than silently ignoring them; tool selection is not an operating-system sandbox.
- Structured messages accept an explicit `steer` or `followUp` mode, defaulting to `steer`.

### Added

- Permanent offline Pi SDK regression coverage using isolated settings, dummy credentials, and a localhost model fixture for outcomes, policy, teams, messaging, and cancellation lifecycle behavior.

## [1.1.3] - 2026-10-01

### Fixed

- Updated native sessions for Pi 1.0.0's asynchronous `ModelRuntime` model and credential APIs, replacing the removed `AuthStorage` integration.
- Respected configured default models and explicit per-run model overrides in native execution.
- Bound native extension lifecycle handlers before prompting and prevented recursive swarm loading in child sessions.
- Kept RPC, JSON, and print-mode management commands on their text fallback instead of opening terminal overlays; awaited overlay setup so asynchronous failures reach the fallback.

### Changed

- Validated against Pi SDK and TUI 1.0.0, with host-provided peer dependencies instead of duplicate bundled runtime copies.
- Declared the current Pi requirement of Node.js 22.19.0 or newer and updated the development dependency lockfile.

## [1.1.2] - 2026-05-25

### Fixed

- Captured final assistant text from native Pi sessions so single-agent zerg runs return usable handoffs instead of generic completion placeholders.
- Propagated captured native run summaries into run metadata and logs for direct `runs.show` inspection.

## [1.1.1] - 2026-05-25

### Fixed

- Exposed Larra MCP tools to native zerg agents when `mcp` or `larra` tools are requested.
- Removed contradictory native prompt text that discouraged Larra when tasks explicitly require it.
- Preserved Pi resource discovery in native runs by using the default resource loader when available.

## [1.1.0] - 2026-05-25

### Added

- Added restart-durable run/log snapshot persistence and recovery helpers for native zerg sessions.
- Added additive structured operator-message transport hooks to direct control and adapters, with honest delivered/unavailable/failure states.

### Changed

- Bumped package/runtime metadata to `1.1.0` and included `persistence.ts` in the public package surface.
- Updated copyright and package author metadata for Marc Mironescu / `crustyhacker`.

### Fixed

- Recovered non-terminal pre-restart runs are now surfaced as `needs-attention` with recovery metadata instead of disappearing from run inspection.

## [1.0.6] - 2026-05-16

### Fixed

- Preserve original task text in terminal native run snapshots and allow direct control runs by configured team id.
- Persist fallback native team handoff files when the Pi session does not write the advertised coordination file.
- Keep native team leader prompts scope-safe so audit/read-only tasks are not upgraded into source-editing fix work.

### Changed

- Clarified stable-package wording and post-stable version-policy guidance.

## [1.0.5] - 2026-05-16

### Changed

- Simplified the `/zerg config` overlay into a KISS three-step flow: select a target, adjust settings/permissions, then send an operator message.
- Aligned the config overlay with Pi theme colors and clearer footer key hints, including `Ctrl+X` for clearing chat drafts.

### Fixed

- Preserved existing selected targets when opening `/zerg config` without locking tree navigation back to the first/default target.
- Made the overlay header report the real Zerg control controller instead of the permission-mode controller.

## [1.0.4] - 2026-05-15

### Added

- Added exported structured direct control via `createZergControl(...)` plus `ZergControlAction`/`ZergControlResult` contracts for automation without terminal or slash-command parsing.
- Added Pi custom tool registration for `zerg_control` when the installed Pi API exposes `registerTool(...)`; tool execution calls the same structured control core.
- Added process-lifetime native background run tracking, `awaitRun` support for foreground direct/native callers, enhanced run snapshots with final/error summaries, completion timestamps, and member progress.
- Added native team coordination directory creation and visible concurrent member progress before leader integration.

### Fixed

- Fixed stale terminal run rendering by making terminal state such as `done/completed`, `failed/failed`, or `cancelled/cancelled` win over older adapter `starting` snapshots.
- Wired native interrupt handling to active Pi `AgentSession.abort()` handles when available; cancellation is reported as `cancelling` until native execution actually reaches a terminal cancelled/failed state.

### Changed

- Bumped package manifest versions from `1.0.3` to `1.0.4` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-release, direct API/tool, async durability, and validation wording for `v1.0.4`.

### Known Limitations

- Background run durability is process/session lifetime only; restart-durable persistence is not implemented.
- Native model fallback and max-turn settings are preserved in request/run metadata, but exact enforcement depends on installed Pi SDK model/session support.

## [1.0.3] - 2026-05-15

### Added

- Added native Pi SDK-backed `/zerg run` execution so `pi-zerg-swarm` can launch configured agents without the `pi-subagents` extension.
- Added native team execution fallback for leader runs: configured team members run first with shared coordination files, then the leader integrates and reports.

### Fixed

- Removed the hard runtime dependency on the `pi-subagents` slash bridge; missing bridge now starts the native runner instead of failing with “Ensure pi-subagents is loaded.”

### Changed

- Bumped package manifest versions from `1.0.2` to `1.0.3` in `package.json` and `package-lock.json` (top-level + root package).
- Added `@earendil-works/pi-coding-agent` as a runtime dependency for native Pi SDK execution.
- Updated README current-release and check-version wording from `v1.0.2` to `v1.0.3`.

## [1.0.2] - 2026-05-15

### Fixed

- Aligned runtime status/help/internal-patch messages with package release version `v1.0.2` instead of retaining stale `v1.0.0` command-surface strings.
- Centralized the command-surface version string for runtime rendering and registration messages to avoid future package/runtime drift.
- Made successful adapter launch output robust when an adapter returns `ok: true` without an optional message.
- Fixed custom run/task ID normalization so unprefixed ID factory values produce `zerg-*`/`task-*` IDs without doubled hyphens.

### Changed

- Bumped package manifest versions from `1.0.1` to `1.0.2` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-release and check-version wording from `v1.0.1` to `v1.0.2`.

## [1.0.1] - 2026-05-15

### Added

- Added Claude Code-style runtime agent configuration: `/zerg agents create|update|delete` can set prompts, tools, permission mode, model, fallback models, and max turns.
- Added `/zerg run --model/--fallback-models/--max-turns` routing and bridge metadata propagation, plus `/zerg agent` and `/zerg team` flags for leaders, members, teams, and model metadata.

### Changed

- Bumped package manifest versions from `1.0.0` to `1.0.1` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-release and check-version wording from `v1.0.0` to `v1.0.1`.

## [1.0.0] - 2026-05-15

### Changed

- Finalized the stable `v1.0.0` release after the M9 interactive management TUI implementation.
- Aligned `/zerg config` with the working Pi overlay pattern from `pi-jarvis`: the overlay launch is awaited, rendering uses the real single-argument component contract, key handling uses Pi TUI key helpers, and chat composition uses the Pi TUI `Input` component with focus/cursor support.
- Bumped package manifest versions from `1.0.0-rc.11` to `1.0.0` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-release wording, runtime/help strings, and matching tests from `v1.0.0-rc.11` to `v1.0.0`.

### Known Limitations

- Delivered chat/process transport remains future scope; operator messages are recorded as local/unavailable or intervention-recorded only.
- External network/subprocess transport was not added for the stable release.

## [1.0.0-rc.11] - 2026-05-14

### Added

- Added the M9 componentized Pi-native interactive management TUI for `/zerg config`, split across `ui/management-overlay.ts`, tree, detail, chat, settings, footer, component, and local UI-state modules.
- Added live tree browsing for agents, teams, and tasks with expand/collapse, clamped navigation, confirmed selection, and detail drill-down.
- Added detail, settings/action, chat/operator-message, and footer panes with focus routing, live state refresh, bounded rendering, and exact-once teardown.
- Added honest operator message handling: team messages resolve to leaders when present, unavailable transport is explicit, and intervention records are never labeled as delivered chat.
- Added focused UI tests for overlay lifecycle/dispose, tree navigation, settings/actions, chat delivery semantics, and package/test coverage for the new UI modules.

### Changed

- Changed `/zerg config` to launch the M9 interactive TUI through `ctx.ui.custom()` while preserving the M8 text management overlay fallback and the simple `/zerg monitor` path.
- Reused existing audited command/state paths for read-only, automation mode, controller, permission approve/deny, interrupt, target selection, and intervention recording.
- Bumped package manifest versions from `1.0.0-rc.10` to `1.0.0-rc.11` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, package inclusion, and matching tests from `v1.0.0-rc.10` to `v1.0.0-rc.11`.

### Known Limitations

- Manual Pi host smoke for `/zerg config` was not run in this environment, so this candidate is locally validated but not release-complete until interactive host verification passes.
- Delivered chat/process transport remains unavailable; UI messages are recorded as local/unavailable or intervention-recorded only.
- The interactive TUI uses structural component composition and line rendering; it does not add new external network/subprocess transport.

## [1.0.0-rc.10] - 2026-05-14

### Added

- Added the full `/zerg config` management overlay with monitor, control, targets, permissions, lifecycle, logs, intervene, and config tabs.
- Added overlay-local selection, scroll, detail, confirmation, status-message, and exact-once close/dispose handling for the Pi custom overlay path.
- Added keyboard support for tab cycling, left/right tab navigation, clamped up/down row movement, enter detail toggle and explicit selection, permission approve/deny confirmation, interrupt requests, and deterministic deferred filter messaging.
- Added regression coverage for overlay contract/dispose semantics, tab/navigation/scroll behavior, refresh/unsubscribe handling, no-writable-container mutation blocking, permission confirmation, and render immutability.

### Changed

- Kept `/zerg monitor` read-only while expanding `/zerg config` into the full management surface.
- Reused existing audited command/state paths for read-only, automation mode, permission resolution, interrupt, and intervention mutations instead of adding overlay-only direct state writes.
- Bumped package manifest versions from `1.0.0-rc.9` to `1.0.0-rc.10` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.9` to `v1.0.0-rc.10`.

### Known Limitations

- Manual Pi smoke for the management overlay was not run in this environment, so live host-behavior verification remains outstanding.
- Text filter entry (`/` or `f`) is deferred to a deterministic status message; freeform in-overlay filtering is not yet implemented.
- Live overlay chat/process transport and external transport wiring remain future scope.

## [1.0.0-rc.9] - 2026-05-11

### Added

- Added typed structured log contracts for `ZergLogLevel`, `ZergLogSource`, `ZergOutputKind`, `ZergLogRecord`, and `ZergLogState`.
- Added bounded structured log state under `state.extensions.zergLogs` with clone-safe helpers for appending records, appending batches, reading filtered records, max-record trimming, and JSON-safe structured data sanitization.
- Added `/zerg logs status|list|show|json` command surfaces with `--run`, `--level`, `--limit`, and `--json` support for stable text and parseable JSON inspection.
- Added command, lifecycle, permission, adapter, Pi slash-bridge, run, and interrupt log integration using verified fields only.
- Added monitor, control, config, and help rendering for structured log counts and latest warning/error summaries.
- Added regression coverage for log helper cloning/trimming/sanitization, cyclic and unsupported data handling, BigInt JSON safety, log command filters, JSON parsing, bridge tool/text/error/result update logs, and render immutability.

### Changed

- Kept logs in bounded in-memory extension state; no persistent filesystem logs, telemetry, or unbounded raw output storage were added.
- Bumped package manifest versions from `1.0.0-rc.8` to `1.0.0-rc.9` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.8` to `v1.0.0-rc.9`.

### Known Limitations

- External Pi log/output event integration remains limited to verified slash-bridge event fields; private Pi event payloads are not guessed.
- `/zerg logs clear` is not implemented; log deletion/retention policy beyond bounded in-memory trimming remains future scope.
- Structured logs are in-memory extension state and are not durable across process restarts.

## [1.0.0-rc.8] - 2026-05-09

### Added

- Added `ZergLifecycleSubstate` with fine-grained queued, spawning, starting, waiting, executing, tool-running, compacting, cancelling, completed, failed, and reset lifecycle values while preserving coarse `AgentStatus` and `TaskStatus` compatibility.
- Added optional lifecycle substate, reason, and update timestamp fields to runtime state, task records, lifecycle events, and subagent run snapshots.
- Added deterministic runtime transition substate mapping, sanitized bounded substate reasons, and clone-safe snapshot handling.
- Added lifecycle command `--substate`, `--substate=<value>`, and `substate=<value>` parsing with invalid-substate no-mutation rejection.
- Added run, Pi slash-bridge, interrupt, and permission-wait lifecycle substate integration, including bridge task completion/failure state updates.
- Added compact substate hints to status, tree, monitor, control, config, and run list/show rendering.
- Added regression coverage for substate mapping, sanitization, clone isolation, command parsing, bridge run/task flow, interrupt cancellation, permission waits, rendering, and coarse status compatibility.

### Changed

- Kept public coarse lifecycle status unions unchanged while layering detailed substates onto runtime/task metadata.
- Bumped package manifest versions from `1.0.0-rc.7` to `1.0.0-rc.8` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.7` to `v1.0.0-rc.8`.

### Known Limitations

- External Pi lifecycle payload semantics remain limited to verified slash-bridge events; private Pi lifecycle event integration is deferred.
- Lifecycle substates are in-memory command/runtime metadata and do not add process supervision or durable run logs.

## [1.0.0-rc.7] - 2026-05-08

### Added

- Added typed command-host permission queue contracts for `ZergPermissionRequest`, request status/decision/kind values, and queue snapshots under `state.extensions.zergPermissions`.
- Added immutable permission queue helpers for enqueueing, resolving, expiring, listing pending requests, bounded trimming, sanitization, and clone-safe snapshots.
- Added `/zerg permission status|list|request|approve|deny|cancel` commands for local operator-visible approval audit flow.
- Added read-only `/zerg run` and `/zerg interrupt` gating that records permission requests or blocks adapter side effects instead of launching/cancelling.
- Added permission queue indicators to status, control, monitor, config, help, and list rendering.
- Added regression coverage for queue helpers, command behavior, read-only adapter gating, sanitization, clone isolation, and rendering surfaces.

### Changed

- Kept approval/denial/cancel decisions as audit-only state transitions; approved queued requests do not auto-execute adapter actions in this milestone.
- Bumped package manifest versions from `1.0.0-rc.6` to `1.0.0-rc.7` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.6` to `v1.0.0-rc.7`.

### Known Limitations

- External Pi permission event integration is deferred because exact event names and payloads were not verified; M5 is command-host/local queue only.
- Approved queued requests are not automatically executed; operator execution remains a future milestone.
- Permission queues are in-memory state extension data and are not persisted to disk.

## [1.0.0-rc.6] - 2026-05-08

### Added

- Added explicit `ZergSubagentLaunchMode` values for `fresh` and `fork` subagent launch requests.
- Added `--fresh` and `--fork` launch-mode parsing for `/zerg run`, with fresh as the default isolated launch mode.
- Added launch-mode metadata to task-first task/agent records, adapter run snapshots, and `/zerg runs` list/show rendering.
- Added regression coverage for default fresh, explicit fresh, fork bridge payloads, fresh no-context payloads, conflicting mode flags, legacy `fork: true` compatibility, launch failure audit metadata, and help text.

### Changed

- Updated Pi slash bridge launch handling so fork emits `context: 'fork'` and fresh omits inherited-context bridge payloads.
- Preserved deprecated `fork?: boolean` launch-request compatibility while normalizing internal behavior to `launchMode`.
- Bumped package manifest versions from `1.0.0-rc.5` to `1.0.0-rc.6` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.5` to `v1.0.0-rc.6`.

### Known Limitations

- Fresh/fork behavior records and transmits launch-mode intent only; transcript copying or stripping remains outside this milestone.
- Permission queues, mailbox messaging, background output retrieval, cancellation details, and live UI management remain future milestones.

## [1.0.0-rc.5] - 2026-05-08

### Added

- Added task-first `/zerg run` spawn state that allocates run and task identities before adapter launch.
- Added launch request/result identity fields for `runId`, `taskId`, agent-definition linkage, and task descriptions.
- Added regression coverage for deterministic task-first IDs, definition resolution, read-only no-mutation behavior, sync launch failure visibility, Pi slash bridge request ID reuse, and divergent legacy adapter IDs.

### Changed

- Updated Pi slash bridge launch handling to respect provided run IDs and carry task IDs through run snapshots and metadata.
- Updated `/zerg runs` rendering to show task/run linkage.
- Bumped package manifest versions from `1.0.0-rc.4` to `1.0.0-rc.5` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.4` to `v1.0.0-rc.5`.

### Known Limitations

- Fresh/fork launch-mode semantics, background task output storage, mailbox messaging, and filesystem-defined agents remain future milestones.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [1.0.0-rc.4] - 2026-05-07

### Added

- Added optional adapter read APIs for agent definitions and subagent run snapshots: `listAgentDefinitions`, `getAgentDefinition`, `listRuns`, and `getRun`.
- Added clone-safe `ZergSubagentRunSnapshot` contracts and state helpers for run snapshot retrieval.
- Added read-only `/zerg runs` and `/zerg runs show <run-id>` command output with bounded render helpers and regression coverage.

### Changed

- Bumped package manifest versions from `1.0.0-rc.3` to `1.0.0-rc.4` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.3` to `v1.0.0-rc.4`.

### Known Limitations

- Task-first spawn semantics, filesystem-backed agent loading, and hard `/zerg run` definition enforcement remain future milestones.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [1.0.0-rc.3] - 2026-05-06

### Added

- Added a typed in-memory agent-definition registry with deterministic builtin `generalist`, `planner`, and `reviewer` definitions.
- Added read-only `/zerg agents list` and `/zerg agents show <id>` command support for inspecting registered agent policies.
- Added registry helper APIs, clone-safe state storage, rendering support, and regression coverage for definition normalization, cloning, sorting, and command output.

### Changed

- Bumped package manifest versions from `1.0.0-rc.2` to `1.0.0-rc.3` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v1.0.0-rc.2` to `v1.0.0-rc.3`.

### Known Limitations

- Filesystem-backed agent loading, markdown frontmatter parsing, and hard `/zerg run` definition enforcement remain future milestones.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [1.0.0-rc.2] - 2026-05-05

### Added

- Added release-candidate notes for the single `v1.0.0-rc.2` gate and the mandatory RC audit set.

### Changed

- Bumped package manifest versions from `0.9.1` to `1.0.0-rc.2` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v0.9.1` to `v1.0.0-rc.2`.
- Finalized candidate metadata without introducing new feature scope.

### Known Limitations

- `npm run check:version` is a post-tag confirmation; skip it during pre-tag RC prep until `v1.0.0-rc.2` exists at `HEAD`.
- Manual end-to-end smoke for TUI, lifecycle, intervention, and mode switching remains required before tagging.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.9.1] - 2026-05-05

### Added

- Added canonical repository metadata for the public GitHub repository in `package.json` so npm/`pi` consumers can discover and verify project origin: `git+https://github.com/fluxgear/pi-zerg-swarm.git`.
- Documented publication/readiness status updates for README/CHANGELOG and check:version guidance in public docs.

### Changed

- Bumped package manifest versions from `0.9.0` to `0.9.1` in `package.json` and `package-lock.json` (top-level + root package).
- Updated current-release wording from v0.9.0 to v0.9.1 in public release notes.

### Fixed

- Polished README and changelog `check:version` guidance to reflect state-aware, post-tag behavior.
- Removed stale statements claiming canonical repository metadata was still unavailable.
- Updated publication-readiness wording so repository metadata and release checks are documented as resolved for v0.9.1.

### Known Limitations

- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.9.0] - 2026-05-04

### Added

- Added v0.9.0 release-prep documentation polish for README hierarchy, Mermaid visuals, and truthful current-release status.
- Added release/package-readiness context for package-check behavior and post-tag `check:version` expectations.

### Changed

- Updated release messaging in public docs and version references from v0.8.1 to v0.9.0 while preserving completed milestone history.
- Bumped package metadata versions from `0.8.1` to `0.9.0` in package manifest files.
- Reserved the follow-up themed cleanup and generalized deep-audit backlog for v0.9.1.

### Known Limitations

- `npm run check:version` is a post-tag check; pre-tag release-prep failures were expected while `v0.9.0` was not yet tagged.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.8.1] - 2026-05-04

### Fixed

- Split the v0.8.0 audit follow-ups into an audit bugfix patch release.
- Added direct `renderHelp` header regression coverage and renamed stale v0.7-labeled intervention/render test titles to version-neutral wording.

### Changed

- Bumped package/package-lock top-level versions to `0.8.1`.
- Updated README and changelog release references plus command/status/help/runtime version strings and matching tests to v0.8.1 while preserving v0.8.0 as the completed package-readiness/config-hardening implementation milestone.

## [0.8.0] - 2026-05-03

### Added

- Added package-readiness/config-hardening release checks (`check:package`, `check:version`) and private-path build/package guards for `prompts`, `planning`, `.pi`, `.claude`, `.codex`, and `.agents` to prevent release/compile leakage.
- Added package metadata validation for MIT license consistency and package-lock sync checks, with repository metadata warning until canonical URL is configured.

### Changed

- Bumped package/package-lock top-level versions to `0.8.0` and aligned command/status/render/help surfaces and tests to the same release surface.
- Updated README roadmap, development script guidance, and changelog scope statements for v0.8.0 package/readiness hardening.

### Known Limitations

- Canonical repository URL is still unavailable in this environment; `check:package` warns about missing repository metadata until configured.

## [0.7.1] - 2026-05-03

### Fixed

- Fixed read-only `/zerg mode status` handling so status is available without writable-state permission.
- Fixed `/zerg mode revert` to clear `contextId` when reverting to the prior mode snapshot.
- Added regression coverage for invalid mode actions and invalid mode reasons (control-only and overlong), asserting rejection without state mutation.

## [0.7.0] - 2026-05-03

### Added

- Added command-host control grammar for `/zerg mode status|manual|assisted|automatic|revert [reason]` and `/zerg intervene agent|subagent|leader ...` without enabling live external transport.
- Added fake-Pi/shared-state regression coverage for registered command-host mode transitions and intervention recording paths.

### Changed

- Promoted package metadata and public version/help/status surfaces to v0.7.0.
- Mode control now records auditable and reversible global `state.mode` transitions including controller and prior-mode snapshots.
- Intervention records are sanitized and bounded before persistence, and rendered across status/help/tree surfaces with active target markers and previews.

### Known Limitations

- Live TUI overlays and chat/external process/network transport remain planned and unvalidated for this release.

## [0.6.1] - 2026-05-02

### Fixed

- Fixed v0.6.1 audit regressions in runtime monitoring: same-timestamp lifecycle activity ordering, explicit-tree runtime hints, sanitized runtime activity output, and fallback to the newest displayable activity.

## [0.6.0] - 2026-05-02

### Added

- Added subagent runtime and monitoring state for agent/team lifecycle transitions, runtime health, task/activity snapshots, and shared Pi command/event-bus reporting.
- Added fake-Pi lifecycle and monitoring regression coverage for `/zerg` agent/team create/progress/stop flows, latest activity, and tree runtime hints.

### Changed

- Promoted package metadata and command/status/help/test version surfaces to v0.6.0 for the subagent runtime and monitoring milestone.

### Known Limitations

- Manual Pi host command/runtime validation has been performed for /zerg help/status/tree and agent/team lifecycle commands in a tmux pseudo-TTY; live TUI overlay/intervention validation has not been performed, so avoid claiming live overlay validation has passed.

## [0.5.1] - 2026-05-02

### Fixed

- Fixed fallback tree rendering to honor `AgentIdentity.childIds`-only hierarchy without duplicate roots while preserving cycle and truncation guards.
- Added bounded explicit-tree missing-child markers and durable render regression coverage for fallback childIds, explicit missing/orphan/duplicate/selected/cycle paths, team fallback, truncation, and non-mutation.

### Changed

- Promoted package metadata and public command/status/help/docs/test version surfaces to v0.5.1 for the audit bugfix patch.

## [0.5.0] - 2026-05-02

### Added

- Added expanded render/tree visibility for explicit `state.tree` nodes, team/agent fallback hierarchies, selected/status markers, orphan/missing-child/cycle safety, duplicate suppression, and bounded output with truncation.

### Changed

- Promoted package metadata and public command/status/help/docs/test version surfaces to v0.5.0 for the render/tree milestone.

### Known Limitations

- Manual Pi overlay verification has not been performed; live TUI overlays, subagent runtime loops, task queues, and intervention controls remain planned.

## [0.4.1] - 2026-05-02

### Fixed

- Fixed audit release-hygiene drift by aligning package metadata, command/status/help output, README current-release wording, tests, and the top changelog section on v0.4.1.
- Clarified this patch as a consistency-only audit bugfix while preserving v0.4.0 as the historical internal-patch milestone.

## [0.4.0] - 2026-05-01

### Added

- Added safe Pi event-bus internal bridge validation for emit and subscription observation, including focused regression coverage for forwarding `eventBus.on(...)` subscriptions and preserving original disposable return values.
- Added regression coverage for duplicate controllers sharing one Pi event bus so duplicate installation does not double-observe subscriptions or restore the active wrapper.

### Changed

- Promoted command/status/help/docs public version surfaces to v0.4.0 for the internal patch milestone.

### Fixed

- Preserved event-bus wrapper behavior after duplicate-controller disposal and verified no subscription telemetry is recorded after the active patch is disposed.

## [0.3.0] - 2026-05-01

### Added

- Added deterministic thinking-step derivation with source-line IDs, LF/CRLF parity, explicit status aliases, checkbox precedence, malformed-input skipping, and `/zerg steps` integration coverage.
- Expanded regression coverage for ordinary hyphenated bullet, numbered, star, and checkbox titles.

### Changed

- Promoted user-facing command/status/help version strings to v0.3.0 for the parse/thinking-step milestone.

### Fixed

- Required known status prefixes to use `:`/`：` or a whitespace-delimited hyphen separator, preserving titles such as `done-task`, `failed-first`, `todo-list`, and `needs-attention-task` instead of truncating them.

## [0.2.0] - 2026-05-01

### Added

- Added v0.2.0 state schema metadata, lifecycle/revision guard fields, team/tree/context/thinking contracts, and deterministic state container APIs.
- Added focused regression coverage for shared state snapshots, container read/update/replace flows, team/tree helpers, registration state snapshots, and type fixture surfaces.

### Changed

- Promoted package metadata and public command/status/help version strings to v0.2.0 for the completed types/state milestone.
- Routed extension registration and internal patch event writes through snapshot-safe state container helpers.

## [0.1.1] - 2026-05-01

### Fixed

- Corrected README validation-scope wording so `npm test` is documented as covering parser, command-surface, and render behavior.
- Added command-registration disposal cleanup for disposable Pi command hosts, including idempotent dispose behavior and clean re-registration after dispose.
- Released owned internal patch context state during extension disposal to keep repeated registration lifecycles isolated.

### Changed

- Expanded tests for duplicate-registration disposal lifecycle and nested tree rendering; current validation covers 12 Node tests.
- Updated package and user-facing status/help version strings for the v0.1.1 Session B audit bugfix patch.

## [0.1.0] - 2026-04-30

### Added

- Hardened slash-free Pi command registration for `/zerg`, `/zerg-swarm`, and `/swarm` command aliases.
- Added Pi-shaped command handler notifications for help, status, tree, and thinking-step parser output.
- Added command-surface tests for aliases, normalization, unknown usage, multiline steps, and duplicate registration.

### Changed

- Updated package metadata and user-facing scaffold status/help text for the v0.1.0 command-surface milestone.

### Not Yet Implemented

- Real subagent spawning, team runtime/loops, task queues, live Pi TUI overlays, and manual/automation intervention controls remain planned.

## [0.0.0] - 2026-04-30

### Added

- Initial Pi extension package scaffold with `pi.extensions` pointing to `./index.ts`.
- Strict TypeScript no-emit configuration and Node test script.
- Structural contracts for commands, agents, tasks, hook events, state, and minimal Pi context support.
- Pure thinking-step parser, state helpers, text renderers, and no-op-safe internal patch bridge.
- Public README, MIT license, and parser tests for the bootstrap surface.

### Not Yet Implemented

- Real subagent spawning, team loops, task queues, live Pi TUI overlays, and manual/automation intervention controls.
