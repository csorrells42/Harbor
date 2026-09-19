# Licensing and attribution

## Original Harbor work

Original Harbor source and documentation use MIT. The complete terms are in [LICENSE](LICENSE):

**Copyright (c) 2026 Christopher Sorrells (csorrells42) <clsorrells42@gmail.com>**

The existing **MCP Harbor contributors** notice is retained. MIT requires preservation of its copyright and permission notice in copies or substantial portions; it does not require a prominent attribution screen or endorsement. The project/contact link is welcome: [Harbor](https://github.com/csorrells42/Harbor), [clsorrells42@gmail.com](mailto:clsorrells42@gmail.com).

The icon files match the project's own `scripts/make-icon.py` generator. Other upstream works retain their original attribution; do not substitute the Harbor copyright for theirs.

## Application dependencies and Electron

[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) preserves complete license texts for the audited production npm dependency graph. [docs/DEPENDENCIES.json](docs/DEPENDENCIES.json) records exact versions, declarations, upstream locations and the audited lockfile hash. At the documented snapshot there are 94 installed package instances / 92 unique package-version pairs: MIT, ISC, BSD-2-Clause and BSD-3-Clause. This inventory is not a substitute for checking a changed lockfile.

Electron is a shipped runtime even though it is installed as a development dependency. Keep its `LICENSE` (packaged as `LICENSE.electron.txt`) and `LICENSES.chromium.html` beside the executable when distributing its binaries. [third-party/Electron-LICENSE.txt](third-party/Electron-LICENSE.txt) copies its own MIT notice. Chromium and its embedded components have additional notices retained in Electron's shipped HTML file. Build tools installed by developers have their own licenses.

## Licenses for the default servers

The [19-server license catalogue](third-party/portable/default-server-licenses.json) lists every default server separately, with its inspected package version, primary license, included notice path, source links, and qualifications. It covers Serena, Context7, Playwright, GitHub, Filesystem, Memory, Sequential Thinking, Desktop Commander, Fetch, Git Local, Exa, Brave Search, Typst PDF Creator, PDF Tools, DuckDB, MarkItDown, Excel, Word Documents, and DBHub.

The [Portable notice collection](third-party/portable/README.md) includes their primary notices and additional runtime/model material. Its [provenance manifest](third-party/portable/provenance-manifest.json) records source URLs or paths relative to the Portable folder, exact source revisions where established, and SHA-256 hashes for 66 notice/index files. The original copyright and license texts are retained.

Three distinctions matter when using the catalogue:

- Filesystem, Memory, and Sequential Thinking 2026.8.31 refer to the upstream licensing-transition text: Apache-2.0 with retained MIT contributions. Their notice source was identified from exact npm registry gitHead metadata and matching package-lock integrity; they are not labelled MIT-only.
- Serena 2.0.0.dev0 identifies its application as GPL-3.0-or-later and SolidLSP separately as MIT. PDF Tools is MIT at the server-project level, while its PyMuPDF and Pandoc dependencies have different licenses.
- Exa is a hosted endpoint in Harbor. The included MIT notice from its related open-source connector is a reference; it does not identify the hosted service's deployed revision or replace [Exa's service terms](https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf).

## Complete Portable toolbox redistribution

The source repository does not include the personal Portable data directory, tool runtime binaries, hosted account credentials or model weights. The separately assembled toolbox includes additional licenses and distribution obligations. Notable examples include GPL Serena/Git/Pandoc components, LGPL components/codecs, AGPL-or-commercial PyMuPDF, MPL libraries and individually licensed embedding models. These programs are not relicensed under Harbor's MIT grant.

Preserve full license and NOTICE text, identify each exact artifact/version and its source, and satisfy corresponding-source and other applicable conditions before publishing a full Portable archive. This includes local modifications and binary dependencies, not merely top-level Python/npm wrapper licenses. A URL by itself is not assumed to meet every GPL/AGPL source-delivery requirement. A commercial alternative requires a valid entitlement, not an assumption.

The initial audit found incomplete primary notices and provenance in the private toolbox. The documentation package now includes notices from version-pinned official Node.js, GitHub CLI, uv and Pandoc sources; recovered exact-source MCP npm licenses; locally verified default-server notices; and complete AGPL text accompanying PyMuPDF's installed dual-license declaration. All four installed embedding asset sets were matched by file hashes to identified upstream repository commits, and their converted/base model cards were preserved.

This does **not** establish every requirement for public distribution of the entire preassembled toolbox. Corresponding source and build/dependency correspondence remain to be established for the precise compiled/copyleft payload and local modifications. The main Playwright Chromium build's complete notice/source coverage is not proved by the included headless-shell or Electron notices. Two converted-model cards omit explicit license declarations; their exact asset revisions and base-model licenses are documented without inventing a missing conversion-specific grant. A complete transitive dependency inventory is also outside this primary-notice collection.

The current publication is Harbor source and documentation, including these notices. It does not publish a complete Portable binary archive. Any later application-only installer must retain its actual Electron/Chromium and production-dependency notices; a full-toolbox release requires the additional artifact-specific work described above.

Primary license references: [MIT](https://opensource.org/license/mit), [GNU GPL](https://www.gnu.org/licenses/gpl-3.0.html), [GNU AGPL](https://www.gnu.org/licenses/agpl-3.0.html), [GNU LGPL](https://www.gnu.org/licenses/lgpl-3.0.html), [Mozilla Public License](https://www.mozilla.org/en-US/MPL/2.0/).
