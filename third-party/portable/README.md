# Portable third-party notices and provenance

These are convenience copies of primary license texts, notices, model cards, and provenance for Harbor's inspected Windows portable components. Original Harbor code has its own MIT license; these files retain their respective third-party licenses and original copyright notices.

`provenance-manifest.json` records each collected file's SHA-256 hash, original source URL or path relative to the portable installation, and exact source revision where established. It contains no absolute personal installation paths. `default-server-licenses.json` lists all 19 default server IDs individually and points to their included notices. Model-specific `provenance.json` files record the locally computed hashes and their comparison with the checked Hugging Face repository revision.

## What has been established

- Node.js 24.19.0, GitHub CLI 2.96.0, uv 0.12.12, and Pandoc 3.9 notices were obtained from official repositories at commits resolved from their corresponding version tags.
- Filesystem, Memory, and Sequential Thinking 2026.8.31 notices were recovered from the exact source commit identified by official npm registry metadata. Published package integrity matches the installed package lock for each package. Their original MIT/Apache licensing-transition text is retained without replacing it with an invented single license label.
- Every locally bundled default server's primary notice is included. Exa is a hosted endpoint; its related public connector notice is clearly labelled as a reference and service terms are linked separately.
- Complete AGPL-3.0 text accompanies PyMuPDF's installed dual-license declaration. This does not assert that a commercial license has been granted.
- All four installed embedding asset sets match the files at identified exact upstream repository commits through LFS SHA-256 or Git blob SHA-1. This identifies a matching revision; it does not establish the date or revision of the original download.
- The two MiniLM base-model cards identify Apache-2.0; the two BGE base-model cards identify MIT. Original model cards are retained. The `FlagEmbedding/` notice is from the license source linked by the BGE base-model cards. The standard Apache text is included as `models/APACHE-2.0.txt`.

## Remaining limits

This collection is not a complete transitive dependency inventory or certification that a complete portable binary redistribution meets every applicable requirement. Corresponding source and build/dependency correspondence for GPL, LGPL, AGPL, and other compiled components still need to be established for the precise binary payload to be distributed. Links to upstream repositories alone do not prove that requirement complete, especially for local modifications.

The converted `Xenova/all-MiniLM-L12-v2` and `Xenova/bge-small-en-v1.5` model cards do not contain explicit conversion-specific license declarations. Their asset revisions and base-model licenses are identified; the missing declarations are not silently invented. The main Playwright Chromium build's complete notice/build-source coverage remains separate from the included headless-shell and Electron notices.

No executables, native libraries, package archives, or model weights are included in this notice directory. Gathering these notices did not modify the live Harbor installation or publish the full portable toolbox.

## Rechecking integrity

Hash each `files[].path` listed in `provenance-manifest.json` with SHA-256 and compare it to `files[].sha256`. Paths are relative to this directory. The manifest does not hash itself. The collection script is kept in documentation working files rather than shipped in this notice directory.
