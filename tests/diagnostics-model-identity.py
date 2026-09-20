"""Engineering fixtures for file/protocol evidence, never real-model acceptance."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

spec = importlib.util.spec_from_file_location('harbor_worker', Path(__file__).resolve().parents[1] / 'src/diagnostics/hermes_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def gguf(file, count=1, part=0, payload=b'fixture tensors'):
    def string(value):
        encoded = value.encode()
        return struct.pack('<Q', len(encoded)) + encoded
    metadata = [('general.architecture', 8, string('fixture-only')), ('general.file_type', 4, struct.pack('<I', 7))]
    if count > 1:
        metadata += [('split.count', 4, struct.pack('<I', count)), ('split.no', 4, struct.pack('<I', part))]
    file.write_bytes(b'GGUF' + struct.pack('<IQQ', 3, 0, len(metadata)) + b''.join(string(key) + struct.pack('<I', kind) + value for key, kind, value in metadata) + payload)


class Process:
    def __init__(self, pid, executable, directory, started, args, children=None):
        self.pid, self.executable, self.directory, self.started, self.args = pid, executable, directory, started, args
        self.descendants = children or []
    def exe(self): return str(self.executable)
    def cwd(self): return str(self.directory)
    def create_time(self): return self.started
    def cmdline(self): return self.args
    def children(self, recursive=False): return self.descendants
    def environ(self): return {'LLAMA_ARG_TEMP': '0.6', 'LLAMA_ARG_API_KEY': 'environment-secret-fixture', 'PRIVATE_VARIABLE': 'private-not-included'}


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='Harbor model identity ')
        self.root = Path(self.directory.name)
        self.model, self.exe = self.root / 'fixture.gguf', self.root / 'llama-server.exe'
        gguf(self.model)
        self.exe.write_bytes(b'fixture runtime bytes; not an executable')
        self.started = max(time.time(), self.model.stat().st_mtime, self.exe.stat().st_mtime, self.model.stat().st_ctime, self.exe.stat().st_ctime) + 0.01
        self.process = Process(101, self.exe, self.root, self.started, [str(self.exe), '-m', str(self.model), '--api-key', 'credential-fixture'])
        self.parent = Process(100, self.exe, self.root, self.started, [str(self.exe), '--models-dir', str(self.root)], [self.process])
        self.props = {'default_generation_settings': {'n_ctx': 8192, 'params': {'temperature': 0.6, 'top_k': 20, 'grammar': 'private grammar fixture'}}, 'model_path': str(self.model), 'build_info': 'b10679-fixture', 'total_slots': 1, 'chat_template': 'private template fixture', 'is_sleeping': False}
        self.requests = []
        self.redirect = False
        owner = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append({'path': self.path, 'key': self.headers.get('Authorization')})
                if owner.redirect:
                    self.send_response(302); self.send_header('Location', owner.endpoint+'/redirect-target'); self.end_headers(); return
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps(owner.props).encode())
            def log_message(self, *_args): pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.endpoint = f'http://127.0.0.1:{self.server.server_port}/v1'
        self.state = {'pid': 100, 'api_key': 'credential-fixture'}
        self.identity = {'endpointOwned': True, 'runtimeKind': 'llama.cpp', 'startedAt': self.started}
        self.patch = patch.object(worker.psutil, 'Process', side_effect=lambda pid: {100: self.parent, 101: self.process}[pid]); self.patch.start()
        self.version_patch = patch.object(worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'version: 0.3.0-dev (build 10679, commit 50f068fff)', '')); self.version_patch.start()
        worker.DIGESTS.clear(); worker.RUNTIME_BUILDS.clear()

    def tearDown(self):
        self.patch.stop(); self.version_patch.stop(); self.server.shutdown(); self.server.server_close(); self.thread.join(); self.directory.cleanup(); worker.DIGESTS.clear(); worker.RUNTIME_BUILDS.clear()

    def evidence(self):
        return worker.model_evidence(self.endpoint, self.state, 'fixture model/one', self.identity)

    def test_live_properties_and_complete_weight_bytes_produce_stable_private_evidence(self):
        first = self.evidence(); self.assertEqual(first['verification'], 'gguf-bytes-and-live-props-v1')
        self.assertEqual(first['contextLength'], 8192)
        self.assertEqual(first['files'][0]['sha256'], hashlib.sha256(self.model.read_bytes()).hexdigest())
        self.assertEqual(first['runtimeFiles'][0]['sha256'], hashlib.sha256(self.exe.read_bytes()).hexdigest())
        self.assertEqual(first['runtimeSha256'], hashlib.sha256(worker.stable_json(first['runtimeFiles'])).hexdigest())
        self.assertEqual(first, self.evidence())
        query = parse_qs(urlsplit(self.requests[0]['path']).query)
        self.assertEqual(query, {'model': ['fixture model/one'], 'autoload': ['false']})
        self.assertTrue(all(value['key'] == 'Bearer credential-fixture' for value in self.requests))
        serialized = json.dumps(first)
        for private in ['credential-fixture', 'environment-secret-fixture', 'private-not-included', 'private template fixture', 'private grammar fixture', str(self.root)]:
            self.assertNotIn(private, serialized)

    def test_context_defaults_template_and_runtime_changes_are_distinct_identities(self):
        initial = self.evidence()
        for action in [lambda: self.props['default_generation_settings']['params'].update(temperature=0.7), lambda: self.props.update(chat_template='changed'), lambda: self.props['default_generation_settings'].update(n_ctx=4096), lambda: self.process.args.extend(['--flash-attn', 'on'])]:
            previous = self.evidence(); action(); current = self.evidence()
            self.assertNotEqual(previous['serverSettingsFingerprint'], current['serverSettingsFingerprint'])
            self.assertEqual(initial['weightsFingerprint'], current['weightsFingerprint'])

    def test_shards_and_auxiliary_weights_are_all_hashed_and_missing_or_wrong_parts_fail_closed(self):
        first, second, projector = self.root/'split-00001-of-00002.gguf', self.root/'split-00002-of-00002.gguf', self.root/'projector.gguf'
        gguf(first, 2, 0); gguf(second, 2, 1); gguf(projector)
        self.started = max(time.time(), *(max(file.stat().st_mtime, file.stat().st_ctime) for file in (first, second, projector))) + 0.01; self.parent.started = self.process.started = self.started; self.identity['startedAt'] = self.started
        self.props['model_path'] = str(first); self.process.args = [str(self.exe), '--model='+str(first), '--mmproj', str(projector)]
        result = self.evidence(); self.assertEqual(len(result['files']), 3)
        self.assertEqual([entry['role'] for entry in result['files']], ['model', 'model', 'auxiliary'])
        second.unlink(); self.assertIsNone(self.evidence()['weightsFingerprint'])
        gguf(second, 2, 0); self.assertIsNone(self.evidence()['weightsFingerprint'])

    def test_file_mutation_invalidates_even_an_in_worker_digest_cache(self):
        self.assertIsNotNone(self.evidence()['weightsFingerprint'])
        self.model.write_bytes(self.model.read_bytes()+b'changed')
        future = time.time()+2; os.utime(self.model, (future, future))
        self.assertIsNone(self.evidence()['weightsFingerprint'])

    def test_unverified_ownership_does_not_issue_model_properties_request(self):
        self.identity['endpointOwned'] = False
        self.assertIsNone(self.evidence()['weightsFingerprint']); self.assertEqual(self.requests, [])

    def test_missing_defaults_sleeping_process_replacement_and_ambiguous_ownership_remain_unknown(self):
        for props in [{}, {**self.props, 'is_sleeping': True}, {**self.props, 'default_generation_settings': {'n_ctx': True, 'params': {'temperature': 1}}}]:
            with patch.object(self, 'props', props): self.assertIsNone(self.evidence()['weightsFingerprint'])
        self.parent.started += 1; self.assertIsNone(self.evidence()['weightsFingerprint']); self.parent.started -= 1
        self.parent.descendants.append(self.process); self.assertIsNone(self.evidence()['weightsFingerprint'])

    def test_invalid_gguf_and_unaccounted_weight_arguments_are_not_hash_attestations(self):
        self.model.write_bytes(b'private non-model file'); self.assertIsNone(self.evidence()['weightsFingerprint'])
        gguf(self.model); self.process.started = self.parent.started = max(time.time(), self.model.stat().st_mtime, self.model.stat().st_ctime) + 0.01; self.identity['startedAt'] = self.parent.started
        self.assertIsNotNone(self.evidence()['weightsFingerprint'])
        self.process.args.extend(['--unknown-weight-kind', str(self.root/'other.gguf')]); self.assertIsNone(self.evidence()['weightsFingerprint'])

    def test_version_gate_precedes_model_query_and_redirects_never_forward_credentials(self):
        with patch.object(worker.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'build 1 unknown', '')):
            self.assertIsNone(self.evidence()['weightsFingerprint']); self.assertEqual(self.requests, [])
        self.redirect = True
        self.assertIsNone(self.evidence()['weightsFingerprint']); self.assertEqual(len(self.requests), 1)

    def test_adjacent_runtime_libraries_are_hashed_and_live_lora_state_is_not_guessed(self):
        library = self.root/'llama-server-impl.dll'; library.write_bytes(b'fixture runtime implementation')
        self.started = max(time.time(), library.stat().st_mtime, library.stat().st_ctime) + 0.01
        self.parent.started = self.process.started = self.started; self.identity['startedAt'] = self.started
        result = self.evidence(); self.assertEqual(len(result['runtimeFiles']), 2)
        self.assertEqual(result['runtimeFiles'][1]['sha256'], hashlib.sha256(library.read_bytes()).hexdigest())
        self.process.args.extend(['--lora', str(self.model)]); self.assertIsNone(self.evidence()['weightsFingerprint'])


class LMStudioTests(unittest.TestCase):
    def setUp(self):
        self.request = {'provider': 'lmstudio', 'baseUrl': 'http://127.0.0.1:1234/v1', 'model': 'benchmark-one', 'contextLength': 8192}
        self.instance = {'id': 'benchmark-one', 'config': {'context_length': 8192, 'parallel': 1}}
        self.model = {'type': 'llm', 'key': 'fixture/model', 'loaded_instances': [self.instance]}
        self.connection = SimpleNamespace(pid=42, status=worker.psutil.CONN_LISTEN, laddr=SimpleNamespace(port=1234))

    def details(self):
        with patch.object(worker, 'local_json', return_value={'models': [self.model]}), patch.object(worker.psutil, 'net_connections', return_value=[self.connection]), patch.object(worker.psutil, 'Process', return_value=SimpleNamespace(name=lambda: 'LM Studio.exe')):
            return worker.lmstudio_details(self.request)

    def test_loaded_instance_is_observed_without_claiming_weight_attestation(self):
        config, state, endpoint = self.details()
        self.assertEqual(config['model']['default'], 'benchmark-one')
        self.assertEqual(state['model_evidence']['contextLength'], 8192)
        self.assertIsNone(state['model_evidence']['weightsFingerprint'])
        self.assertTrue(state['model_evidence']['gaps'])
        self.instance['remaining_ttl_seconds'] = 12
        self.assertEqual(self.details()[1]['model_evidence'], state['model_evidence'])

    def test_normal_config_resolves_only_its_already_loaded_model_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            file = source / 'config.yaml'
            original = b'model:\n  provider: lmstudio\n  default: fixture/model\n  base_url: http://127.0.0.1:1234/v1\n  context_length: 8192\nagent:\n  reasoning_effort: high\n'
            file.write_bytes(original)
            with patch.object(worker, 'local_json', return_value={'models': [self.model]}) as request, patch.object(worker.psutil, 'net_connections', return_value=[self.connection]), patch.object(worker.psutil, 'Process', return_value=SimpleNamespace(name=lambda: 'LM Studio.exe')):
                config, state, endpoint = worker.source_details(source)
                self.assertEqual(config['model']['default'], 'benchmark-one')
                self.assertEqual(config['agent']['reasoning_effort'], 'high')
                self.assertEqual(state['model_evidence']['loadedModel']['key'], 'fixture/model')
                self.assertEqual(request.call_count, 1)
                self.assertEqual(request.call_args[0][0].get_method(), 'GET')
                self.assertTrue(request.call_args[0][0].full_url.endswith('/api/v1/models'))
                self.model['key'] = 'unrelated/model'
                with self.assertRaises(worker.AdapterError): worker.source_details(source)
                self.model['loaded_instances'] = []
                with self.assertRaises(worker.AdapterError): worker.source_details(source)
            self.assertEqual(file.read_bytes(), original)
            self.assertEqual([p.name for p in source.iterdir()], ['config.yaml'])

    def test_explicit_acceptance_still_requires_the_exact_instance_id(self):
        self.request['model'] = 'fixture/model'
        with self.assertRaises(worker.AdapterError): self.details()

    def test_downloaded_only_other_instances_and_wrong_load_settings_are_rejected(self):
        for instances in [[], [self.instance, self.instance], [{'id': 'other', 'config': self.instance['config']}], [{'id': 'benchmark-one', 'config': {'context_length': 8192, 'parallel': 4}}], [{'id': 'benchmark-one', 'config': {'context_length': 131072, 'parallel': 1}}]]:
            self.model['loaded_instances'] = instances
            with self.assertRaises(worker.AdapterError): self.details()

    def test_remote_endpoints_and_unknown_process_owners_are_rejected(self):
        for url in ['https://127.0.0.1:1234/v1', 'http://example.com/v1', 'http://secret@127.0.0.1/v1', 'http://127.0.0.1/v1?token=secret']:
            self.request['baseUrl'] = url
            with self.assertRaises(worker.AdapterError): self.details()
        self.request['baseUrl'] = 'http://127.0.0.1:1234/v1'
        with patch.object(worker, 'local_json', return_value={'models': [self.model]}), patch.object(worker.psutil, 'net_connections', return_value=[]):
            with self.assertRaises(worker.AdapterError): worker.lmstudio_details(self.request)

    def test_forced_final_calls_keep_local_sampling_without_changing_tools_or_messages(self):
        calls = []
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: calls.append(kwargs))))
        worker.pin_local_sampling(client)
        first = client.chat.completions.create
        worker.pin_local_sampling(client)
        self.assertIs(first, client.chat.completions.create)
        client.chat.completions.create(model='fixture', messages=[{'role':'user','content':'fixture'}], max_tokens=2048)
        self.assertEqual(calls[0]['seed'], 18431)
        self.assertEqual(calls[0]['temperature'], 0.2)
        self.assertEqual(calls[0]['top_p'], 0.95)
        self.assertNotIn('tools', calls[0])
        self.assertEqual(calls[0]['messages'], [{'role':'user','content':'fixture'}])
        client.chat.completions.create(temperature=0.3)
        self.assertEqual(calls[1]['temperature'], 0.3, 'An explicit harness change stays visible to the drift guard')

    def test_canonical_capabilities_bind_to_unique_instance_and_forced_final(self):
        self.model['capabilities'] = {'reasoning': {'allowed_options': ['off', 'on']}}
        self.request['reasoning'] = 'medium'
        evidence = self.details()[1]['model_evidence']
        self.assertEqual(evidence['loadedModel']['reasoningOptions'], ['off', 'on'])
        agent = SimpleNamespace(_lmstudio_reasoning_options_cached=lambda: [])
        details = {'modelEvidence': evidence, 'reasoning': 'medium'}
        self.assertEqual(worker.bind_lmstudio_reasoning(agent, details), 'medium')
        self.assertEqual(agent._lmstudio_reasoning_options_cached(), ['off', 'on'])
        calls = []
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: calls.append(kwargs))))
        worker.pin_local_sampling(client, 'medium')
        client.chat.completions.create(messages=[])
        self.assertEqual(calls[0]['reasoning_effort'], 'medium')
        client.chat.completions.create(reasoning_effort='none')
        self.assertEqual(calls[1]['reasoning_effort'], 'none', 'Explicit changes remain visible to drift checks')
        details['reasoning'] = 'low'
        with self.assertRaises(worker.AdapterError): worker.bind_lmstudio_reasoning(agent, details)
        details['reasoning'] = 'off'
        self.assertEqual(worker.bind_lmstudio_reasoning(agent, details), 'none')
        self.assertEqual(worker.reasoning_config('off'), {'enabled': False, 'effort': 'none'})
        details['modelEvidence']['loadedModel']['reasoningOptions'] = ['low', 'medium', 'high']
        details['reasoning'] = 'low'
        self.assertEqual(worker.bind_lmstudio_reasoning(agent, details), 'low')
        with self.assertRaises(worker.AdapterError): worker.bind_lmstudio_reasoning(SimpleNamespace(), details)

    def test_unknown_or_malformed_capabilities_are_not_invented(self):
        details = {'modelEvidence': self.details()[1]['model_evidence'], 'reasoning': 'low'}
        self.assertIsNone(worker.bind_lmstudio_reasoning(SimpleNamespace(_lmstudio_reasoning_options_cached=lambda: []), details))
        for capability in [None, [], {'reasoning': []}, {'reasoning': {'allowed_options': 'on'}}, {'reasoning': {'allowed_options': ['future']}}]:
            self.model['capabilities'] = capability
            with self.assertRaises(worker.AdapterError): self.details()

    def test_configured_unsupported_effort_matches_hermes_default_without_rewriting_it(self):
        self.model['capabilities'] = {'reasoning': {'allowed_options': ['off', 'on'], 'default': 'on'}}
        self.request['reasoning'] = 'high'
        with self.assertRaises(worker.AdapterError): self.details()
        with patch.object(worker, 'local_json', return_value={'models': [self.model]}), patch.object(worker.psutil, 'net_connections', return_value=[self.connection]), patch.object(worker.psutil, 'Process', return_value=SimpleNamespace(name=lambda: 'LM Studio.exe')):
            config, state, endpoint = worker.lmstudio_details(self.request, allow_configured_model_key=True)
        self.assertEqual(config['agent']['reasoning_effort'], 'high')
        selection = state['model_evidence']['reasoningSelection']
        self.assertEqual(selection, {'requested': 'high', 'requestEffort': None, 'declaredDefault': 'on', 'policy': 'configured-hermes-default-fallback'})
        agent = SimpleNamespace(_lmstudio_reasoning_options_cached=lambda: [])
        self.assertIsNone(worker.bind_lmstudio_reasoning(agent, {'reasoning': 'high', 'modelEvidence': state['model_evidence']}))
        self.assertEqual(agent._lmstudio_reasoning_options_cached(), ['off', 'on'])
        calls = []
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: calls.append(kwargs))))
        worker.pin_local_sampling(client, None)
        client.chat.completions.create(messages=[])
        self.assertNotIn('reasoning_effort', calls[0])
        self.model['capabilities']['reasoning']['default'] = 'high'
        with self.assertRaises(worker.AdapterError): self.details()


class FinalResponseContractTests(unittest.TestCase):
    def test_explicit_contract_preserves_task_and_unconfigured_prompt(self):
        prompt = 'Read the source, write the artifact, then return its JSON status.'
        self.assertEqual(worker.final_response_prompt(prompt), prompt)
        prepared = worker.final_response_prompt(prompt, 'json-object')
        self.assertTrue(prepared.startswith(prompt + '\n\n'))
        self.assertIn('no Markdown code fences', prepared)
        self.assertIn('Continue using the supplied tools normally', prepared)
        self.assertIn('does not replace completing or verifying', prepared)
        with self.assertRaises(worker.AdapterError): worker.final_response_prompt(prompt, 'invented-format')


if __name__ == '__main__': unittest.main(verbosity=2)
