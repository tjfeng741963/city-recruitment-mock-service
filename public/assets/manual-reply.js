// Preserve a send intent across timeouts and reloads. A confirmed send clears it.
export function createManualReplySender(api, storage, makeId = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}) {
  const active = new Map();
  return (device, customer, content) => {
    const slot = 'rea-send:' + JSON.stringify([device, customer, content]);
    if (active.has(slot)) return active.get(slot);
    const id = storage.getItem(slot) || makeId();
    storage.setItem(slot, id);
    const pending = api.post('/api/v1/agent/manual-reply', {
      device_code: device, customer_id: customer, content,
    }, { headers: { 'Idempotency-Key': id } }).then(response => {
      storage.removeItem(slot);
      return response.data;
    }).finally(() => active.delete(slot));
    active.set(slot, pending);
    return pending;
  };
}
