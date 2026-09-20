# Verified Portable build inputs

`acquire-inputs.mjs` downloads declared public artifacts into a separate cache and verifies their exact sizes and SHA-256 hashes. It does not extract archives, execute downloaded programs, install a component or modify an existing Portable folder.

The checked-in `runtime-inputs.windows-x64.json` pins six inputs: Node 24.19.0, uv 0.12.12, GitHub CLI 2.96.0, CPython 3.13.15 (standalone 20260901 stripped build), MinGit 2.55.0.windows.5 and Typst 0.15.1. Source revisions/patches, npm groups, Python distributions, source-build dependencies, browser payloads, embedding assets and application binaries have separate pinned inputs and staging recipes below. Fresh application and toolbox assembly are implemented; complete release attribution and independent clean-environment acceptance remain separate gates.

Run with a supported bootstrap Node installed explicitly in the build environment. A clean **runtime** machine will use the eventual bundled Node; this acquisition command does not imply a runtime dependency on global Node.

```powershell
New-Item -ItemType Directory -Path .harbor-build -Force
node scripts/portable/acquire-inputs.mjs scripts/portable/runtime-inputs.windows-x64.json .harbor-build/input-cache .harbor-build/acquisition.json
node scripts/portable/acquire-inputs.mjs scripts/portable/runtime-inputs.windows-x64.json .harbor-build/input-cache .harbor-build/acquisition-offline.json --offline
```

Use a new receipt filename for each run. The cache directory may be new, but its parent must already exist. The helper validates the complete manifest before acquiring files; it never imports personal profiles or searches global runtime installations. Runtime/build usage and license declarations are retained in the receipt. A license declaration records the input's attribution; it is not a full dependency inventory or redistribution clearance.

Each artifact declares `id`, `role`, `version`, `usage` (`build`, `runtime`, or `both`), a public HTTPS `url`, exact positive `bytes`, lowercase `sha256`, and `license`. Schema version is 1. IDs are unique; manifests contain 1–256 artifacts, each at most 8 GiB. Pin the version or source revision in the URL. Moving `latest`, `main`, `master` and `HEAD` path segments, credentials and query strings are rejected in declared URLs. Public HTTPS redirects are bounded to five; temporary signed redirect queries are not retained in receipts. The fetcher sends no account credentials.

Downloads stream into unique `.part` files with a five-minute artifact timeout and a strict byte bound. Only verified, flushed bytes are published to `<sha256>.blob`, using an atomic hard link that refuses replacement. This requires a filesystem supporting hard links, such as NTFS. Files with the same digest share one cache entry. Receipts report both declared total bytes and unique cache bytes.

Existing cache entries are rehashed on every use. A corrupt cache entry fails instead of silently replacing it. Offline mode performs no network requests and fails on a missing input. Interrupted downloads remove their owned partial file; already verified earlier inputs remain reusable. Cache paths containing directory links or junctions are rejected. A cache lock prevents overlapping acquisitions. A process crash can leave a `.acquire.lock` or `.part` file: inspect the recorded PID and confirm the acquisition process has ended before removing only that cache's stale lock or partial file. The helper does not automatically delete ambiguous ownership state.

Download receipts establish exact acquired bytes only. They do not establish extraction safety, full runtime-tree correspondence, successful builds, redistribution compliance, offline application behavior or clean-machine acceptance.

## Pin provenance

