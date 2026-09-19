// Race the complete operation, including SDK transport.start (whose SSE
// handshake is outside Client.connect's request timeout). Caller owns cleanup.
export async function withDeadline(operation, timeoutMs, signal) {
  let timer; let onAbort;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs} ms`)), timeoutMs);
        onAbort = () => reject(signal.reason ?? new Error('Operation cancelled'));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      })
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}
