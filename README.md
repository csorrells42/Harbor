# Harbor

![Harbor — Local tools. One gateway. Your configuration.](docs/images/harbor-banner.png)

**A desktop control center and shared MCP gateway for local AI tools.**

Created by **Christopher Sorrells (csorrells42)**. Contact: **[clsorrells42@gmail.com](mailto:clsorrells42@gmail.com)**. Open to software engineering opportunities and project enquiries.

Harbor runs tool servers once and connects them to multiple compatible AI clients. Its desktop interface manages server lifecycles, startup selections, API-key authentication, connection settings, tool discovery modes and portable maintenance. Diagnostics provides controlled Hermes harness tests, hardware gauges and temperature history.

## Complete documentation

- **[Read the full operating manual](docs/HARBOR-MANUAL.md)** — installation, quickstart, every tab, configuration, endpoints, connection examples, tool delivery, Diagnostics, maintenance, component repositories, source builds, troubleshooting and licensing.
- **[Download the PDF manual](HARBOR-MANUAL.pdf)** — the same detailed manual, formatted for offline reading with a clickable contents page and bookmarks.
- **[Licenses for all 19 default servers](docs/DEFAULT-SERVER-LICENSES.md)** — primary licenses, upstream links and included full notices.
- **[Licensing and third-party scope](LICENSING.md)** — original Harbor is MIT; bundled upstream components retain their own terms.
- **[Production dependency inventory](docs/DEPENDENCIES.json)** and **[full dependency notices](THIRD-PARTY-NOTICES.txt)**.

The Markdown manual is the source for the PDF. Keep both with distributed application builds.

## Quickstart with Harbor Portable

1. Extract the complete Windows x64 Portable bundle into a user-writable folder.
2. Run **Start Harbor.vbs**; use **Start Harbor.cmd** from a command prompt.
3. Open **This Server** and verify the current endpoint. The default is `http://127.0.0.1:37373/mcp`.
4. Start the required child servers, or use **Advisor** and **Start selected**. Advisor checkboxes save automatic startup preferences immediately.
5. In **This Server**, review **Use API key** and **Loopback only** together. Both ship enabled and can be disabled independently; a fresh desktop profile generates and saves its key. To change the key, enter or generate a draft, then **Apply protections**. Retain an existing saved key unless you intend to rotate it. Copy the client configuration from **Connections** and reconnect the client. The clipboard configuration includes the saved key when authentication is enabled.
6. Verify a narrow tool operation against files or a project you intend the client to access.

Closing the window hides Harbor. **Quit and stop servers** in the tray menu exits and stops Harbor-owned processes.

Common Streamable HTTP configuration:

```json
{
  "mcpServers": {
    "harbor": {
      "url": "http://127.0.0.1:37373/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_HARBOR_API_KEY>"
      }
    }
  }
}
```

