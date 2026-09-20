"""Version-gated installed Hermes adapter. Never imports Hermes during a probe.

The real agent executes in a fresh HERMES_HOME; the user's configuration and
managed model endpoint state are read only. No credentials go to the IPC stream.
"""
import contextlib
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import struct
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import urlsplit, urlencode

import psutil
import yaml

REVISION = '1675f1f2c25ce164f07c42e829f2c17a723db94f'
OUT = sys.stdout
LOCK = threading.Lock()
# Only reused inside this short-lived worker after file identity/stat checks.
# A fresh probe/trial worker hashes bytes again; no trusted persistent cache.
DIGESTS = {}
RUNTIME_BUILDS = {}


class AdapterError(Exception):
    pass


def stable_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def final_response_prompt(prompt, response_format=None):
    """Clarify an explicit output contract without rewriting any model answer."""
    if response_format is None:
        return prompt
    if response_format != 'json-object':
        raise AdapterError('Unsupported final response format.')
    return prompt + ('\n\nFinal response contract (harbor-final-json-1): '
                     'Your final answer must be exactly one valid JSON object with the fields requested above. '
                     'Return raw JSON only: no Markdown code fences, headings, commentary, or text before or after the object. '
                     'Continue using the supplied tools normally while doing the work. '
                     'This format requirement does not replace completing or verifying the requested work.')


def pin_local_sampling(client, reasoning_effort=None):
    """Retain configured controls on Hermes's direct forced-final requests too."""
    resource = client.chat.completions
    if not getattr(resource, '_harbor_sampling_pinned', False):
        create = resource.create
        def controlled_create(*args, **kwargs):
            for key, value in [('temperature', 0.2), ('top_p', 0.95), ('seed', 18431)]:
                kwargs.setdefault(key, value)
            if reasoning_effort is not None:
                kwargs.setdefault('reasoning_effort', reasoning_effort)
            return create(*args, **kwargs)
        resource.create = controlled_create
        resource._harbor_sampling_pinned = True
    return client


def bind_lmstudio_reasoning(agent, details):
    """Bind canonical native capabilities to our uniquely owned instance alias.

    This Hermes revision only looks up model key/id, not loaded_instances[].id.
    Keep the unique inference ID and never invoke model loading to resolve it.
    """
    options = details['modelEvidence']['loadedModel'].get('reasoningOptions', [])
    normalized = {'off': 'none', 'on': 'medium'}
    desired = normalized.get(details['reasoning'], details['reasoning'])
    if options and desired not in {normalized.get(value, value) for value in options}:
        selection = details['modelEvidence'].get('reasoningSelection', {})
        if selection.get('policy') != 'configured-hermes-default-fallback' or selection.get('requested') != details['reasoning']:
            raise AdapterError('The selected reasoning effort is not supported by this loaded model.')
        # Match this gated Hermes revision: unsupported configured effort omits
        # the request field, leaving the server's declared default in control.
        # Explicit benchmark requests still fail instead of changing controls.
        desired = None
    if not callable(getattr(agent, '_lmstudio_reasoning_options_cached', None)):
        raise AdapterError('Hermes LM Studio capability hook changed; adapter needs revalidation.')
    agent._lmstudio_reasoning_options_cached = lambda: list(options)
    return desired if options else None


def reasoning_config(effort):
    return {'enabled': effort not in ('off', 'none'), 'effort': 'none' if effort == 'off' else effort}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise ValueError('Model evidence redirects are unsupported')


def local_json(request):
    # Credentials are only sent to the configured loopback endpoint. Ignore
    # ambient HTTP proxy settings and never follow a redirect elsewhere.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=8) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError('Model properties exceed limit')
    return json.loads(raw)


