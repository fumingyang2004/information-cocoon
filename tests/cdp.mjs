// Isolated development browser only; never connects to the user's default profile.
export async function connect(target = 'browser') {
  const base = 'http://127.0.0.1:9230';
  const item = target === 'browser' ? await (await fetch(`${base}/json/version`)).json()
    : (await (await fetch(`${base}/json/list`)).json()).find(t => t.id === target || t.url.includes(target));
  if (!item) throw new Error(`Missing CDP target: ${target}`);
  const ws = new WebSocket(item.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let next = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const data = JSON.parse(event.data);
    const p = pending.get(data.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(data.id);
    data.error ? p.reject(new Error(JSON.stringify(data.error))) : p.resolve(data.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 60000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => ws.close(), async evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  } };
}
if (process.argv[2]) {
  const client = await connect(process.argv[2]);
  try { console.log(JSON.stringify(await client.evaluate(process.argv[3]), null, 2)); }
  finally { client.close(); }
}