Replace the placeholder with the saved Harbor key, or copy the populated configuration locally from the app. LM Studio supports `headers.Authorization` in `mcp.json`. Client formats vary; some need an explicit HTTP transport field. The app generates a stdio bridge configuration using `HARBOR_API_KEY` for clients without native Streamable HTTP support; the bridge also accepts `HARBOR_API_KEY_FILE` containing plain key text. Follow the [connection reference](docs/HARBOR-MANUAL.md#5-connections-and-endpoints) for local, browser and network clients.

## Build the application from source

The repository uses one branch, **master**. Use Node.js 24 and npm for the tested development baseline:

```powershell
git clone --branch master --single-branch https://github.com/csorrells42/Harbor.git
Set-Location Harbor
npm ci
npm start
```

The source app does not install the complete Portable toolbox. Configure your own MCP servers, or use an existing complete Portable distribution. The maintained source helpers document the component recipes; they are not a clean-machine one-command installer for all bundled tools.

```powershell
npx --no-install playwright install chromium
npm test
npm run test:ui
npm run pack -- --win
npm run dist:win
```

The Windows renderer tests require Microsoft Edge. On Linux, provide the required desktop libraries and a graphical session; `npx --no-install playwright install --with-deps chromium` prepares the test browser. Linux packaging is available through `npm run dist:linux`, but target-specific validation is required. Windows artifacts are unsigned.

## Tool delivery and Diagnostics

Choose **All tools**, **BM25**, **Regex**, **Code Mode**, local semantic discovery, supported hosted embedding providers, or **Hybrid** in the Tool Delivery tab. Reconnect clients after changes. Source-only installations need a compatible Portable worker runtime for discovery methods other than All tools; see the manual. Search affects discovery, not authorization: the full catalog remains reachable by the gateway's routing machinery.

Diagnostics runs a synthetic task suite against a supported installed Hermes/local-model pairing. It grades verified completion, task acceptance, tool/argument correctness, instruction adherence, false success claims and elapsed time. Results have four comparison views: Harbor configurations, models, harnesses and complete combinations. One campaign with one installed pairing does not establish a best model or harness.

The system panel displays live CPU/GPU/RAM/VRAM gauges and 5/10/30/60-minute temperature charts for accessible sensors. History samples every 10 seconds after the first Diagnostics visit, continues across tabs, and resets when Harbor exits.

## Maintenance

Complete or cancel any Diagnostics campaign first. In a complete Portable installation, open **Maintenance**, choose **Enter maintenance mode**, update/rebuild one component, inspect its result, then **Resume servers**. The configured policy retains the current build only and does not provide rollback copies. Application updates activate through the Portable launcher. Preserve local data and account configuration; never replace files under a running update.

## Accounts, access and boundaries

- **Source-security gate: pending until the dedicated scanner works.** Functional tests and builds do not constitute security clearance. No substitute manual source-security audit is claimed.
- The intentionally deferred Brave API key affects live Brave searches, not the core application. The manual includes the later setup steps.
- GitHub and optional hosted providers require their own local sign-in or credentials; none are included in this repository.
- The gateway proxies MCP **tools**. Upstream prompts, resources, sampling, roots and elicitation are not proxied.
- Child-server mutable state is shared across clients. Use separate server configurations and storage for separate projects where supported.
- **Gateway access** uses `Authorization: Bearer <key>` when enabled. Enter/generate/apply/copy controls are in This Server. Generating a draft does not save it; rotating/enabling/disabling authentication disconnects client sessions, so reconnect using the current configuration. Child-server processes are preserved.
- A fresh desktop profile starts with **Use API key** and **Loopback only** enabled and a generated key. Either protection, or both, can be disabled; saved disabled choices persist. Network access does not force API-key protection back on. Keys are stored separately in `data/auth/gateway.json` as local plaintext, excluded from general snapshots and preview JSON. Copy configuration/key actions deliberately put the credential on the clipboard.
- Loopback is the default. **HTTP transport is not encrypted**, even with an API key. Keep network mode within a network boundary you control. Host/Origin checks complement authentication; a shared key does not create per-client permissions or isolate upstream state.
- Server processes run with their operating-system account's permissions. Configuration and logs may contain sensitive values; keep live `data/` and credentials out of public uploads.

## Build the manual

The checked-in PDF is ready to read. To regenerate it from Markdown:

```powershell
python -m pip install -r scripts/requirements-manual.txt
python scripts/build-manual.py
```

The generator reads `docs/HARBOR-MANUAL.md` and `docs/manual-release.json`, writes `HARBOR-MANUAL.pdf`, and performs no network requests. Update release evidence and dependency notices when the corresponding code or dependencies change.

## License and credit

Harbor's original code and documentation use the **[MIT License](LICENSE)**, copyright **2026 Christopher Sorrells (csorrells42) <clsorrells42@gmail.com>**, with the existing contributors notice retained. Keep the copyright and license notice when redistributing copies or substantial portions. A public credit/link is appreciated, although MIT does not require a promotional attribution screen.

Third-party runtimes, servers, dependencies and model weights are separately licensed. The MIT notice does not turn the complete Portable toolbox into an MIT-only distribution. See [LICENSING.md](LICENSING.md) before redistributing binaries.
