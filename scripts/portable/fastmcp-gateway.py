"""Harbor-owned FastMCP transforms over the existing shared tool gateway."""
import sys
import os
from fastmcp import FastMCP
from fastmcp.client.transports import StreamableHttpTransport
from fastmcp.server.providers.proxy import ProxyProvider, ProxyClient
from fastmcp.server.transforms.search import BM25SearchTransform, RegexSearchTransform

endpoint, mode = sys.argv[1:3]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 5
transforms = {
    "bm25": lambda: BM25SearchTransform(max_results=limit),
    "regex": lambda: RegexSearchTransform(max_results=limit),
}
if mode == "code":
    from fastmcp.experimental.transforms.code_mode import CodeMode, Search, GetSchemas
    transform = CodeMode(discovery_tools=[Search(default_limit=limit), GetSchemas()])
else:
    transform = transforms[mode]()
server = FastMCP("Harbor FastMCP", transforms=[transform])
# Catalog changes must immediately follow Harbor's enabled/running servers.
catalog_token = os.environ.pop("HARBOR_CATALOG_TOKEN", "")
headers = {"Authorization": "Bearer " + catalog_token} if catalog_token else {}
server.add_provider(ProxyProvider(lambda: ProxyClient(StreamableHttpTransport(endpoint, headers=headers), mode="legacy"), cache_ttl=0))
server.run(transport="stdio", show_banner=False)
