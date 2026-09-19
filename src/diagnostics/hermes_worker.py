"""Version-gated installed Hermes adapter. Never imports Hermes during a probe.

The real agent executes in a fresh HERMES_HOME; the user's configuration and
managed model endpoint state are read only. No credentials go to the IPC stream.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import urlsplit

import psutil
import yaml

REVISION = '1675f1f2c25ce164f07c42e829f2c17a723db94f'
OUT = sys.stdout
LOCK = threading.Lock()


class AdapterError(Exception):
    pass


def emit(kind, **values):
    with LOCK:
        OUT.write(json.dumps({'type': kind, **values}, ensure_ascii=True) + '\n')
        OUT.flush()


def gpu_snapshot():
    try:
        p = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,memory.used', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if p.returncode:
            return None
        return [{'name': a.strip(), 'totalMiB': float(b), 'usedMiB': float(c)} for a, b, c in (line.rsplit(',', 2) for line in p.stdout.strip().splitlines())]
    except Exception:
        return None


def source_details(source):
    config = yaml.safe_load((source / 'config.yaml').read_text(encoding='utf-8-sig'))
    model = config.get('model', {})
    if model.get('provider') not in ('llamacpp', 'llama.cpp', 'llama-cpp'):
        raise AdapterError('This adapter currently supports Hermes with its configured local llama.cpp model only.')
    state = json.loads((source / 'runtimes/llamacpp/server.json').read_text(encoding='utf-8'))
    if not psutil.pid_exists(int(state.get('pid', 0))):
        raise AdapterError('The configured model server is not running. Start it in Hermes first.')
    endpoint = state.get('base_url', '').rstrip('/')
    url = urlsplit(endpoint)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1') or url.username or url.password or url.query or url.fragment:
        raise AdapterError('Expected a loopback model endpoint without embedded credentials.')
    return config, state, endpoint


def inventory(source):
    config, state, endpoint = source_details(source)
    repo = source / 'hermes-agent'
    revision = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).strip()
    if revision != REVISION:
        raise AdapterError('Installed Hermes revision changed; adapter compatibility needs revalidation.')
    critical = ['run_agent.py', 'agent/agent_init.py', 'agent/conversation_loop.py', 'agent/tool_executor.py', 'tools/mcp_tool_discovery.py', 'tools/mcp_tool_registration.py']
    fingerprint = hashlib.sha256(b''.join((repo / p).read_bytes() for p in critical)).hexdigest()
    request = urllib.request.Request(endpoint + '/models', headers={'Authorization': 'Bearer ' + state.get('api_key', '')})
    with urllib.request.urlopen(request, timeout=8) as response:
        models = json.load(response)
    ids = [m.get('id') for m in models.get('data', [])]
    selected = config['model'].get('default')
    if selected not in ids:
        raise AdapterError('The configured model is not advertised by the running local endpoint.')
    return {'harness': 'Hermes', 'revision': revision, 'fingerprint': fingerprint, 'model': selected, 'provider': 'llamacpp', 'reasoning': config.get('agent', {}).get('reasoning_effort', 'high'), 'endpoint': endpoint, 'modelServerPid': state['pid'], 'modelIdentity': 'configured ID confirmed in endpoint catalog; weights not fingerprinted', 'hardware': {'cpu': platform.processor(), 'logicalCpus': psutil.cpu_count(), 'ramBytes': psutil.virtual_memory().total, 'gpus': gpu_snapshot()}, 'isolation': 'fresh Hermes home; only diagnostic MCP tools; existing shared model server', 'ready': True}


def run(request, source):
    details = inventory(source)
    config, endpoint_state, endpoint = source_details(source)
    home = Path(request['home']).resolve()
    if home == source or source in home.parents:
        raise AdapterError('Diagnostic home must be outside the existing Hermes installation.')
    home.mkdir(parents=True, exist_ok=False)
    os.environ['HERMES_HOME'] = str(home)
    os.environ['HERMES_DISABLE_AUTO_UPDATE'] = '1'
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    os.chdir(home)
    # Explicit model/provider prevents auto-provider selection or managed-server boot.
    isolated = {'model': {'default': details['model'], 'provider': 'custom', 'base_url': endpoint}, 'local_runtime': {'enabled': False}, 'agent': {'max_turns': request['maxTurns'], 'reasoning_effort': details['reasoning']}, 'memory': {'memory_enabled': False, 'user_profile_enabled': False}, 'telemetry': {'enabled': False}, 'updates': {'auto_update': False}, 'mcp_servers': {'diagnostic': {'url': request['gateway'], 'transport': 'http'}}, 'terminal': {'cwd': str(home)}, 'skills': {'auto_load': False}}
    isolated['tools'] = {'tool_search': {'enabled': 'off'}}
    configured_context = config.get('model', {}).get('context_length')
    if isinstance(configured_context, int) and configured_context > 0:
        isolated['model']['context_length'] = configured_context
    (home / 'config.yaml').write_text(yaml.safe_dump(isolated), encoding='utf-8')
    sys.path.insert(0, str(source / 'hermes-agent'))
    stop = threading.Event()
    started = time.monotonic()

    def monitor():
        proc = psutil.Process()
        while not stop.is_set():
            ram = psutil.virtual_memory()
            emit('resources', ms=(time.monotonic() - started) * 1000, hostUsedGiB=(ram.total - ram.available) / 2**30, hostCpuPercent=psutil.cpu_percent(), workerRssBytes=proc.memory_info().rss, gpus=gpu_snapshot())
            stop.wait(2)

    threading.Thread(target=monitor, daemon=True).start()
    try:
        # Library console output is deliberately not captured: it may include provider metadata.
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            from tools.mcp_tool import discover_mcp_tools, shutdown_mcp_servers
            names = discover_mcp_tools(allowed_mcp_names=['diagnostic'])
            if not names:
                raise AdapterError('Hermes could not discover the diagnostic MCP tools.')
            from run_agent import AIAgent
            def tool_start(cid, name, args):
                import jsonschema
                valid = False
                schema = next((t['function']['parameters'] for t in agent.tools if t['function']['name'] == name), None)
                if schema is not None:
                    try:
                        jsonschema.validate(args, schema)
                        valid = True
                    except jsonschema.ValidationError:
                        pass
                emit('tool-start', callId=cid, name=name, schemaValid=valid, ms=(time.monotonic()-started)*1000)

            agent = AIAgent(model=details['model'], provider='custom', base_url=endpoint, api_key=endpoint_state.get('api_key') or 'local', max_iterations=request['maxTurns'], max_tokens=2048, enabled_toolsets=['mcp-diagnostic'], quiet_mode=True, skip_context_files=True, load_soul_identity=False, skip_memory=True, skip_background_review=True, checkpoints_enabled=False, save_trajectories=False, reasoning_config={'enabled': True, 'effort': details['reasoning']}, fallback_model=None, run_budget_seconds=request['maxTrialSeconds'], tool_start_callback=tool_start, tool_complete_callback=lambda cid, name, args, result: emit('tool-end', callId=cid, name=name, ms=(time.monotonic()-started)*1000))
            unexpected = [n for n in agent.valid_tool_names if not n.startswith('mcp__diagnostic__')]
            if unexpected:
                raise AdapterError('Hermes enabled tools outside the diagnostic server; trial stopped: ' + ', '.join(sorted(unexpected)))
            emit('ready', inventory=details, advertisedTools=sorted(agent.valid_tool_names), startupMs=(time.monotonic()-started)*1000, controls={'hermesToolSearch': 'off', 'memory': 'off', 'contextFiles': 'off', 'toolsets': ['mcp-diagnostic'], 'maxOutputTokens': 2048, 'maxTurns': request['maxTurns']})
            result = agent.run_conversation(request['prompt'])
            emit('result', finalResponse=result.get('final_response') or '', harnessCompleted=result.get('completed'), failed=result.get('failed', False), interrupted=result.get('interrupted', False), apiCalls=result.get('api_calls'), modelReported=agent.model, usage=None, cost=None)
            agent.close()
            shutdown_mcp_servers()
    finally:
        stop.set()


def main():
    request = json.load(sys.stdin)
    source = Path(request['source']).resolve()
    try:
        if request['op'] == 'probe':
            emit('inventory', **inventory(source))
        else:
            run(request, source)
    except Exception as error:
        # Do not return arbitrary exception text, URLs with tokens, or tracebacks.
        safe = str(error) if isinstance(error, AdapterError) else 'Local adapter operation failed (' + type(error).__name__ + ').'
        emit('error', message=safe)
        sys.exit(1)


if __name__ == '__main__':
    main()
