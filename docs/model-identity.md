# Model identity for local delivery comparisons

The installed Hermes adapter can now acquire model evidence instead of filling weight/context/default fields with permanent unknown placeholders. A successful connection alone still does not enable advice. The selected model must be running, its live properties and owning process must agree, and the campaign's start/end observations and exact outbound settings must remain comparable.

This implementation is gated to Hermes revision `1675f1f2c25ce164f07c42e829f2c17a723db94f` and the locally inspected llama.cpp build **10679 / 50f068fff**. Another runtime build remains unverified until its protocol behavior is checked. The installed version was independently read with `llama-server.exe --version`; that command does not load a model.

## What is measured

| Evidence | Acquisition and limits |
| --- | --- |
| Endpoint ownership | The configured PID must own the listening port and identify as `llama-server`; its creation time is retained. |
| Selected model process | The reported model path must match the explicit model argument of exactly one endpoint process or its descendant, using the same runtime executable. A router PID alone is insufficient. |
| Weight identity | Full SHA-256 of supported GGUF bytes, with bounded GGUF metadata parsing. Split models require every declared, correctly numbered shard. Configured multimodal projectors and draft-model files are included. |
| Runtime identity | SHA-256 manifest of the executable and adjacent DLLs. The small Windows launcher alone does not identify the implementation. |
| Effective context | Positive integer `default_generation_settings.n_ctx` from the selected model's live properties. The model's advertised training context or a config preference is not substituted. |
| Inference defaults | Fingerprint of reported generation parameters, effective context, template/capabilities, slot count, modalities, sanitized launch arguments, relevant runtime environment and runtime bundle identity. |
| Hardware | Existing CPU/RAM/GPU inventory, now including GPU driver version and device identity. Changing those fields changes the hardware comparison context. |

Files modified after their owning process started are rejected: current disk bytes would not establish what that process loaded. File identity, size and modification/creation timestamps are checked around hashing and again before accepting the manifest. A fresh probe/trial worker hashes bytes again. Within the same short-lived worker, a digest is reused only for unchanged file metadata and process lifetime. There is no persistent trusted digest cache and no claim of protection against a privileged actor forging filesystem metadata.

Supported GGUF headers are versions 2 and 3, bounded to 64 MiB of metadata, 100,000 metadata keys, one million array entries and 64 split shards. Missing parts, malformed metadata, unaccounted weight arguments, ambiguous ownership and unavailable properties leave comparison identity unknown. Live LoRA adapter state is deliberately unsupported because hashing a configured LoRA file would not establish its currently applied scale. Those sessions can still run diagnostic tasks, but cannot receive measured comparison advice from this adapter.

## Read-only probe and privacy

The adapter validates the local runtime build before requesting selected-model properties. The request is `GET /props?model=…&autoload=false`; it does not activate, switch, install or download a model. Loopback requests bypass ambient proxies and reject redirects, so the configured credential cannot follow a redirect to another destination. Responses are capped at 2 MiB. This behavior follows the inspected [build-10679 router implementation](https://github.com/ggml-org/llama.cpp/blob/b10679/tools/server/server-models.cpp) and its [properties/GET-routing documentation](https://github.com/ggml-org/llama.cpp/blob/b10679/tools/server/README.md).

Evidence retains hashes, sizes, limited GGUF metadata, runtime library names, build/process identifiers and effective context. Raw model paths, launch arguments, environment values, chat-template text, grammar text and credentials are not exported. Credential-bearing command-line options and environment keys are omitted or replaced before the remaining settings are fingerprinted. Failures expose fixed explanatory messages rather than arbitrary file/HTTP exceptions.

**Check Hermes** displays whether model files/context/runtime are verified or which evidence category remains unavailable. Hashing large weights can take up to the two-minute probe budget. Closing Diagnostics cancels the probe worker; no background model is started. Trial budgets still include their verification/startup work. Reported total trial latency therefore must not be labeled pure inference time or exclusive Harbor overhead.

## Evidence status

Engineering acceptance uses small synthetic GGUF files, real local HTTP requests and controlled process metadata. It tests full/sharded/auxiliary bytes, runtime DLLs, defaults/context drift, file mutation, missing/ambiguous owners, build gates, redirect rejection and private-data exclusion. Installed Hermes and native Electron tests separately preserve real MCP execution, campaign grading/history and UI behavior against a deterministic protocol fixture.

These checks do not establish real-model quality or verify a stopped model's loaded state. Real-model task outcomes and their resource measurements are separate evidence from the protocol fixtures; successful task outcomes alone do not establish fully attested comparison identity. Final packaged and clean-machine acceptance are also separate gates.

## Configured LM Studio and explicit acceptance

The normal **Check Hermes** workflow reads Hermes's saved LM Studio provider, IPv4 loopback `/v1` endpoint, model selection and context length. It resolves a configured model key to the one already loaded native instance. A missing or different loaded model fails preflight instead of triggering JIT loading. The programmatic acceptance path still requires an exact instance ID. Both paths check exact context and single-request concurrency and verify that the listener belongs to LM Studio. Additional loaded models reject preflight. Diagnostic trials use Hermes's native LM Studio provider in a fresh home with fixed, observed sampling controls; the user's Hermes configuration is not changed. LM Studio load/unload and memory management belong to the external acceptance helper, not the ordinary read-only diagnostic probe.

Loaded model metadata and load configuration are observed at trial boundaries. Countdown TTL is not configuration drift. These observations do **not** yet prove loaded weight/runtime bytes or all effective inference defaults. Their verification label is distinct from the GGUF/llama.cpp provenance above; comparison advice remains unavailable. Direct task outcomes are still independently verified. The external model-comparison experiment is separate from Harbor's fixed-setup delivery recommendation policy.

For a saved Hermes reasoning effort outside the loaded model's advertised options, the normal path follows the gated Hermes implementation: omit `reasoning_effort` and leave the server default in control. Evidence records the requested effort, omitted request value, published default (or unknown), and fallback policy. It does not relabel a toggle model as supporting "high" or rewrite the saved configuration. Explicit acceptance requests reject unsupported effort during preflight, preserving their fixed-control contract.
