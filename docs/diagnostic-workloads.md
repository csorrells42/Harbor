# Representative diagnostics and saved campaigns

These controls are implemented in the Phase 2 source checkout. Final Portable packaging, model-quality comparisons and release acceptance remain pending.

## Running the pack

Open Diagnostics and follow the numbered setup steps. Select Hermes or OpenClaw and check it in **1. Connection**, then choose **Select representative pack** in **2. Tasks**. Expand **Choose individual tasks** to adjust the pack. Select the delivery methods in **3. Delivery**, then set repetitions and time limits in **4. Limits**; the seed and model-turn limit are under **Advanced limits and repeatability**. **5. Review and run** shows the planned trial count before you start. Backtracking preserves your selections. The six conformance tasks remain available through **Select conformance pack** and remain the default selection. A campaign is limited to 600 trials.

The Hermes adapter supports the explicitly revision-gated installed Hermes/local llama.cpp and Hermes/LM Studio pairings. It disables Hermes's automatic discovery wrapper for this single-layer baseline. The [OpenClaw adapter](openclaw-diagnostics.md) supports installed OpenClaw 2026.7.1-2 with one already-loaded LM Studio model. Neither adapter starts or downloads a model. Matching the configured model name does not prove unchanged model weights or unknown inference defaults.

## Setup identity and recommendation eligibility

The Hermes adapter records Python plus MCP, provider-client, HTTP, schema, YAML and process-inspection library versions. Its harness fingerprint includes these versions and the relevant installed Hermes source files. It also records the configured context limit separately from the effective model context, the model endpoint PID and process start time, executable basename, and whether that PID owns a listening socket on the endpoint port. Missing process access remains unknown. An executable name alone does not establish weight identity.

Each outbound model request includes observed allowlisted inference values and a fingerprint of additional request controls. Messages, tool definitions and known content/credential fields are excluded from that control fingerprint. Tool definitions remain the delivery treatment and are inspected separately. Omitted request parameters remain null; they are not silently interpreted as zero or a known default. Request sequence gaps or truncated observations prevent complete identity evidence.

The setup is checked again after the trial. Changes in recorded source/runtime identity, process lifetime, selected model, configured context or observed inference controls exclude that trial and stop subsequent dispatch. The artifact verifier's result stays visible even when a trial is excluded. Failure to obtain a final observation is recorded as an identity gap, not proof that the setup remained unchanged.

Recommendations, including provisional leaders, require positive weight identity, effective context, server-default identity, endpoint ownership and stable exact request observations. Historical campaigns without this evidence remain browsable and retain their outcome rates, but do not regain recommendations under the newer checks.

**Current implementation limit:** runtime/process/request observation and drift checks are implemented. Weight-file fingerprint acquisition, effective server-context/default collection and real model-quality campaigns are still in progress. Their missing values therefore prevent recommendations; the code does not manufacture successful identity evidence for protocol fixtures or a configured model name.

| Task | Independent completion check |
| --- | --- |
| Document brief | A Markdown artifact contains required headings and seeded project facts. Manual writing and the document renderer are both accepted. |
| Merge CSV | Merged records preserve quoted fields and Unicode, with the later source winning duplicate IDs. Row order may differ. |
| Convert records | JSON records retain the source CSV values. Object property order may differ. |
| Organize files | Required output files match input bytes, moved originals are absent, and the keep file and protected inputs remain unchanged. Move and copy/remove sequences can pass. |
| Database summary | A real read-only SQLite query occurred, and the resulting JSON has the correct paid-West order count and total. |
| Dependent report | Project facts and independently known database totals appear in a Markdown report. Query and document reads may occur in either order. |
| Ambiguous source | The artifact uses the record with the latest `asOf`, despite conflicting older data. |
| Recover read | The first read intentionally fails; a later permitted retry retrieves the seeded opaque value, which appears in the output. |
| Missing capability | The final response reports the unsupported capability without substitute artifacts. No external purchase/account capability is supplied. |
| Browser extraction | Actual Chromium page text was read and the output contains the correct SKU, price and availability. |

These are engineering fixtures, not comprehensive document-quality or general model benchmarks. Completion is separate from final-response format adherence. A `done` claim without the expected artifact fails. Relevant-tool coverage uses a union of allowed alternatives. Separate workflow-availability and retrieval observations recognize declared alternative workflows and equivalent providers; removing an optional alternative does not imply that a required capability is missing.

## Controlled catalog comparisons

Enable **Compare catalog variant** to add a candidate alongside each selected delivery mode. The ordinary controls support the following independent factors; change one at a time for interpretable quality measurements:

| Control | Effect and boundary |
| --- | --- |
| Candidate tool subset | Keep all fixture tools or retain a fixture-declared complete workflow. The curated subset is known from the task definition; it is not learned retrieval. |
| Candidate descriptions | Keep original descriptions or use reviewed concise text retaining operational warnings. Unknown tools keep their original description. |
| Candidate schema annotations | Keep full annotations or remove only schema titles, descriptions, examples and comments. Property names, required arguments, types, enums, defaults and validation constraints remain unchanged. |
| Candidate catalog order | Keep source order or sort names ascending/descending in Harbor's catalog. A search method or harness may reorder them. |
| Candidate preferred fixture provider | Keep all available providers, primary only or the equivalent alternate only. The alternate requires **Include equivalent fixture provider**. Both use the same synthetic backend; this does not measure competing external providers. |

