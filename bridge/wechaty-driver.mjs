/** SDK adapter only: there is no login protocol or account-session implementation in the app server. */
export async function createWechatyDriver({ name, puppet, qrFile }) {
  const { WechatyBuilder } = await import('wechaty');
  const { default: qrcode } = await import('qrcode-terminal');
  const { default: qrImage } = await import('qrcode');
  const bot = WechatyBuilder.build({ name, puppet });
  let inbound = () => {};
  let stateChanged = () => {};
  let accountId = '';
  bot.on('scan', (value) => {
    void stateChanged('scanning');
    qrcode.generate(value, { small: true });
    if (qrFile) qrImage.toFile(qrFile, value, { width: 360 }).catch(() => console.error('Could not save login QR image'));
    console.log('Scan this QR code with the test WeChat account. Session stays on this device.');
  });
  bot.on('login', (user) => { accountId = user.id; void stateChanged('online', user.id); });
  bot.on('logout', () => { accountId = ''; void stateChanged('offline'); });
  bot.on('error', () => { console.error('Wechaty transport error; no message will be marked sent without a message id'); });
  bot.on('message', async message => {
    try {
      if (message.self() || message.room() || message.type() !== bot.Message.Type.Text) return;
      const talker = message.talker();
      if (!message.id || !talker?.id) return;
      inbound({ event_id: message.id, contact_id: talker.id, nickname: talker.name(), content: message.text(), account_id: accountId });
    } catch { console.error('Failed to normalize inbound WeChat text'); }
  });
  return {
    simulated: false,
    onInbound(callback) { inbound = callback; },
    onState(callback) { stateChanged = callback; },
    start: () => bot.start(),
    stop: () => bot.stop(),
    async send(contactId, text) {
      if (!bot.isLoggedIn) throw new Error('WeChat not logged in');
      const contact = await bot.Contact.find({ id: contactId });
      if (!contact) throw new Error('WeChat contact not found');
      if (!accountId || bot.currentUser.id !== accountId) throw new Error('Logged-in account changed');
      const sent = await contact.say(text);
      if (!sent?.id) throw new Error('WeChat did not return a message id');
      return sent.id;
    },
  };
}
