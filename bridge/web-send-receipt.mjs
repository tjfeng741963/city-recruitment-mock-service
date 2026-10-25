const pausedPages = new WeakSet();
const sendingPages = new WeakSet();

/** Read only the response to this physical send. Do not persist request URLs,
 * authentication fields or response bodies, and never fabricate a message ID.
 */
export async function sendWebTextWithReceipt({ page, accountId, contactId, text, send, timeoutMs = 25000 }) {
  if (!page) throw new Error('WeChat page is unavailable');
  if (pausedPages.has(page)) throw new Error('WeChat sending paused; manually reconcile the uncertain send before restarting the device');
  if (sendingPages.has(page)) throw new Error('A physical WeChat send is already pending');
  sendingPages.add(page);
  let physicalRequest;
  let resolveReceipt, rejectReceipt;
  const receipt = new Promise((resolve, reject) => { resolveReceipt = resolve; rejectReceipt = reject; });
  const onRequest = request => {
    if (physicalRequest) return;
    try {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/cgi-bin/mmwebwx-bin/webwxsendmsg') return;
      const message = JSON.parse(request.postData() ?? '{}').Msg;
      if (message?.FromUserName === accountId && message.ToUserName === contactId && message.Content === text && message.Type === 1) {
        physicalRequest = request;
      }
    } catch { /* An unrelated request is not evidence of this send. */ }
  };
  const onResponse = async response => {
    if (!physicalRequest || response.request() !== physicalRequest) return;
    try {
      if (response.status() !== 200) throw new Error('WeChat send HTTP response was not successful');
      const body = await response.json();
      if (body?.BaseResponse?.Ret !== 0) throw new Error('WeChat rejected the send');
      const rawId = body.MsgID;
      const id = typeof rawId === 'string' ? rawId
        : Number.isSafeInteger(rawId) && rawId > 0 ? String(rawId) : '';
      if (!/^\d+$/.test(id)) throw new Error('WeChat response has no verifiable message ID');
      resolveReceipt(id);
    } catch { rejectReceipt(new Error('WeChat send receipt could not be verified')); }
  };
  const onClose = () => rejectReceipt(new Error('WeChat page closed before send receipt'));
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('close', onClose);
  let timer;
  try {
    const [, id] = await Promise.race([
      Promise.all([Promise.resolve().then(send), receipt]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('WeChat send receipt timed out; delivery is uncertain')), timeoutMs); }),
    ]);
    return id;
  } catch (error) {
    // A timeout does not cancel chatFactory.sendMessage. Keep this page paused
    // even if the SDK resolves later, so its late request cannot match a new send.
    pausedPages.add(page);
    throw error;
  } finally {
    sendingPages.delete(page);
    clearTimeout(timer);
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('close', onClose);
  }
}