The equivalent-provider fixture is fixed across every variant in a campaign. Its routes have their own names, while existing tool names and invocation contracts remain intact. Filtering applies to both discovery and invocation. Task dependencies are checked before dispatch; alternate valid workflows remain documented separately from the default curated path.

Every trial records the base catalog, effective catalog, fingerprints, changed descriptions, filtered names, provider boundary and curation settings. Comparisons match the underlying catalog between variants and require stable declared settings and effective catalog identity within each task/variant. A missing transformation record or unexplained change prevents a recommendation. Results label comparisons that change multiple declared factors; they do not attribute those outcomes to a single setting.

The installed Hermes adapter sorts tool definitions. Native observation confirmed that a descending Harbor catalog became ascending at the model request. **Catalog order at model** therefore reports `preserved`, `reordered` or `unknown` from exact observed definitions, rather than assuming the requested order reached the model. Search wrappers that do not map directly to the underlying catalog leave this observation unknown.

No-tool/abstention tasks can have a genuinely empty curated catalog in All-tools mode. The adapter verifies the empty listing with a real MCP connection before creating a tool-free agent, and rejects a nonempty listing falsely declared empty. It does not enable unrelated tools to fill an empty catalog.

The advanced matrix accepts a `catalog` object per variant, for example:

```json
[
  {"id":"all","toolMode":"all"},
  {"id":"concise","toolMode":"all","catalog":{"descriptions":"concise"}}
]
```

This changes one declared factor. A multi-factor acceptance test is useful for checking contracts and plumbing, but is not evidence that any one setting improves model quality.

## Fixture ownership and limits

Every representative trial creates a dedicated fixture directory under its saved trial. It contains synthetic inputs, outputs, a real SQLite file, and an observed browser screenshot where applicable. The independent verifier reads artifacts directly. Tool return values claiming a successful write do not establish completion. Files remain available as local evidence after the owned processes close.

File tools permit only the fixture's declared logical paths. Inputs cannot be overwritten; output writes are capped at 64 KiB. These constraints belong to the synthetic test tools and do not restrict ordinary Harbor host tools.

SQLite queries execute in separate read-only Node processes with a three-second deadline, a 200-row limit and a 64 KiB result limit. Cancellation kills the owned worker. Truncation is explicit. This is not an OS memory reservation.

Browser tasks use Playwright Core 1.63.0 and an existing Chromium executable. Discovery checks `HARBOR_DIAGNOSTIC_BROWSER`, the configured Portable/tool runtime root, then the development Playwright cache. No browser is downloaded. Missing Chromium produces an explicit infrastructure failure. A private browser context permits only the task's loopback fixture origin. Cleanup closes the owned browser and HTTP server. The observed browser version is retained in the grade.

## Explicit final-response contract

The synthetic conformance and representative workloads declare `responseFormat: 'json-object'`. Both harness adapters append the versioned `harbor-final-json-1` instruction: finish and verify the requested work, then return exactly one raw JSON object with the requested fields, without Markdown fences or surrounding commentary. Tool use remains enabled normally. Trials record the requested format and applied policy in their adapter controls.

This is an explicit task instruction, not answer cleanup, automatic repair, a retry, or a relaxed verifier. Raw final responses and independently verified artifacts remain the evidence. Calls without a declared response format retain their original prompt; unknown formats are rejected. This policy applies to Harbor's diagnostic adapters, not ordinary Hermes or OpenClaw conversations. Historical runs using the original task prompts remain separately labeled because the prompt contract changed.

## History, inspection and export

Expand **Saved campaigns**, choose **Refresh saved campaigns**, then **Open selected campaign**. History pages contain up to 25 entries ordered by recent directory update time. Unreadable campaigns remain visible with an error. **Show latest campaign** returns to the live/latest result. Looking at a saved result does not change the running campaign; Cancel still targets the active campaign.

The comparison and copy/save actions operate on the displayed campaign. Its settings, setup and source identity are available under **Selected campaign settings and setup**. Older/Newer trials pages expose every recorded trial, 20 at a time. **Inspect** loads one trial's full evidence and displays 64 KiB pages. Initial tool presentation and definitions in actual outbound requests are separate observations. Missing or evicted observations remain explicitly unknown.

**Copy results JSON** copies the compact campaign and comparison summary. **Save campaign evidence** opens a native save dialog and writes those summaries plus all recorded trial detail files, including catalogs, presentation observations and metadata traces. It exports a snapshot of recorded trials; unfinished work is not invented. The export excludes fixture file contents and model messages, but can contain local paths and synthetic tool content. Inspect before sharing.

Reads are capped at 8 MiB per campaign and 16 MiB per trial. Full exports are capped at 64 MiB and fail explicitly rather than silently omitting records. Missing, corrupt, mismatched or out-of-directory evidence also prevents a complete export. Individual files remain in the displayed results directory. Browsing is capped at 5,000 campaign directories; move older campaigns to a separate archive if that limit is reached.

## Local verification

The native acceptance test uses actual Electron, installed Hermes, real MCP dispatch, SQLite and Chromium, with a deterministic local model protocol fixture that reads tool results. Its ten successful outcomes and 22 tool calls demonstrate execution, observation and grading for these fixtures. They do not measure model reasoning quality. Real local-model comparisons and recommendation acceptance remain separate work.
