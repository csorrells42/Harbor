# Portable build and verification helpers

The normal application workflow is documented in the repository README. The Phase 2 recipes below acquire pinned public inputs, stage runtimes and packages, build the application and source components, and assemble a fresh Windows Portable toolbox. Other helpers operate on an **already prepared payload**; inspect each helper's preconditions. A completed assembly does not establish complete redistribution attribution or independent clean-machine acceptance.

No script in this directory is automatically run merely by cloning the repository. Read the script and its inputs before using it. Installation, staging and verification scripts can write to the Portable root passed to them. Test against a disposable, deliberately prepared copy when evaluating a new build; do not point a verification script at an unrelated or actively used profile.

The local server catalog provides host file access under the Windows account running Harbor. Filesystem discovers accessible drive roots; Playwright permits files outside the working directory, including local file URLs; Git Local lets each call choose its repository. A server's working directory is a default location, not a filesystem sandbox. Windows permissions still apply. Document/database tools retain their native document and connection interfaces; search and reasoning tools do not become general file writers.

## Reusable build helpers

`release-manifest.mjs` provides explicit payload capture and offline hash verification. See the [manifest contract and usage](../../docs/portable-release-manifest.md). The [pinned build workflow](../../docs/portable-build-inputs.md) describes acquisition, component staging, offline source builds and fresh final assembly.

`acquire-inputs.mjs` now acquires explicitly pinned public artifacts into a separate verified cache. The initial Windows x64 input manifest covers Node, uv, GitHub CLI, Python, MinGit and Typst. See [verified build inputs](../../docs/portable-build-inputs.md) for online/offline commands, provenance, bounds and recovery. It does not yet assemble the complete toolbox.

`source-revisions.windows-x64.json` and `source-patches/` preserve nine upstream server revisions and five local patch sets; `source-inputs.windows-x64.json` pins their verified public archives. Archive/index reconstruction matches all expected source trees. `package-inputs.windows-x64.json` and `package-inputs/` preserve three npm package groups plus two Python requirement sets. Nine source checkouts and online/offline extraction of the three npm groups have acceptance evidence. Python artifact hashes, remaining dependency/helper assets and full package assembly remain separate work.

| Helper | Inputs and purpose |
| --- | --- |
| `build-harbor-application.mjs` | Allowlisted source, verified runtime/Electron stages, isolated npm cache and fresh output; builds the application with pinned dependencies and publishing disabled. Supports an offline replay. |
| `assemble-portable.mjs` | Eleven completed, hash-pinned stage receipts and a fresh destination; verifies component files, retains reviewed source histories, writes clean catalog/maintenance recipes and inventories the payload. Does not import user data. |
| `acquire-inputs.mjs` | Versioned input manifest, separate cache and new receipt; bounded size/SHA-256-verified downloads or offline re-verification. Does not extract or execute inputs. |
| `stage-runtimes.py` | Validated input manifest/layout, verified cache and new output directory; offline bounded extraction of all six runtimes with per-file hashes and incomplete-stage markers. Requires explicit build Python; does not run extracted code. |
| `stage-sources.mjs` | Exact source revisions/patches, explicit Git executable and new output directory; fetches pinned commits and stages validated source checkouts with maintenance ancestry. Does not install dependencies or execute source. |
| `seed-catalog.mjs` | New output JSON path; constructs the nineteen-server release catalog from source declarations without reading personal configuration or accounts. Refuses replacement. Package and browser availability must be verified separately. |
| `stage-npm-groups.mjs` | Pinned package-input manifest, staged runtime root, existing isolated cache and new output; runs npm's integrity-checked extraction for three groups with lifecycle scripts disabled. Supports `--offline`; actual MCP/native-helper acceptance remains separate. |
| `release-manifest.mjs` | Explicit payload root and versioned plan; hashes selected files into a new external report, or verifies them against an existing manifest. Does not change the payload or run tools. |
| `build-dbhub.mjs` | Portable root, staged DBHub package; builds its prepared source with bundled runtimes. |
| `build-delivery.mjs` | Portable root, component ID, stage; builds FastMCP or Portkey, or resolves a FastMCP lock. Requires the appropriate staged source/dependency metadata. |
| `prepare-embedding-models.mjs` | Prepared Portable root with the Portkey package; acquires/prepares the configured local model assets. This is an explicit model-preparation operation. |
| `update-github-release.mjs` | Repository, archive-name pattern, stage; downloads an upstream release and checks its published hash. Requires the Portable runtime environment. |
| `stage-build-output.mjs` | Stage root, source-relative output, destination-relative output; places a verified build into staging. |
| `stage-release.mjs` | Uses the current working directory, `release-portable-candidate/win-unpacked`, and `.harbor-build/Harbor Portable`. Copies application/support sources and writes initial maintenance recipes. `--recipes-only` only writes recipes. This is a partial staging helper, not a complete portable installer or a repair command for an arbitrary existing profile. |
| `install-office-tools.mjs` | Explicit Portable root; adds Office server configuration/recipes to an existing payload. `--sources-only` copies already-prepared sources from `.harbor-build`. It assumes its component payloads and prerequisites are available. |
| `office-components.mjs`, `delivery-components.mjs`, `dbhub-component.mjs` | Server/maintenance recipe definitions used by the helpers. |