def gguf_metadata(file):
    """Read bounded GGUF metadata without loading tensor data or importing Hermes."""
    limit = min(file.stat().st_size, 64 * 1024 * 1024)
    with file.open('rb') as stream:
        def read(n):
            if n < 0 or stream.tell() + n > limit:
                raise ValueError('GGUF metadata exceeds limit')
            value = stream.read(n)
            if len(value) != n:
                raise ValueError('Incomplete GGUF metadata')
            return value

        def number(fmt):
            return struct.unpack('<' + fmt, read(struct.calcsize(fmt)))[0]

        def string(keep=False):
            size = number('Q')
            if keep and size > 16384:
                raise ValueError('GGUF label exceeds limit')
            if stream.tell() + size > limit:
                raise ValueError('GGUF metadata exceeds limit')
            if keep:
                return read(size).decode('utf-8')
            stream.seek(size, 1)

        formats = {0: 'B', 1: 'b', 2: 'H', 3: 'h', 4: 'I', 5: 'i', 6: 'f', 7: '?', 10: 'Q', 11: 'q', 12: 'd'}

        def value(kind, keep=False):
            if kind in formats:
                return number(formats[kind])
            if kind == 8:
                return string(keep)
            if kind == 9:
                subtype, count = number('I'), number('Q')
                if subtype == 9 or count > 1000000:
                    raise ValueError('Unsupported GGUF array')
                for _ in range(count):
                    value(subtype)
                return None
            raise ValueError('Unknown GGUF value type')

        if read(4) != b'GGUF' or number('I') not in (2, 3):
            raise ValueError('Expected supported GGUF weights')
        number('Q')  # tensor count; only metadata is needed here
        count = number('Q')
        if count > 100000:
            raise ValueError('GGUF metadata count exceeds limit')
        result, seen = {}, set()
        for _ in range(count):
            key = string(True)
            if key in seen:
                raise ValueError('Duplicate GGUF metadata')
            seen.add(key)
            keep = key in ('general.file_type', 'general.architecture', 'split.count', 'split.no')
            item = value(number('I'), keep)
            if keep:
                result[key] = item
        return result


def file_identity(file):
    info = file.stat()
    if not file.is_file():
        raise ValueError('Expected regular model file')
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def digest_file(file, started_at, gguf=False):
    file = file.resolve(strict=True)
    before = file_identity(file)
    if max(before[3], before[4]) > int(started_at * 1000000000):
        raise ValueError('Model/runtime file changed after its process started')
    cache_key = (str(file), before, started_at, gguf)
    if cache_key not in DIGESTS:
        metadata = gguf_metadata(file) if gguf else None
        digest = hashlib.sha256()
        with file.open('rb') as stream:
            if file_identity(file) != before:
                raise ValueError('File changed before hashing')
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
        if file_identity(file) != before:
            raise ValueError('File changed during hashing')
        DIGESTS[cache_key] = {'sha256': digest.hexdigest(), 'bytes': before[2], 'gguf': metadata}
    return DIGESTS[cache_key]


def option_values(args, names):
    values = []
    for index, arg in enumerate(args):
        key, separator, inline = arg.partition('=')
        if key in names:
            if separator:
                values.append(inline)
            elif index + 1 < len(args):
                values.append(args[index + 1])
            else:
                raise ValueError('Missing model argument')
    return values


def sanitized_arguments(args):
    values, skip = [], False
    secret_flags = {'--api-key', '--api-key-file', '--hf-token', '--ssl-key-file', '--ssl-cert-file'}
    for arg in args[1:]:
        if skip:
            skip = False
            continue
        key, separator, _ = arg.partition('=')
        if key in secret_flags:
            values.append(key)
            skip = not separator
        else:
            values.append(arg)
    return values


