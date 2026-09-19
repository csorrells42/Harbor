// Python's stdlib is the only Linux supervisor prerequisite. User launch data
// travels over stdin as JSON, never a shell program or command-line environment.
export const wslSupervisor = String.raw`
import os, sys, json, subprocess, threading, signal, time, ctypes, errno
libc = ctypes.CDLL(None)
# Adopt grandchildren so cleanup can wait for them rather than leaving zombies.
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise RuntimeError('Cannot enable owned-child subreaper')
spec = json.loads(sys.stdin.readline())
stop = threading.Event()
def lease():
    sys.stdin.readline()
    stop.set()
threading.Thread(target=lease, daemon=True).start()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())
child = None
completion_ready = False
def emit(record):
    try: print(json.dumps(record), flush=True)
    except (BrokenPipeError, OSError): pass
try:
    # Fail before user code if the out-of-band acknowledgement is unavailable.
    if spec.get('completionPath'):
        with open(spec['completionPath'], 'x') as completion:
            completion.write('owning')
        completion_ready = True
    if not stop.is_set():
        child = subprocess.Popen([spec['command']] + spec.get('args', []), cwd=spec.get('cwd') or None,
            env={**os.environ, **spec.get('env', {})}, stdin=subprocess.DEVNULL,
            stdout=sys.stderr, stderr=sys.stderr, start_new_session=True)
        emit({'pid': child.pid, 'supervisorPid': os.getpid()})
        while not stop.wait(.05):
            code = child.poll()
            if code is not None:
                emit({'exit': code})
                break
except Exception as error:
    code = errno.errorcode.get(getattr(error, 'errno', None), '')
    emit({'error': (code + ': ' if code else '') + str(error)})
finally:
    if child is not None:
        # Signal only direct, unreaped children from OUR /proc children list.
        # Their PIDs cannot be recycled until our waitpid below. Killing each
        # generation adopts the next even after setsid(), without group IDs or
        # raced, recursively discovered foreign PIDs.
        def children():
            with open('/proc/%s/task/%s/children' % (os.getpid(), os.getpid())) as handle:
                return [int(value) for value in handle.read().split()]
        for pid in children():
            try: os.kill(pid, signal.SIGTERM)
            except ProcessLookupError: pass
        time.sleep(.2)
        while True:
            owned = children()
            if not owned: break
            for pid in owned:
                try:
                    os.kill(pid, signal.SIGSTOP)
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError: pass
            while True:
                try:
                    if os.waitpid(-1, os.WNOHANG)[0] == 0: break
                except ChildProcessError: break
            time.sleep(.01)
        child.wait()
    # Out-of-band acknowledgement survives loss of wsl.exe and its stdio.
    # The host chooses a fresh private directory, never an endpoint/PID target.
    if completion_ready:
        with open(spec['completionPath'], 'w') as completion:
            completion.write('reaped')
`;