The source snapshot excludes a machine-specific historical assembler and one-time migrations. The staging helpers still require pre-provisioned package trees, compatible runtimes, model assets, browser assets and license notices. Ordinary `npm run pack` builds the Harbor desktop application; it does not recreate a complete Portable toolbox.

`launcher.mjs`, `probe.mjs`, and some build/verification helpers are designed to be copied into a Portable `support` directory. Their adjacent imports, such as `./portable.mjs` or `./release-retention.mjs`, are supplied there from `src/core` by the staging helper. Running every file directly from its repository directory is not supported.

## Verification scope

The default source suite lives in `tests/`. Portable checks below are separate, opt-in acceptance helpers. Some invoke real tools, create documents/databases, run child processes, make network requests, load models, or launch and quit the chosen application. They are not read-only status probes.

| Helper group | Preconditions and effects |
| --- | --- |
| `verify-delivery-component.mjs`, `verify-tool-modes.mjs` | Prepared search packages/runtimes; exercises actual discovery/invocation against generated fixtures. |
| `verify-office-tools.mjs`, `verify-dbhub.mjs`, `verify-pdf-tools.mjs` | Prepared matching package; creates and inspects real temporary or verification artifacts. Optional gateway endpoint arguments invoke the actual selected gateway. |
| `verify-folder.mjs` | **Prepared-profile acceptance**, requiring `application/initial/MCP Harbor.exe` and expected bundled servers. Uses the supplied root's actual data profile and an ephemeral port; it does not isolate or clone that profile. Starts real servers, writes a PDF, enters/resumes maintenance, then quits the app. |
| `verify-maintenance.mjs` | Component ID and prepared Portable root, with the candidate closed. Rebuilds and can replace the selected component through actual maintenance behavior. |
| `verify-live.mjs` | Prepared full-toolbox profile, running gateway and expected core servers. Writes a temporary file, launches a Windows process, drives Chromium, creates a PDF, and may call GitHub. It expects raw namespaced tools; supply the internal `/_harbor_catalog` endpoint when testing a gateway whose main endpoint uses a search mode, or use an All-tools disposable profile. It does not switch the user's delivery settings. |
| `verify-current-desktop.mjs` | **Fixed-profile acceptance**, expecting 19 configured servers, 16 maintenance components, no retained backups, core tool servers and a raw-tool endpoint. Launches/quits the specified Portable app and invokes other live verifiers. These exact counts describe this fixture profile, not every valid Harbor installation. |
| `verify-pdf-desktop.mjs` | **Prepared-profile acceptance**, expecting PDF Tools and Typst already configured and running; launches/quits the specified Portable app. |
| `verify-office-desktop.mjs`, `verify-delivery-desktop.mjs` | **Prepared-profile acceptance** for their expected Office/delivery configurations. Inspect exact selections and save behavior before using them on a profile. |
| `verify-open-pdf.mjs` | Uses the running local gateway and opens a supplied PDF through a real desktop tool. |
| `benchmark-search-models.mjs` | Reads the running raw catalog and benchmarks prepared local embedding models; consumes CPU/memory and writes measurements. It is not a chat-model/harness benchmark. |
| `inventory.mjs` | Inventories a supplied payload and produces local metadata. Review generated paths and contents before publishing the report. |

Several optional acceptance scripts write to `evidence/portable` relative to the current checkout. Create that directory in the test checkout if needed. Evidence, screenshots, run logs, profiles, provider keys, runtime payloads and generated packages are excluded by `.gitignore`; do not add them to the public source repository. A green source unit suite is not evidence that every external account, model, browser runtime or prepared Portable profile has passed these opt-in checks.