def model_evidence(endpoint, state, selected, server_identity):
    unknown = {'weightsFingerprint': None, 'contextLength': None, 'serverSettingsFingerprint': None,
               'verification': 'unverified', 'gaps': []}
    if server_identity.get('endpointOwned') is not True or server_identity.get('runtimeKind') != 'llama.cpp':
        unknown['gaps'].append('Configured endpoint is not owned by a verified llama-server process')
        return unknown
    stage = 'The installed llama.cpp runtime needs version or file-lifetime revalidation'
    try:
        parent = psutil.Process(int(state['pid']))
        executable = Path(parent.exe())
        if any(max(file_identity(file)[3:]) > int(parent.create_time() * 1000000000) for file in [executable, *executable.parent.glob('*.dll')]):
            raise ValueError('Runtime bundle changed since the endpoint started')
        version_key = (str(executable), file_identity(executable))
        if version_key not in RUNTIME_BUILDS:
            version = subprocess.run([str(executable), '--version'], capture_output=True, text=True, timeout=8, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if version.returncode or not re.search(r'build 10679, commit 50f068fff', version.stdout + version.stderr):
                raise ValueError('llama.cpp build requires adapter revalidation')
            RUNTIME_BUILDS[version_key] = 'b10679-50f068fff'
        # Router GETs can autoload models unless explicitly disabled. Never
        # activate, switch, download or modify a model as part of an identity probe.
        stage = 'Live model properties are unavailable or incomplete; start the selected model in Hermes and check again'
        root = endpoint.removesuffix('/v1')
        query = urlencode({'model': selected, 'autoload': 'false'})
        request = urllib.request.Request(root + '/props?' + query, headers={'Authorization': 'Bearer ' + state.get('api_key', '')})
        props = local_json(request)
        defaults = props.get('default_generation_settings')
        if not isinstance(defaults, dict) or not isinstance(defaults.get('params'), dict) or not defaults['params']:
            raise ValueError('Model generation defaults unavailable')
        context = defaults.get('n_ctx')
        if not isinstance(context, int) or isinstance(context, bool) or context < 1 or props.get('is_sleeping') is True:
            raise ValueError('Effective context unavailable or model sleeping')
        if not isinstance(props.get('build_info'), str) or not props['build_info'] or not isinstance(props.get('model_path'), str):
            raise ValueError('Model properties incomplete')
        if parent.create_time() != server_identity['startedAt']:
            raise ValueError('Model endpoint process was replaced')
        stage = 'The selected model cannot be tied to exactly one owned llama-server process'
        matches = []
        for process in [parent, *parent.children(recursive=True)]:
            try:
                if Path(process.exe()).name.lower() not in ('llama-server', 'llama-server.exe'):
                    continue
                if Path(process.exe()).resolve(strict=True) != executable.resolve(strict=True):
                    continue
                args, cwd = process.cmdline(), Path(process.cwd())
                resolve = lambda value: (cwd / value).resolve(strict=True)
                target = resolve(props['model_path'])
                if target in [resolve(value) for value in option_values(args, {'-m', '--model'})]:
                    matches.append((process, args, cwd, target))
            except (psutil.Error, OSError, ValueError):
                continue
        if len(matches) != 1:
            raise ValueError('Loaded model cannot be tied to exactly one owned process')
        process, args, cwd, target = matches[0]
        if any(arg.partition('=')[0].startswith('--lora') for arg in args):
            stage = 'Live LoRA adapter identity is unsupported; no model comparison is available for this configuration'
            raise ValueError('Live LoRA adapter scales require separate identity support')
        started_at = process.create_time()
        stage = 'Complete unchanged GGUF weights, auxiliary files or runtime libraries could not be verified'
        files, seals = [], {}
        paths = [target, *((cwd / value).resolve(strict=True) for value in option_values(args, {'-mm', '--mmproj', '--lora', '--lora-scaled', '-md', '--model-draft'}))]
        for arg in args[1:]:
            value = arg.partition('=')[2] if '=' in arg else arg
            if value.lower().endswith('.gguf') and (cwd / value).resolve(strict=True) not in paths:
                raise ValueError('Unaccounted model weight argument')
        for index, file in enumerate(dict.fromkeys(paths)):
            first = gguf_metadata(file)
            count = first.get('split.count', 1)
            if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 64:
                raise ValueError('Unsupported split GGUF count')
            members = [file]
            if count > 1:
                match = re.fullmatch(r'(.+)-00001-of-(\d{5})\.gguf', file.name)
                if not match or int(match[2]) != count or first.get('split.no') != 0:
                    raise ValueError('Split GGUF manifest mismatch')
                members = [file.with_name(f'{match[1]}-{part:05d}-of-{count:05d}.gguf') for part in range(1, count + 1)]
            for part, member in enumerate(members):
                seals[member] = file_identity(member)
                content = digest_file(member, started_at, True)
                if count > 1 and (content['gguf'].get('split.count') != count or content['gguf'].get('split.no') != part):
                    raise ValueError('Split GGUF member mismatch')
                files.append({'role': 'model' if index == 0 else 'auxiliary', 'part': part + 1, **content})
        executable = Path(process.exe())
        seals[executable] = file_identity(executable)
        runtime_files = []
        for runtime_file in [executable, *sorted(executable.parent.glob('*.dll'))]:
            seals[runtime_file] = file_identity(runtime_file)
            content = digest_file(runtime_file, started_at)
            runtime_files.append({'name': runtime_file.name, 'sha256': content['sha256'], 'bytes': content['bytes']})
        runtime_hash = hashlib.sha256(stable_json(runtime_files)).hexdigest()
        environment = {key: value for key, value in process.environ().items() if key.startswith(('LLAMA_ARG_', 'GGML_CUDA_')) or key in ('CUDA_VISIBLE_DEVICES', 'OMP_NUM_THREADS')}
        environment = {key: '[credential omitted]' if any(word in key.upper() for word in ('KEY', 'TOKEN', 'PASSWORD', 'SECRET')) else value for key, value in environment.items()}
        # Fingerprint complete reported inference parameters and model template,
        # without retaining template text, CLI paths, credentials or environment.
        settings = {'params': defaults['params'], 'contextLength': context, 'totalSlots': props.get('total_slots'),
                    'build': props['build_info'], 'template': props.get('chat_template'), 'templateCaps': props.get('chat_template_caps'),
                    'modalities': props.get('modalities'), 'arguments': sanitized_arguments(args), 'environment': environment, 'runtimeSha256': runtime_hash}
        if any(file_identity(file) != seal for file, seal in seals.items()):
            raise ValueError('Model/runtime file changed during verification')
        if psutil.Process(process.pid).create_time() != started_at or psutil.Process(parent.pid).create_time() != server_identity['startedAt']:
            raise ValueError('Model process changed while verifying')
        return {'weightsFingerprint': hashlib.sha256(stable_json(files)).hexdigest(), 'contextLength': context,
                'serverSettingsFingerprint': hashlib.sha256(stable_json(settings)).hexdigest(), 'verification': 'gguf-bytes-and-live-props-v1',
                'runtimeSha256': runtime_hash, 'runtimeFiles': runtime_files, 'build': props['build_info'], 'modelProcess': {'pid': process.pid, 'startedAt': started_at},
                'files': files, 'gaps': [], 'method': 'Full file SHA-256 in each fresh worker; unchanged file identity/stat and process lifetime rechecked within that worker'}
    except Exception:
        # File names, HTTP exception text and command lines can contain private
        # data. Missing or mismatched evidence stays unknown, never a guessed ID.
        unknown['gaps'].append(stage)
        return unknown


def emit(kind, **values):
    with LOCK:
        OUT.write(json.dumps({'type': kind, **values}, ensure_ascii=True) + '\n')
        OUT.flush()


def gpu_snapshot():
    try:
        p = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total,memory.used,driver_version,uuid', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=3, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if p.returncode:
            return None
        return [{'name': a.strip(), 'totalMiB': float(b), 'usedMiB': float(c), 'driverVersion': d.strip(), 'deviceId': e.strip()} for a, b, c, d, e in (line.rsplit(',', 4) for line in p.stdout.strip().splitlines())]
    except Exception:
        return None


def lmstudio_details(inference, *, allow_configured_model_key=False):
    if not isinstance(inference, dict) or inference.get('provider') != 'lmstudio':
        raise AdapterError('Explicit inference supports local LM Studio only.')
    endpoint = inference.get('baseUrl', '').rstrip('/')
    url = urlsplit(endpoint)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path != '/v1' or url.username or url.password or url.query or url.fragment:
        raise AdapterError('LM Studio needs an IPv4 loopback /v1 endpoint without credentials.')
    selected = inference.get('model')
    if not isinstance(selected, str) or not selected or len(selected) > 240:
        raise AdapterError('Select an explicitly loaded LM Studio instance.')
    reasoning = inference.get('reasoning', 'low')
    if reasoning not in ('off', 'low', 'medium', 'high'):
        raise AdapterError('Unsupported reasoning effort.')
    context = inference.get('contextLength')
    if type(context) is not int or not 4096 <= context <= 262144:
        raise AdapterError('LM Studio diagnostic context must be 4096–262144 tokens and already loaded explicitly.')
    # Native inventory distinguishes downloaded models from actually loaded ones.
    # Never invoke JIT loading merely because /v1/models advertises a download.
    listing = local_json(urllib.request.Request(endpoint[:-3] + '/api/v1/models'))
    loaded = [(model, instance) for model in listing.get('models', []) for instance in model.get('loaded_instances', [])]
    if len(loaded) != 1 or loaded[0][0].get('type') != 'llm':
        raise AdapterError('Load exactly one selected LM Studio language model before testing.')
    model, instance = loaded[0]
    if instance.get('id') != selected and not (allow_configured_model_key and model.get('key') == selected):
        raise AdapterError('The configured LM Studio model is not the single loaded instance. Load that model explicitly before testing.')
    selected = instance.get('id')
    if not isinstance(selected, str) or not selected or len(selected) > 240:
        raise AdapterError('LM Studio loaded instance identity is malformed.')
    capabilities = model.get('capabilities', {})
    if not isinstance(capabilities, dict):
        raise AdapterError('LM Studio capability shape changed; revalidate the adapter.')
    reasoning_capability = capabilities.get('reasoning', {})
    if not isinstance(reasoning_capability, dict):
        raise AdapterError('LM Studio reasoning capability shape changed; revalidate the adapter.')
    reasoning_options = reasoning_capability.get('allowed_options', [])
    if not isinstance(reasoning_options, list) or any(not isinstance(value, str) or value not in ('off', 'on', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh') for value in reasoning_options):
        raise AdapterError('LM Studio reasoning capability vocabulary changed; revalidate the adapter.')
    reasoning_default = reasoning_capability.get('default')
    if reasoning_default is not None and (not isinstance(reasoning_default, str) or reasoning_default not in reasoning_options):
        raise AdapterError('LM Studio declared reasoning default is inconsistent with its capabilities.')
    normalized = {'off': 'none', 'on': 'medium'}
    desired = normalized.get(reasoning, reasoning)
    unsupported = bool(reasoning_options) and desired not in {normalized.get(value, value) for value in reasoning_options}
    if unsupported and not allow_configured_model_key:
        raise AdapterError('The selected reasoning effort is not supported by this loaded model.')
    load_config = instance.get('config', {})
    if load_config.get('context_length') != context or load_config.get('parallel') != 1:
        raise AdapterError('Loaded LM Studio context or single-request concurrency differs from the requested setup.')
    owners = {c.pid for c in psutil.net_connections(kind='tcp') if c.status == psutil.CONN_LISTEN and c.laddr.port == (url.port or 80) and c.pid}
    if len(owners) != 1:
        raise AdapterError('LM Studio endpoint ownership is ambiguous.')
    pid = next(iter(owners))
    if psutil.Process(pid).name().lower() not in ('lm studio.exe', 'llmster.exe', 'llmster'):
        raise AdapterError('The selected endpoint is not owned by LM Studio.')
    evidence = {'verification': 'lmstudio-loaded-instance-v1', 'weightsFingerprint': None, 'contextLength': context,
                'serverSettingsFingerprint': None, 'loadedModel': {key: model.get(key) for key in ['key', 'architecture', 'quantization', 'size_bytes', 'selected_variant']},
                'loadedInstance': {'id': instance['id'], 'config': load_config},
                'gaps': ['LM Studio loaded instance and load settings observed; effective inference defaults and loaded weight/runtime bytes are not fully attested.']}
    evidence['loadedModel']['reasoningOptions'] = sorted(set(reasoning_options))
    evidence['reasoningSelection'] = {'requested': reasoning, 'requestEffort': None if unsupported or not reasoning_options else desired,
                                    'declaredDefault': reasoning_default,
                                    'policy': 'configured-hermes-default-fallback' if unsupported else 'requested-effort'}
    config = {'model': {'default': selected, 'provider': 'lmstudio', 'context_length': context}, 'agent': {'reasoning_effort': reasoning}}
    return config, {'pid': pid, 'api_key': '', 'model_evidence': evidence}, endpoint


def source_details(source, inference=None):
    if inference is not None:
        return lmstudio_details(inference)
    config = yaml.safe_load((source / 'config.yaml').read_text(encoding='utf-8-sig'))
    model = config.get('model', {})
    if model.get('provider') == 'lmstudio':
        # The normal GUI probe follows Hermes's saved setup. Native inventory
        # resolves its model key to an already loaded instance; never JIT-load.
        return lmstudio_details({'provider': 'lmstudio', 'baseUrl': model.get('base_url', ''),
                                 'model': model.get('default'), 'contextLength': model.get('context_length'),
                                 'reasoning': config.get('agent', {}).get('reasoning_effort', 'high')},
                                allow_configured_model_key=True)
    if model.get('provider') not in ('llamacpp', 'llama.cpp', 'llama-cpp'):
        raise AdapterError('This adapter supports Hermes with its configured local llama.cpp or explicitly loaded LM Studio model.')
    state = json.loads((source / 'runtimes/llamacpp/server.json').read_text(encoding='utf-8'))
    if not psutil.pid_exists(int(state.get('pid', 0))):
        raise AdapterError('The configured model server is not running. Start it in Hermes first.')
    endpoint = state.get('base_url', '').rstrip('/')
    url = urlsplit(endpoint)
    if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1') or url.username or url.password or url.query or url.fragment:
        raise AdapterError('Expected a loopback model endpoint without embedded credentials.')
    return config, state, endpoint


def inventory(source, inference=None):
    config, state, endpoint = source_details(source, inference)
    repo = source / 'hermes-agent'
    revision = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).strip()
    if revision != REVISION:
        raise AdapterError('Installed Hermes revision changed; adapter compatibility needs revalidation.')
    critical = ['run_agent.py', 'model_tools.py', 'toolsets.py', 'agent/agent_init.py', 'agent/agent_runtime_helpers.py', 'agent/conversation_loop.py', 'agent/tool_executor.py', 'agent/reasoning_params.py', 'agent/lmstudio_reasoning.py', 'agent/chat_completion_helpers.py', 'agent/transports/chat_completions.py', 'hermes_cli/models_local.py', 'tools/mcp_tool.py', 'tools/mcp_tool_discovery.py', 'tools/mcp_tool_registration.py']
    versions = {'python': platform.python_version()}
    for package in ['mcp', 'mcp-types', 'openai', 'httpx', 'httpx2', 'jsonschema', 'pydantic', 'PyYAML', 'psutil']:
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    fingerprint = hashlib.sha256(b''.join((repo / p).read_bytes() for p in critical) + json.dumps(versions, sort_keys=True).encode()).hexdigest()
    request = urllib.request.Request(endpoint + '/models', headers={'Authorization': 'Bearer ' + state.get('api_key', '')})
    models = local_json(request)
    ids = [m.get('id') for m in models.get('data', [])]
    selected = config['model'].get('default')
    if selected not in ids:
        raise AdapterError('The configured model is not advertised by the running local endpoint.')
    server_identity = {'pid': state['pid'], 'startedAt': None, 'executableName': None, 'endpointOwned': None, 'runtimeKind': 'unverified'}
    try:
        proc = psutil.Process(int(state['pid']))
        server_identity['startedAt'] = proc.create_time()
        server_identity['executableName'] = Path(proc.exe()).name
        server_identity['runtimeKind'] = 'llama.cpp' if server_identity['executableName'].lower() in ('llama-server', 'llama-server.exe') else 'unverified'
        port = urlsplit(endpoint).port or 80
        server_identity['endpointOwned'] = any(connection.status == psutil.CONN_LISTEN and connection.laddr.port == port for connection in proc.net_connections(kind='tcp'))
    except (psutil.Error, OSError, ValueError):
        pass
    configured_context = config.get('model', {}).get('context_length')
    if not isinstance(configured_context, int) or isinstance(configured_context, bool) or configured_context < 1:
        configured_context = None
    if config['model']['provider'] == 'lmstudio':
        server_identity['runtimeKind'] = 'LM Studio'
    evidence = state.get('model_evidence') or model_evidence(endpoint, state, selected, server_identity)
    return {'harness': 'Hermes', 'revision': revision, 'fingerprint': fingerprint, 'runtimeVersions': versions, 'model': selected, 'provider': config['model']['provider'], 'reasoning': config.get('agent', {}).get('reasoning_effort', 'high'), 'configuredContextLength': configured_context, 'endpoint': endpoint, 'modelServerPid': state['pid'], 'modelServerIdentity': server_identity, 'modelEvidence': evidence, 'modelIdentity': evidence['verification'], 'hardware': {'cpu': platform.processor(), 'logicalCpus': psutil.cpu_count(), 'ramBytes': psutil.virtual_memory().total, 'gpus': gpu_snapshot()}, 'isolation': 'fresh Hermes home; only diagnostic MCP tools; existing shared model server', 'ready': True}


def run(request, source):
    prompt = final_response_prompt(request['prompt'], request.get('responseFormat'))
    inference = request.get('inference')
    details = inventory(source, inference)
    config, endpoint_state, endpoint = source_details(source, inference)
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
    if details['provider'] == 'lmstudio':
        isolated['model']['provider'] = 'lmstudio'
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
            empty_catalog = request.get('emptyCatalog') is True
            selected_toolsets = [] if empty_catalog else ['mcp-diagnostic']
            if empty_catalog:
                # Distinguish a genuinely empty MCP catalog from failed discovery.
                from mcp import ClientSession
                from mcp.client.streamable_http import streamable_http_client
                async def verify_empty_catalog():
                    async with streamable_http_client(request['gateway']) as streams:
                        reader, writer = streams[0], streams[1]
                        async with ClientSession(reader, writer) as session:
                            await session.initialize()
                            listing = await session.list_tools()
                            if listing.tools or listing.next_cursor or names:
                                raise AdapterError('Expected empty diagnostic catalog changed during setup.')
                asyncio.run(asyncio.wait_for(verify_empty_catalog(), timeout=15))
            if not names and not empty_catalog:
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

            agent = AIAgent(model=details['model'], provider=isolated['model']['provider'], base_url=endpoint, api_key=endpoint_state.get('api_key') or 'local', max_iterations=request['maxTurns'], max_tokens=2048, enabled_toolsets=selected_toolsets, quiet_mode=True, skip_context_files=True, load_soul_identity=False, skip_memory=True, skip_background_review=True, checkpoints_enabled=False, save_trajectories=False, reasoning_config=reasoning_config(details['reasoning']), fallback_model=None, run_budget_seconds=request['maxTrialSeconds'], tool_start_callback=tool_start, tool_complete_callback=lambda cid, name, args, result: emit('tool-end', callId=cid, name=name, ms=(time.monotonic()-started)*1000))
            lmstudio_effort = None
            if details['provider'] == 'lmstudio':
                lmstudio_effort = bind_lmstudio_reasoning(agent, details)
                # Fixed, inspectable local sampling controls; never arbitrary request injection.
                agent.request_overrides = {**agent.request_overrides, 'temperature': 0.2, 'top_p': 0.95, 'seed': 18431}
            unexpected = [n for n in agent.valid_tool_names if empty_catalog or not n.startswith('mcp__diagnostic__')]
            if unexpected:
                raise AdapterError('Hermes enabled tools outside the diagnostic server; trial stopped: ' + ', '.join(sorted(unexpected)))
            request_sequence = 0

            def observe_request(outbound):
                nonlocal request_sequence
                if not outbound.url.path.endswith('/chat/completions'):
                    return
                request_sequence += 1
                try:
                    body = json.loads(outbound.content)
                    definitions = body.get('tools', [])
                    exact = isinstance(definitions, list) and len(json.dumps(definitions)) < 150000
                    parameters = {key: body[key] for key in ['model', 'temperature', 'top_p', 'top_k', 'min_p', 'seed', 'max_tokens', 'max_completion_tokens', 'reasoning_effort', 'frequency_penalty', 'presence_penalty', 'repeat_penalty', 'parallel_tool_calls', 'tool_choice'] if key in body}
                    # Fingerprint additional provider controls without retaining
                    # their arbitrary values. Content and credential fields never
                    # enter this fingerprint or the event stream.
                    excluded = {'messages', 'tools', 'functions', 'input', 'prompt', 'user', 'metadata', 'stream', 'stream_options', 'api_key', 'authorization', 'password', 'secret'}
                    controls = {key: value for key, value in body.items() if key.lower() not in excluded}
                    parameter_fingerprint = hashlib.sha256(json.dumps(controls, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
                    emit('model-request', sequence=request_sequence, definitions=definitions if exact else None, exactDefinitions=exact, parameters=parameters, parameterFingerprint=parameter_fingerprint, parameterKeys=sorted(controls), exactParameters=True, source='outbound HTTP request after SDK serialization', ms=(time.monotonic()-started)*1000)
                except Exception:
                    emit('model-request', sequence=request_sequence, definitions=None, exactDefinitions=False, parameters=None, exactParameters=False, source='outbound HTTP request; body unavailable', ms=(time.monotonic()-started)*1000)

            def instrument_client(client):
                if details['provider'] == 'lmstudio':
                    pin_local_sampling(client, lmstudio_effort)
                hooks = getattr(getattr(client, '_client', None), 'event_hooks', None)
                if not isinstance(hooks, dict) or 'request' not in hooks:
                    raise AdapterError('The installed provider transport cannot expose request definitions; adapter needs revalidation.')
                if observe_request not in hooks['request']:
                    hooks['request'].append(observe_request)
                return client

            # Scope the observer to this fresh diagnostic agent, including any
            # replacement client it creates. Never record messages or headers.
            instrument_client(agent.client)
            create_client = agent._create_openai_client
            agent._create_openai_client = lambda *args, **kwargs: instrument_client(create_client(*args, **kwargs))
            emit('ready', inventory=details, advertisedTools=sorted(agent.valid_tool_names), advertisedDefinitions=agent.tools, startupMs=(time.monotonic()-started)*1000, controls={'hermesToolSearch': 'off', 'memory': 'off', 'contextFiles': 'off', 'toolsets': selected_toolsets, 'emptyCatalogVerified': empty_catalog, 'maxOutputTokens': 2048, 'maxTurns': request['maxTurns'], 'lmstudioReasoningEffort': lmstudio_effort, 'finalResponseFormat': request.get('responseFormat'), 'finalResponsePolicy': 'harbor-final-json-1' if request.get('responseFormat') else None})
            result = agent.run_conversation(prompt)
            emit('result', finalResponse=result.get('final_response') or '', harnessCompleted=result.get('completed'), failed=result.get('failed', False), interrupted=result.get('interrupted', False), apiCalls=result.get('api_calls'), modelReported=agent.model, usage=None, cost=None)
            try:
                emit('identity-end', inventory=inventory(source, inference))
            except Exception:
                emit('identity-end', inventory=None, reason='End-of-trial setup could not be verified')
            agent.close()
            shutdown_mcp_servers()
    finally:
        stop.set()


def main():
    request = json.load(sys.stdin)
    source = Path(request['source']).resolve()
    try:
        if request['op'] == 'probe':
            emit('inventory', **inventory(source, request.get('inference')))
        else:
            run(request, source)
    except Exception as error:
        # Do not return arbitrary exception text, URLs with tokens, or tracebacks.
        safe = str(error) if isinstance(error, AdapterError) else 'Local adapter operation failed (' + type(error).__name__ + ').'
        if not isinstance(error, AdapterError):
            frame = error.__traceback__
            while frame and frame.tb_next:
                frame = frame.tb_next
            if frame:
                safe += ' Source: ' + Path(frame.tb_frame.f_code.co_filename).name + ':' + str(frame.tb_lineno)
        emit('error', message=safe)
        sys.exit(1)


if __name__ == '__main__':
    main()
