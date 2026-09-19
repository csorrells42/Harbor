import { wslSupervisor } from './wsl-supervisor.mjs';

// wsl.exe can kill its attached Linux process without delivering a signal.
// Keep that disposable bootstrap separate from the session-owning subreaper.
// Its private pipe is the owner's lease: bootstrap death closes it in-kernel.
export const wslBootstrap = String.raw`
import sys, subprocess, threading, json
spec = json.loads(sys.stdin.readline())
spec['completionPath'] = subprocess.check_output(['wslpath', '-u', spec['completionPath']], text=True).strip()
owner = subprocess.Popen([sys.executable, '-u', '-c', ${JSON.stringify(wslSupervisor)}],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    start_new_session=True)
owner.stdin.write((json.dumps(spec) + '\n').encode())
owner.stdin.flush()
def lease():
    sys.stdin.readline()
    try: owner.stdin.close()
    except BrokenPipeError: pass
threading.Thread(target=lease, daemon=True).start()
def relay(source, target):
    try:
        while True:
            chunk = source.read1(65536)
            if not chunk: break
            target.write(chunk)
            target.flush()
    except (BrokenPipeError, OSError): pass
threads = [threading.Thread(target=relay, args=(owner.stdout, sys.stdout.buffer)),
           threading.Thread(target=relay, args=(owner.stderr, sys.stderr.buffer))]
for thread in threads: thread.start()
code = owner.wait()
for thread in threads: thread.join()
sys.exit(code)
`;
