# OpenClaw model diagnostics

Choose **Diagnostics > Connection > Test harness > OpenClaw**, then **Check OpenClaw**. Load exactly one language model in LM Studio first, with one concurrent prediction. The inspected installation for this adapter is OpenClaw **2026.7.1-2**. A different installed version needs adapter verification before testing.

OpenClaw diagnostics runs the real embedded OpenClaw agent, connected to Harbor's disposable MCP tasks. It creates a fresh state directory and workspace for every trial. It does not import the user's agent sessions, channels, skills, credentials or memory. Normal OpenClaw installation and configuration stay separate.

The selected model must already be loaded at the local LM Studio endpoint (`http://127.0.0.1:1234/v1`). Checking the connection does not start or load a model. During trials, a local observation relay accepts only the chosen model's chat-completion requests and a synthetic model listing. Model loading routes, model switches and concurrent predictions are rejected. Authentication-enabled model endpoints are not yet supported by this adapter; they fail inspection rather than silently falling back.

The 8K integration fixture uses a 1,024-token output reserve, with the additional compaction reserve floor disabled, and a bounded recent-history budget. These are isolated OpenClaw settings, not changes to the LM Studio context. Default OpenClaw reserves can otherwise leave too little room for its own prompt on a small-context model. Bundled skills and memory are disabled for the controlled task suite.

For a curated task with no available tools, Harbor first verifies the private gateway's empty catalog through MCP. It then explicitly disables all OpenClaw tools for that trial and checks that the first serialized model request also has no tools. An unexpected nonempty catalog is rejected. This avoids OpenClaw's startup error for a named tool group with no matches while preserving the intended task conditions.

## What the results mean

- Completion and adherence come from the same independent task verifiers used for Hermes.
- Tool dispatch is observed through an isolated OpenClaw plugin. Argument validity is checked against observed tool schemas.
- Tool definitions and inference controls are captured from the actual serialized outbound HTTP requests. Ordinary request evidence omits messages and headers.
- Timing includes installed-agent startup and observation overhead. It is not pure model inference time. Host RAM/GPU readings include other programs, including a running game.
- Output token usage is reported by OpenClaw. Missing process RSS, CPU, costs and model provenance remain unknown.
- Model configuration changes exclude the trial. Resource stops end the campaign; unrun trials are not scored.
- Installed entry/package/shrinkwrap and top-level compiled runtime files are fingerprinted. Transitive dependency bytes, LM Studio weight bytes, full server defaults and process ownership are not attested. The existing advice gate therefore withholds confirmed configuration recommendations where complete comparison identity is missing.

Saved results identify the harness. Compare equivalent tasks and settings in separate Hermes and OpenClaw campaigns; do not pool different harnesses into a single claimed fixed-setup delivery comparison. An integration fixture passing is evidence that the runner works, not evidence that a real model will pass the task.

## Engineering acceptance

The installed OpenClaw protocol fixture has completed a real Harbor read/write sequence with three model requests and two schema-valid tool dispatches. Exact outbound tool definitions matched the independent endpoint capture. Initial retained failures exposed cold-start timing and an 8K reserve overflow; the corrected fixture passed. The larger model campaign, native packaged UI and installed-client acceptance remain separate checks.
