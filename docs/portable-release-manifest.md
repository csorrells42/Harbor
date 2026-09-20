# Portable release manifests — Phase 2 M1

The first M1 increment provides a versioned inventory and verification tool for explicitly selected Portable payloads. It records relative paths, sizes and SHA-256 values, component versions when known, the declared Harbor source revision, and unresolved acquisition inputs.

This is available as a development command. It does not install, update, start or stop Harbor. It does not yet recreate the complete toolbox on a clean machine.

## Capture and verify

Use Node.js 24 or the distribution's bundled Node executable. No additional npm dependencies or network access are required by this helper.

Create a JSON plan for the exact prepared payload being reviewed. For example, this plan selects a staged initial application and its launch support:

```json
{
  "schemaVersion": 1,
  "release": "0.2.0-m1-candidate",
  "source": {
    "repository": "https://github.com/csorrells42/Harbor",
    "revision": "51b37183c41a6dead4333385c189b9f764406a49"
  },
  "components": [
    {
      "id": "desktop",
      "role": "application",
      "version": "0.2.0",
      "acquisition": null,
      "paths": ["application/initial"]
    },
    {
      "id": "support",
      "role": "support",
      "version": null,
      "acquisition": null,
      "paths": ["support", "Start Harbor.cmd", "Start Harbor.vbs"]
    }
  ]
}
```

Replace the revision with the actual full 40-character Git revision for a changed build. For an activated installation, read `application/current.json` locally and select that release directory instead of `application/initial`. Source identity is a declaration; this tool does not establish that a binary was built from that revision. Bind it to the build and acceptance evidence separately.

```powershell
node scripts/portable/release-manifest.mjs capture "D:\Prepared Harbor" .\plan.json .\release-manifest.json
node scripts/portable/release-manifest.mjs verify "D:\Prepared Harbor" .\release-manifest.json
node scripts/portable/release-manifest.mjs verify "E:\Relocated ü Harbor" .\release-manifest.json
```

Capture refuses to overwrite an existing report. Store reports outside the inspected payload. Verification exits with code 0 for a match and code 1 for differences, missing inputs, malformed metadata or unreadable files. A mismatch reports up to 50 changed/missing/unexpected relative paths and the total difference count. A missing selected root is a filesystem error and also fails verification.

## Contract and interpretation

- Version 1 plans accept application, runtime, server, browser, model, support and license components. Each has an explicit version or `null`, one or more non-overlapping file/directory paths, and acquisition metadata or `null`.
- Directory selections include all descendants and empty directories. Unexpected additions inside a selection fail verification. Unselected paths are outside the report's coverage; a match does not certify an entire folder.
- Files are streamed through SHA-256. Each file is checked for size/identity/timestamp changes during capture; each directory is checked for membership changes. Use a stable staging directory with no concurrent writer. This is not an atomic filesystem snapshot or a defense against a hostile concurrent writer.
- Paths use `/` and remain relative to the payload. Traversal, Windows alternate data streams/device names, overlapping selections, case collisions, symlinks and junctions are rejected. Link-based package stores need a deliberately materialized release payload.
- Live `data/`, catalog/maintenance configuration, Git metadata and conventional credential filenames are outside the allowed inputs. Capture fails on forbidden descendants instead of silently omitting them. Arbitrary secrets in ordinary filenames cannot be detected; review input payloads before distribution. This tool hashes content and does not copy it into the report.
- Metadata is allowlisted. Profile environments and arbitrary recipe fields are never copied. Archive/source URLs must be HTTPS without embedded credentials, query parameters or fragments; do not put credentials in URL paths.
- `acquisition: null` is listed under `unresolvedAcquisitions`. An optional archive descriptor has `type: "archive"`, a public `url`, and the archive's 64-character lowercase `sha256`. This records a declared input; capture does not download it, verify its origin, or claim it produced the observed files.
- `manifestSha256` covers compact `JSON.stringify` output of the generated manifest excluding that checksum field. Whitespace in the report may change; preserve object-key order. This is an integrity check, not a signature or an authenticity guarantee. Keep the trusted manifest/checksum separate from an untrusted payload.
- Ordered paths and stable metadata produce the same manifest for unchanged selected bytes across folder relocation. This does not imply that rebuilding Electron or upstream packages produces byte-identical output.

## Baseline and remaining M1 work

The September 19 baseline was captured locally from application release `1789743583421`, bound to source `51b37183c41a6dead4333385c189b9f764406a49`. Its application ASAR SHA-256 matched the prior accepted release. The selected inventory includes the complete current application directory, support/launch files, notices, six runtime entrypoint binaries and dependency metadata for all 16 maintenance components: **25 component groups, 280 files, 663,095,132 bytes**. A fresh verification matched the captured inventory.

That selection omits full server dependency trees, complete runtime installations, browsers, embedding weights and live profile configuration. All 25 acquisition descriptors remain unresolved. The prior application/security/GUI acceptance report remains historical evidence; this read-only capture does not rerun those checks. The baseline therefore starts M1 and does not complete its clean-machine acceptance gate.

Next increments must declare and acquire pinned runtimes, server inputs, local patches, browser/model assets and licenses; build a clean seed catalog; assemble a distribution without personal state; generate the complete dependency/license inventory and SBOM; and exercise independent clean build/runtime environments. Original account-dependent capabilities remain explicitly account-dependent.

Run the focused contract tests with:

```powershell
node --test tests/release-manifest.test.mjs
```
