# Phase 2 implementation and acceptance

Updated September 20, 2026. This page describes the development source, not a declaration that every published binary contains these changes.

## Implemented

- Shared MCP gateway with named profiles, capability controls and configurable tool discovery.
- MCP tools, resources and prompts, including supported progress/cancellation behavior; sampling, roots and elicitation remain outside the supported proxy surface.
- Request timelines and local evidence inspection/export.
- Guided diagnostics for installed Hermes, OpenClaw and native LM Studio, focused on Harbor-supplied tools.
- Real file, SQLite and browser tasks with independent artifact checks, instruction-adherence checks and false-success detection.
- Connection instructions for LM Studio, Hermes, OpenClaw, OpenCode, OpenHands, Goose, Open Interpreter, Open WebUI, Letta, AnythingLLM and general MCP clients. A recipe is not proof of compatibility with every client version.
- Portable acquisition/build/assembly helpers, maintenance controls, resource monitoring and a 71-page operating manual.

## Measured local evidence

| Check | Result | Qualification |
| --- | --- | --- |
| Final LM Studio adapter tests | 20 passed, zero skipped | Covers registration synchronization, event interleaving, attribution, cancellation and incomplete calls. |
| Native-protocol campaign | 27 passed; 62 real Harbor tool dispatches | Deterministic model fixture; an integration result, not a language-model quality score. |
| Actual installed LM Studio | Native execution verified on 0.4.21+2 | A small Qwen model successfully read a record but omitted the required write while claiming completion. Harbor correctly graded the task incomplete. |
| Earlier complete portable desktop candidate | Ten functional checks passed; sixteen account-free servers and 437 tools | Pre-final-LM-fix package. Seven of eight performance targets passed; first DuckDB startup was 10.47 seconds against a 10-second target. Warm follow-ups do not erase that miss. |
| Client configuration and bridge cases | 92 passed | Protocol/formatter checks; actual external-client version acceptance remains separate. |
| Final corrected portable candidate13 | Ten functional checks passed; seven of eight performance targets passed | Sixteen account-free servers/437 tools. MarkItDown first startup was 19.65 seconds and DuckDB 10.11 seconds against a 10-second target. Zero tracked child processes survived shutdown. |

The final corrected portable candidate completed assembly-specific functional acceptance. Its 1.42 GB private-review ZIP passed complete file-membership and decompressed-byte verification. Evidence is tied to exact source/build identities; earlier runs are not silently relabeled as the newest build. Hardware-dependent timing and tool counts are observations from this setup, not universal guarantees.

## Release work still open

- Independent Windows runtime/build validation.
- Installed-demo verification (the corrected package itself passed local functional acceptance).
- Remaining third-party notices and applicable corresponding-source obligations before public binary redistribution.
- One final security review at the final release checkpoint, followed by any necessary fixes and documentation updates.

Harbor is MIT-licensed original software; bundled tools and runtimes keep their own licenses. See [licensing](../LICENSING.md). No claim of universal client compatibility, blanket security certification or a universally best model is made.
