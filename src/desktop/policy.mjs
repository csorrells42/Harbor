export function connectionInfo({endpoint, endpoints, settings, settingsPath, configPath, bridgePath, platform, nodePath='node', portableRoot, authentication={enabled:false,hasKey:false}, version='0.2.0'}) {
  const key=authentication.enabled?'<YOUR_HARBOR_API_KEY>':undefined;
  return structuredClone({authentication:{enabled:!!authentication.enabled,hasKey:!!authentication.hasKey},endpoint, configPath, settingsPath, platform, version, serverName:'mcp-harbor',
    networkEndpoints:endpoints?.network ?? [], bindAddress:endpoints?.bindAddress ?? '127.0.0.1', settings,
    httpConfig:{mcpServers:{harbor:{url:endpoint,...(key?{headers:{Authorization:'Bearer '+key}}:{})}}},
    portableRoot, stdioConfig:{mcpServers:{harbor:{command:nodePath,args:[bridgePath,endpoint],...(key?{env:{HARBOR_API_KEY:key}}:{})}}}
  });
}
