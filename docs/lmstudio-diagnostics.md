# Native LM Studio diagnostics

Harbor's LM Studio runner evaluates Harbor tool use through LM Studio's native `/api/v1/chat` tool-execution loop. It is a separate harness selection from Hermes or OpenClaw using LM Studio as their model provider. All selections reuse Harbor's conformance tasks, representative workloads, delivery variants and independent artifact graders. Results describe the tested setup, not general model intelligence.

## Setup

1. Run LM Studio and start its local server at `http://127.0.0.1:1234`. Native chat requires 0.4.0 or newer; this integration is verified against 0.4.21+2. Other versions must also support the configuration synchronization receipt described below.
2. Load exactly one language model. Set at least 4,000 context tokens and one concurrent prediction. Harbor inspects the existing instance and does not issue model load, unload or context-setting requests. Do not change models during a campaign.
3. In LM Studio Server Settings, enable **Require Authentication**, then **Allow calling servers from mcp.json**. On the tested LM Studio 0.4.21+2, the configured-server switch is disabled until authentication is enabled. Create an API token with **Allow calling servers from mcp.json** permission. The separate per-request MCP switch does not solve local connectivity: this version rejects localhost addresses for ephemeral MCP connections.
4. Launch Harbor with that token in the `LM_STUDIO_API_TOKEN` environment variable. The token is used for local API requests and is not included in diagnostic exports. Enabling server authentication also affects other clients using this LM Studio server; arrange their authentication before resuming them. Do not paste tokens into diagnostic notes or exported connection instructions.
5. In Harbor, open **Diagnostics > 1. Connection**, choose **LM Studio**, and select **Check LM Studio**. This checks inventory; the native MCP connection is exercised when a trial starts. Continue through tasks, delivery, limits and review before starting.

Each trial adds a uniquely named `harbor-diagnostic-<id>` server to `%USERPROFILE%\.lmstudio\mcp.json`, using Harbor's standalone stdio bridge and the trial's private gateway. It removes that exact entry afterward. Other entries and unrelated settings are preserved. A malformed configuration fails without replacement. If another program edits the owned entry, cleanup preserves the edit and reports the problem. A hard process or computer crash can leave an inactive diagnostic entry; remove only the matching `harbor-diagnostic-<id>` entry after confirming the campaign is no longer running. Do not remove ordinary Harbor connections.

Trials use fresh, unsaved native chats (`store=false`) and explicitly select only their own configured MCP. Existing conversations, configured plugins and user prompts are not imported. This is process/application isolation, not an operating-system sandbox. LM Studio's own logging settings still apply.

Before submitting a chat, Harbor waits up to ten seconds for LM Studio's `.internal/last-synced-mcp-state.json` receipt to contain the exact temporary entry. This avoids racing LM Studio's configuration watcher. Missing receipt support, timeout or cancellation fails setup before inference; synchronization itself does not prove the plugin has successfully connected.

## Controls and observations

The native request sets temperature 0.2 and an output limit of 1,024 tokens. It does not request a different context or reasoning setting. The final JSON contract is the same task contract used by the other adapters. Independent graders verify actual tool effects and final answers, including recovery, abstention and false completion claims. Available host RAM/GPU samples include other applications.

Native events record tool names, argument-schema validity, invalid-call categories, observed prompt-processing starts and final responses. Hidden reasoning and raw tool arguments are not retained in adapter events. Harbor's own request traces and synthetic fixture evidence retain their existing documented scope.

Installed 0.4.21+2 can emit anonymous tool-start boundaries and interleave calls. Harbor attributes attempts from complete argument or failure events and matches successful results to pending calls by tool name. Arguments and successful results must identify the exact trial plugin; foreign providers and unfinished or inconsistent streams remain excluded.

The native API does not expose the exact internally serialized tool definitions or complete inference settings for every model turn. Those observations stay unknown; a preflight MCP catalog is not presented as proof of what the model received. Weight bytes, complete server defaults and endpoint ownership are also unattested on this path. Missing setup identity withholds measured configuration recommendations even when individual task grades are available.

Timeout, cancellation, stream errors, observation limits, model drift and malformed responses do not count as successful model work. The turn limit aborts on an observed prompt-processing start above the configured limit; it cannot prevent that extra turn from starting inside the separate LM Studio process. After an interrupted native stream, Harbor stops the campaign because remote generation cancellation is not confirmed. Verify LM Studio is idle before starting another campaign. Removing the temporary MCP connection stops access to the trial gateway but is not proof that inference ended.

## Acceptance status

The controlled native API protocol campaign passed 27/27 cases with 62 actual Harbor tool dispatches: 12 conformance/curated trials, 10 representative file/SQLite/headless-browser tasks and five local search-delivery modes. Export and archive checks passed; internal model presentation correctly remained unknown. Native adapter and registration-ownership tests additionally cover malformed streams, argument errors, cancellation and preservation of other server entries. These establish adapter behavior, not model quality.

Installed LM Studio 0.4.21+2 subsequently completed a native MCP trial with Qwen3 0.6B Q8_0, an 8,192-token context and one concurrent prediction. Harbor observed a real record read, detected the missing required write, and retained an incomplete task grade despite the model claiming completion. This verifies native execution and grading of the observed failure; it is not a passing model task or proof of the complete model identity needed for configuration recommendations. The final adapter checks passed 20/20 without skips. See the consolidated [Phase 2 acceptance status](PHASE2-STATUS.md).

Earlier live attempts encountered the documented public-address restriction for ephemeral MCPs and a 403 on configured MCP use before the server permission was enabled. Those attempts remain excluded infrastructure failures, not Qwen failures; the successful later connection does not rewrite their results. Independent clean-machine acceptance remains open.

Temporary tokens, registrations and server-setting changes were cleaned up after the installed trials. The final source fixes postdate Stage20/candidate12; the refreshed Stage21/candidate13 package subsequently passed its separate native functional checks. The installed live-model trial and packaged checks have distinct evidence and are not presented as a complete live-model workload campaign on Candidate13.

Official interfaces: [Native chat API](https://lmstudio.ai/docs/developer/rest/chat), [streaming events](https://lmstudio.ai/docs/developer/rest/streaming-events), [MCP through the API](https://lmstudio.ai/docs/developer/core/mcp).