The initial Node archive digest was read from the official [v24.19.0 checksum list](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt); its exact length was checked against the same official archive. uv and GitHub CLI digest/size metadata came from the exact official releases: [uv 0.12.12](https://github.com/astral-sh/uv/releases/tag/0.12.12) and [GitHub CLI 2.96.0](https://github.com/cli/cli/releases/tag/v2.96.0). These are pinned acquisition records, not automatic latest-version resolution. Upstream metadata was observed on 2026-09-19.

Local acceptance acquired and verified all six currently pinned archives (153,074,626 unique compressed bytes), then verified them again offline. The primary executable inside each archive matched the installed corresponding executable hash. That comparison covers six files, not complete runtime trees. The unstripped Python archive was also checked and did not match; the final pin uses the matching stripped variant, with that earlier failed correspondence evidence retained. Focused tests cover corruption, size mismatch, interruptions, redirect bounds, offline behavior, link rejection, cache ownership and manifest validation.

Python, MinGit and Typst checksum/size metadata came from the exact official releases: [python-build-standalone 20260901](https://github.com/astral-sh/python-build-standalone/releases/tag/20260901), [Git for Windows v2.55.0.windows.5](https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.5), and [Typst v0.15.1](https://github.com/typst/typst/releases/tag/v0.15.1).


## Offline runtime staging

The companion `stage-runtimes.py` and `runtime-layout.windows-x64.json` assemble the six declared runtime archives into a **new** directory. Python 3.13 or later is an explicit build prerequisite for this command; the command never discovers or copies globally installed runtimes. Its standard-library implementation performs no downloads and invokes no extracted programs.

```powershell
python -B scripts/portable/stage-runtimes.py scripts/portable/runtime-inputs.windows-x64.json scripts/portable/runtime-layout.windows-x64.json .harbor-build/input-cache ".harbor-build/Harbor runtime candidate"
python -B tests/test_stage_runtimes.py
```

Every compressed input is checked against its declared size and digest before an output directory is created. Layout entries specify the archive format, exact root prefix to strip, unique runtime destination, explicit file relocations, and an unpacked-byte bound. The layout must account for every input. The GitHub CLI's `bin/gh.exe` is placed directly at `runtimes/gh/gh.exe`; the rest of its archive, including license/documentation content, is retained. No duplicate executable is made for that relocation.

The extractor rejects links, special files, encrypted ZIP entries, traversal, Windows reserved paths, duplicate/case-colliding paths (including parent spelling), and undeclared archive prefixes. Bounds are 100,000 entries per archive, 512 MiB per file, 2 GiB per component and 8 GiB total declared expansion. It creates regular files directly and does not use unrestricted `extractall`. It checks input archives again after extraction.

Success produces `runtime-stage.json`, which records every extracted file's relative path, size and SHA-256 along with its source archive and component identity. A failed or interrupted stage retains `STAGING-INCOMPLETE.json`; it must not be treated as an assembled candidate. An existing output directory is never overwritten. Partial staging remains bounded by the declared limits. Inspect and remove only that disposable stage before retrying with a new output path; this command never prunes existing installations or application releases.

A local staging run produced **5,666 runtime files / 399,347,785 bytes** in a new path containing spaces and Unicode. After the final extraction validation changes, a second complete stage produced the same per-file paths, sizes and SHA-256 hashes. All nine smoke checks passed again: Node, npm, Python's SSL/SQLite/ctypes modules, Git, uv, GitHub CLI, Typst, a local Git index operation and a Typst PDF compile, with global runtime paths excluded from child `PATH`. The evidence includes the staging source and input hashes. These checks used the current Windows user and machine; they do not establish a separate clean Windows environment, complete Harbor startup, upstream server functionality or a transitive SBOM.

## Server source revisions and package inputs

`source-revisions.windows-x64.json` records nine exact upstream source commits, the expected upstream and patched Git trees, and five SHA-256-pinned patch files under `source-patches/`. The inspected source checkouts had no tracked changes or untracked files. The recorded revisions were verified on their public upstream commit pages. Local checkout paths and Git remotes are not build inputs.

| Component | Pinned upstream revision | Captured local delta |
|---|---|---|
| Typst MCP | [a0f0f0e](https://github.com/edward-lcl/typst-mcp/commit/a0f0f0e5411349c0a42f6084e3812edeef77ec2e) | npm lock |
| Serena | [c6fbd1c](https://github.com/oraios/serena/commit/c6fbd1c5932df2494ffa0020af5a9fbe80b82143) | Generated-directory ignore rules |
| PDF Tools | [345a69c](https://github.com/rsp2k/mcp-pdf/commit/345a69c062ef5f4fd312a29d0cca6d09988899df) | Compatible MCP dependencies, Typst preference and closed-document page-count fix/test |
| DuckDB | [275d2e7](https://github.com/motherduckdb/mcp-server-motherduck/commit/275d2e7d2ba4f5b48ce8ad3f01a9aeea8bd08616) | None |
| MarkItDown | [945314a](https://github.com/microsoft/markitdown/commit/945314a45ddbe02935f2fd287b797dc0ba4a01e4) | None |
| Excel | [f51340e](https://github.com/haris-musa/excel-mcp-server/commit/f51340ecd5778952405044b203d3a2d4c8a46833) | None |
| Word | [9c0c0b7](https://github.com/SecurityRonin/docx-mcp/commit/9c0c0b7694d8123e82fe6b7c480899890dca0695) | None |
| DBHub | [80b87cb](https://github.com/bytebase/dbhub/commit/80b87cb74f16c20a711d8b1d12a0cbb08432f8cd) | Windows SQLite paths and dependency updates/lock |
| Portkey | [f53ebc1](https://github.com/Portkey-AI/mcp-tool-filter/commit/f53ebc13793268ba4ca1d549239f3fb59b403a63) | Bounded embedding batches, replaced-model disposal and dependency pins |

All five patches passed a read-only reverse-application check against the inspected Git index. All nine public source archives were then downloaded, pinned in `source-inputs.windows-x64.json` (14,276,060 bytes total), and verified again offline. Independently reconstructed Git trees from those ZIP contents matched every recorded upstream tree. Applying the five patches to isolated Git indexes reproduced every expected patched tree. No archive symlinks were followed and no source code was executed. These are source-byte and patch-correspondence checks; dependency installation and complete clean builds remain pending. The upstream licenses and dependency qualifications in `third-party/portable/default-server-licenses.json` still apply; this input capture is not a complete redistribution inventory.

`stage-sources.mjs` prepares a new source staging directory using an explicit build Git executable and the pinned revision manifest:

```powershell
node scripts/portable/stage-sources.mjs scripts/portable/source-revisions.windows-x64.json ".harbor-build/Harbor runtime candidate/runtimes/git/cmd/git.exe" ".harbor-build/Harbor source candidate"
```

The helper fetches exact public commits, verifies their trees, applies hash-checked patches to the index, validates the resulting regular-file paths for Windows, and only then checks out source. It creates a deterministic local patch commit using the manifest timestamp and a generic build identity. The actual upstream commit remains an ancestor so Harbor maintenance can merge future upstream changes. Build commands exclude global Git configuration, credential helpers and hooks. Source downloads occur explicitly during this build step, not at application startup. Archive acquisition and Git staging are separate transports tied to the same expected source trees.

The output must be new; interrupted work retains `SOURCE-STAGING-INCOMPLETE.json`. Success writes `source-stage.json`. Existing Portable installations are never replaced. Seven focused tests cover source URL/revision/patch declarations, unsafe paths, links, submodules, case/file-directory collisions, preservation of existing output and rejection of corrupt patches before staging. A real run with the newly staged Git runtime also passed for all nine repositories in a new directory containing spaces and `ü`: every patched tree matched, every working tree was clean, and each upstream commit remained an ancestor. Dependencies, application assembly and independent clean-user runtime acceptance remain separate work.

`package-inputs.windows-x64.json` records the exact copied manifests and locks under `package-inputs/` for General Local, Browser/Context7 and Brave Search. Direct versions match their npm lock entries; every non-root lock entry has a credential-free official npm registry URL and SHA-512 integrity. No installed dependency directories are copied. The isolated online/offline npm extraction described below verifies these inputs; native helper assets and actual MCP readiness remain separate acceptance work.

Python Tools and FastMCP also have captured `requirements.in` and exact-version `requirements.txt` files. The two generated header lines containing the original machine-specific uv invocation were replaced with a portable explanation, and line endings normalized; dependency lines are unchanged. The receipt retains original and normalized file hashes. The subsequent wheel contract below adds distribution hashes and a verified Windows/Python 3.13 wheel set without changing these captured inputs.

## Shared Python wheel groups

`pin-python-wheels.py` runs with the explicitly staged CPython 3.13.15 and selects compatible, non-yanked binary wheels using official PyPI metadata and the runtime's supported tags. It binds the original captured requirements, distribution identity, official artifact URL, size and publisher SHA-256. The checked-in `python-wheels.windows-x64/` contract contains 94 distinct versioned wheels totaling 40,835,945 bytes; all were acquired and verified again offline. Python Tools contains 48 installed distributions and FastMCP contains 71. Their different MCP versions remain isolated. License declarations remain `NOASSERTION` pending review.

```powershell
& '.harbor-build/Harbor runtime candidate/runtimes/python/python.exe' -I -B scripts/portable/stage-python-groups.py scripts/portable/python-wheels.windows-x64 scripts/portable/package-inputs.windows-x64.json .harbor-build/python-wheel-cache '.harbor-build/Harbor runtime candidate' '.harbor-build/Harbor Python candidate'
```

`stage-python-groups.py` checks the complete contract and cached wheel bytes before creating output. It rejects existing output, links/junctions, mismatched source requirements, extra or missing pins and unsupported wheel identities. Staged uv installs offline from verified wheels with hashes required, source builds disabled, isolated home/configuration and a restricted PATH. Success records exact installed versions and every installed file hash; failure retains an incomplete marker. Original `.in`/`.txt` inputs and hash requirements are retained for maintenance. Build home and wheelhouse are build artifacts, not release payload.

Seven focused tests passed. Two successful independent offline stages produced matching package inventories and executable/package bytes. The only differences were uv's installation timestamps in `uv_cache.json` and corresponding `RECORD` checksums; these differences are retained and explicitly reported. This is not a claim of byte-identical installation trees.

Actual staged component acceptance passed seven checks: native imports in both groups, Fetch against a private Unicode fixture, Git status/add/staged diff using staged Git, and FastMCP BM25, regex and Code Mode tool discovery/execution through Harbor. Code Mode executed the native Monty binary. These checks used isolated homes and excluded global runtimes from PATH while models were unloaded. Project-specific Python applications, complete assembly/relocation, licensing/SBOM and independent clean-user acceptance remain separate work.

## Source-project Python dependencies and builds

`capture-source-python-inputs.py` reads the clean, pinned Git trees for Serena, PDF Tools, DuckDB, MarkItDown, Excel and Word. It reads static dependency declarations and selected extras without executing project metadata code. MarkItDown's version assignments are parsed as literals. URL dependencies, unknown build backends, changed Git trees and dynamic dependency declarations fail capture. The selected extras match the release recipes, including PDF forms/Markdown and MarkItDown's complete declared `all` extra. Local sibling projects are recorded separately from published dependencies.

The explicit online capture uses official PyPI metadata, staged Python/uv, isolated configuration and disabled source builds. Its checked-in output under `source-python-inputs.windows-x64/` retains direct requirements, full resolver output, concrete remote pins, source trees and metadata hashes. The compatible wheel contract under `source-python-wheels.windows-x64/` contains 229 distinct versioned artifacts totaling 277,005,410 bytes. Build tools are a separate `python-build` group; they are not intended for the runtime payload.

Serena's `proxy-tools==0.1.0` dependency has no published wheel. `python-source-inputs.windows-x64.json` therefore pins its 2,978-byte official source archive and publisher SHA-256. The exact setup script and Python module were reviewed. `build-python-source-deps.py` accepts only that reviewed archive, rejects links/unknown members, builds offline with pinned tools and checks that the wheel's module matches the original source bytes. The local wheel receipt binds archive, build tools and output hashes. Dependency staging requires this exact receipt and verifies that remote plus locally built wheels cover the full resolver output. It does not silently drop the source-only dependency. Its license remains `NOASSERTION`: distribution metadata says MIT, while the source header says BSD and references a missing license file.

```powershell
# Build tools must first be acquired and staged using their checked-in wheel contract.
& '<staged-python>' -I -B scripts/portable/build-python-source-deps.py scripts/portable/python-source-inputs.windows-x64.json '<source-cache>' '<runtime-stage>' '<build-tools-stage>' '<new-source-wheel-stage>'
& '<staged-python>' -I -B scripts/portable/stage-python-groups.py scripts/portable/source-python-wheels.windows-x64 scripts/portable/source-python-inputs.windows-x64/package-inputs.json '<dependency-wheel-cache>' '<runtime-stage>' '<new-dependency-stage>' --source-wheels '<source-wheel-stage>'
& '<staged-python>' -I -B scripts/portable/build-python-projects.py scripts/portable/source-python-inputs.windows-x64/package-inputs.json '<source-stage>' '<dependency-stage>' '<runtime-stage>' '<new-project-stage>'
```

`build-python-projects.py` checks dependency file membership/hashes and source Git trees before creating a new output. It retains upstream source history, builds project wheels offline using the staged build group, verifies wheel identity and installs only the built project wheels with hashes required. It then checks the exact final installed inventory and every active dependency constraint, including selected/transitive extras. Actual MCP behavior and complete release relocation remain separate acceptance gates; successful wheel construction alone is insufficient.

## Node source projects and CPU embedding assets

`source-node-inputs.windows-x64.json` binds the reviewed Typst MCP, Portkey and DBHub source trees to their exact manifest/lock bytes. `build-node-projects.mjs` verifies those identities, copies only Git-identified regular source files, installs locked dependencies with lifecycle scripts disabled, runs the explicit TypeScript compiler and removes development dependencies. It uses staged Node/npm/Git and an isolated build home. Actual online and fresh offline builds produced identical full package inventories: 3,679 Typst files and 2,813 Portkey files. This covers these source projects, not the entire release.

```powershell
node scripts/portable/build-node-projects.mjs scripts/portable/source-node-inputs.windows-x64.json '<source-stage>' '<runtime-stage>' '<npm-cache>' '<new-node-project-stage>' --offline
```

DBHub uses separately pinned pnpm 10.17.1, acquired through `node-build-tools.windows-x64.json` and extracted with `node-build-tools-layout.windows-x64.json`. `build-dbhub-source.mjs` verifies the source tree and pnpm's full staged inventory, installs the frozen workspace lock with scripts disabled, generates API types, builds backend and frontend, runs the two SQLite integration suites, and retains production dependencies. The frontend's actual output is `dist/public/index.html`. A fresh offline build passed all 57 SQLite checks and inventoried 22,693 files. An earlier verification attempt incorrectly expected `frontend/dist`; its failed receipt remains separate.

```powershell
node scripts/portable/build-dbhub-source.mjs scripts/portable/source-node-inputs.windows-x64.json '<source-stage>' '<runtime-stage>' '<pnpm-stage>' '<pnpm-store>' '<new-dbhub-stage>' --offline
```

Real component checks additionally verified Typst MCP compilation with independently extracted PDF text and an invalid-source failure; DBHub MCP writes/schema discovery, process restart and independent SQLite persistence; and Portkey CPU semantic retrieval with all four bundled model choices. No cloud provider or non-SQLite database acceptance is implied.

`embedding-inputs.windows-x64.json` pins the four Xenova CPU embedding models to exact Hugging Face repository commits. ONNX bytes are bound by repository LFS SHA-256; small metadata files were checked against Git blob identity before recording SHA-256. Twenty files total 203,943,910 bytes. Online acquisition and offline verification passed. `stage-embedding-models.mjs` only accepts the four reviewed model IDs and explicit filename set, rejects mismatched URLs/revisions and existing output, and verifies all copied bytes. Model cards are retained. Missing license declarations remain `NOASSERTION`; complete redistribution notices remain a separate gate.

```powershell
node scripts/portable/acquire-inputs.mjs scripts/portable/embedding-inputs.windows-x64.json '<acquisition-cache>' '<new-acquisition-receipt.json>' --offline
node scripts/portable/stage-embedding-models.mjs scripts/portable/embedding-inputs.windows-x64.json '<acquisition-cache>' '<new-embedding-stage>'
```

Source-build output contains build/source metadata for audit. Assembly must select intended runtime/source payloads and exclude isolated build homes, caches, test databases and temporary acceptance artifacts. These component results do not establish final portable assembly, complete SBOM/licenses, relocation, maintenance acceptance or an independent clean-user run.

## Clean initial catalog

`node scripts/portable/seed-catalog.mjs <new-catalog.json>` constructs all nineteen default server definitions from checked-in declarations. It never reads personal `data/servers.json`, accounts, documents or environment settings. The destination must not exist. Filesystem, Desktop Commander, Typst, PDF Tools and DBHub retain the established initial startup selections; other entries require manual start, and on-demand startup is initially off. Git Local starts without assuming a preexisting user repository. GitHub and Brave still require account/key setup; their credential files are never generated or copied by this helper. Exa and Context7 retain their network requirements.

Three focused tests verify membership against the attribution inventory, absence of absolute host paths or account values, relocation through the real Portable initializer, preservation of existing saved selections, and agreement with the declared browser layout. The Playwright seed now selects Chromium revision 1246 explicitly. Complete toolbox startup and separate-user acceptance remain pending.

## npm group extraction

`stage-npm-groups.mjs <package-inputs.json> <runtime-stage> <existing-cache> <new-output> [--offline]` validates the captured manifest/lock hashes and every locked dependency's official registry URL and SHA-512 integrity. It uses staged Node/npm with a new build home, empty user/global npm configuration, and no inherited account environment. The three groups are General Local, Browser/Context7 and Brave Search. npm verifies archive integrity; lifecycle scripts, audit, funding queries and browser downloads are disabled. A second new output can use the verified cache in offline mode.

The helper refuses existing output, leaves an incomplete marker on failure and records installed package versions/integrities/license metadata on success. Platform-specific optional packages absent on Windows are omitted from that installed inventory. This metadata is not a complete license review or SBOM. Suppressed install steps can leave native helper assets unavailable, so extraction success must not be called a functioning MCP toolbox. Three contract tests pass. Actual online extraction and an offline replay in a second new Unicode/spaced directory also passed, with identical inventories: 566 General Local entries, 110 Browser/Context7 entries and 97 Brave entries. These are package entries per group, not a global unique-package count. Desktop Commander and Puppeteer lifecycle scripts were suppressed; their helper/browser requirements and MCP acceptance remain pending.

## Browser inputs and staged acceptance

`browser-inputs.windows-x64.json` pins full Chrome for Testing 154.0.8037.0 (Playwright Chromium revision 1246), FFmpeg revision 1011 and Winldd revision 1007. These exact official URLs were emitted by the captured Browser/Context7 group's Playwright core 1.64.0-alpha-1789764292000. SHA-256 digests were recorded from the acquired bytes; they are not independently publisher-signed checksums. Offline acquisition verification passed for all three archives, totaling 207,274,189 bytes.

```powershell
node scripts/portable/acquire-inputs.mjs scripts/portable/browser-inputs.windows-x64.json .harbor-build/browser-cache .harbor-build/browser-acquisition.json
python -B scripts/portable/stage-runtimes.py scripts/portable/browser-inputs.windows-x64.json scripts/portable/browser-layout.windows-x64.json .harbor-build/browser-cache ".harbor-build/Harbor browser candidate"
```

The runtime stager supports explicit `runtimes/browsers/<component>` targets and rejects overlapping parent/child targets in either order. Existing archive checks and bounds remain enforced. Ten extraction fixture tests passed. Actual extraction produced 309 files / 458,475,854 bytes in a new path with spaces and Unicode.

The seed's explicit full Chromium executable passed Playwright MCP navigation and a link click against a disposable local fixture, with an isolated profile and no global runtime entries in child PATH. The MCP returned 25 tools. Its current snapshot output is a file and `browser_click` takes `target`; acceptance follows the current schema. The staged browser reported 154.0.8037.0. Harbor's existing workload regression also passed all ten tests, including real rendered browser extraction, using this browser. The staged FFmpeg executable ran successfully, and the npm-distributed Windows ripgrep executable performed a real Unicode-file search without lifecycle scripts. No second headless-shell browser was acquired or required for those checks.

These are current-machine component checks, not complete toolbox or clean-user acceptance. Desktop Commander's current PDF helper independently looks for a private cached/system browser and can download one; declaring the Playwright executable does not yet wire that helper to the staged browser. That path still needs explicit integration and acceptance. Winldd has been extracted but not functionally qualified.

License review remains open: FFmpeg includes `COPYING.LGPLv2.1`, and its exact version/build flags were captured. Chromium's embedded credits were inspected and their visible text retained. Chromium and Winldd have no standalone notice file in these ZIPs; their declarations remain `NOASSERTION` until attribution/source obligations are resolved. Embedded credits inspection does not establish a complete transitive license inventory or redistribution clearance. All downloaded files remain in the separate build/evidence area; the installed Portable release was unchanged.

## Reviewed npm package patches

`apply-npm-patches.mjs` applies `npm-patches.windows-x64.json` to a staged package group after npm verifies the original registry archive. Each patch declares the exact package name/version, original file SHA-256, unique replacement anchor and expected output SHA-256. All selected inputs and outputs are validated before writes; unknown versions, source drift, path escapes and duplicate targets stop the stage. Reapplication accepts only the already-verified output hash. The npm staging receipt records each applied patch separately from original registry integrity.

The current Desktop Commander 0.2.51 patch honors the clean seed's `HARBOR_BUNDLED_CHROMIUM` path. A missing, relative or directory path fails before system-browser lookup or download. The same bundled Chromium used by Playwright passed actual Desktop Commander MCP `write_pdf` acceptance; independent PDF extraction verified the token and Unicode text in the one-page result. Three invalid-browser scenarios produced errors, no PDF and no private Puppeteer cache. This supersedes the earlier open browser-wiring issue. Global runtime PATH entries were excluded, accounts/profiles were isolated, and model instances were unloaded during acceptance.

A fresh offline stage reproduced all three npm groups and applied the patch successfully. Ten package/seed checks passed. Initial assembly and maintenance recipes include the patch helper/manifest and disable npm lifecycle scripts for these groups. Maintenance stops on an upstream version/hash change until its patch is reviewed; the installed component is not silently patched in place. Current-machine component acceptance does not establish a complete assembled release or an independent clean-user test.
## Clean application and toolbox assembly

`build-harbor-application.mjs` builds a fresh application from an allowlisted, hashed source snapshot. It uses pinned Node/npm, registry integrity in the application lockfile, disabled lifecycle scripts, and the verified Electron 44.3.0 stage. The isolated Windows build retains the system PowerShell directory, `ComSpec` and `PATHEXT`, which electron-builder needs to collect production dependencies. Publishing is explicitly disabled. A failed output is retained and a retry requires a new directory.

```powershell
node scripts/portable/build-harbor-application.mjs . <runtime-stage> <application-binary-stage> <npm-cache> <new-application-stage> --offline
node scripts/portable/assemble-portable.mjs <pinned-stage-plan.json> <new-portable-folder>
```

The assembly plan selects eleven completed stage receipts: runtime, browser, npm, shared Python, Python projects, source histories, Node projects, DBHub, embedding models, application binaries and Harbor application. Each entry binds a relative or absolute stage root, the expected receipt filename and its SHA-256. Source and output folders must not overlap. Assembly writes a clean nineteen-server catalog, launchers and maintenance recipes; it does not copy a live `data` folder or accounts. Nine source histories are retained for maintenance. The resulting `assembly.json` inventories all payload files. The npm group receipts predate full file inventories, so their file hashes are explicitly described as observations made during assembly.

A completed assembly is a build result. Complete dependency/license attribution, relocation, actual tools and native application acceptance remain separate requirements.

## Observed dependency inventory and SBOM

After assembly, `inventory-packages.py <portable-root> <new-package-inventory.json>` reads only assembly-listed npm and Python metadata, including the Python runtime's bundled pip and vendored distribution records. It verifies metadata and recognized notice bytes, rejects unsafe/duplicate paths and links, and records declared licenses without inferring grants from filenames. Python notices outside the distribution metadata folder are included only when the verified installed `RECORD` attributes them to that distribution and the assembly lists their bytes; traversal and unlisted paths are never followed. License and licence spellings and third-party notice filenames are recognized. This is observed attribution, not proof that all license obligations have been satisfied. `inventory-application.mjs <portable-root> <new-application-inventory.json>` verifies `app.asar` and reads its actual production npm metadata without executing the application. The latter uses the `@electron/asar` dependency from the pinned development install. Run the Python inventory contract checks with `python -B tests/portable-inventory.py`.

`build-sbom.py <portable-root> <pinned-plan.json> <package-inventory.json> <application-inventory.json> <schema-directory> <new-output.cdx.json>` combines these observations with the exact staged runtime, browser, source and model inputs. Run it with the staged Python interpreter and the staged FastMCP group's `python` directory on `PYTHONPATH`; that group supplies the pinned `jsonschema` and `referencing` packages. The schema directory must contain the official CycloneDX 1.6 `bom-1.6.schema.json`, `spdx.schema.json` and `jsf-0.82.schema.json`, acquired separately with recorded hashes. Validation uses those local schemas and performs no network retrieval.

An optional final `native-notice-inventory` argument merges observed native attribution components. Its assembly hash must match, and the generator records its file hash. Attribution entries can name code with no published dependency version, or optional/build-time code; do not infer that every credited component is active. Missing versions remain absent.

The generated CycloneDX document explicitly marks its composition **incomplete**. It preserves duplicate installation locations and distinguishes metadata hashes from archive hashes. It does not infer dependency edges, enumerate every native binary's embedded libraries, resolve missing or conflicting license grants, or claim corresponding-source obligations are satisfied. These limits remain release work; schema validity is not redistribution clearance. Runtime `data/` and user account files are never inventory inputs.
