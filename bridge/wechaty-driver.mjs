import { configureWebNavigation } from './web-navigation.mjs';
import { sendWebTextWithReceipt } from './web-send-receipt.mjs';

/** SDK adapter only: there is no login protocol or account-session implementation in the app server. */
export async function createWechatyDriver({ name, puppet = 'wechaty-puppet-wechat', qrFile }) {
  const { WechatyBuilder } = await import('wechaty');
  const { default: qrcode } = await import('qrcode-terminal');
  const { default: qrImage } = await import('qrcode');
  let selectedPuppet = puppet;
  let webPuppet;
  if (puppet === 'wechaty-puppet-wechat') {
    const { PuppetWeChat } = await import('wechaty-puppet-wechat');
    selectedPuppet = new PuppetWeChat();
    webPuppet = selectedPuppet;
    configureWebNavigation(selectedPuppet.bridge);
  }
  const bot = WechatyBuilder.build({ name, puppet: selectedPuppet });
  let inbound = () => {};
  let stateChanged = () => {};
  let accountId = '';
  let sending = false;
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
      if (sending) throw new Error('A physical WeChat send is already pending');
      sending = true;
      try {
        const boundAccount = accountId;
        if (!bot.isLoggedIn) throw new Error('WeChat not logged in');
        const contact = await bot.Contact.find({ id: contactId });
        if (!contact) throw new Error('WeChat contact not found');
        if (!boundAccount || accountId !== boundAccount || bot.currentUser.id !== boundAccount) throw new Error('Logged-in account changed');
        if (webPuppet) {
          try { return await sendWebTextWithReceipt({ page: webPuppet.bridge.page, accountId: boundAccount, contactId, text, send: () => contact.say(text) }); }
          catch (error) { void stateChanged('offline'); throw error; }
        }
        const sent = await contact.say(text);
        if (!sent?.id) throw new Error('WeChat did not return a message id');
        return sent.id;
      } finally { sending = false; }
    },
  };
}
