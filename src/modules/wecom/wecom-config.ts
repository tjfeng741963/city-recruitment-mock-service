export interface WeComConfig {
  corpId: string;
  secret: string;
  token: string;
  aesKey: string;
  openKfId: string;
  deviceCode: string;
}
const fields = {
  corpId: 'REA_WECOM_CORP_ID', secret: 'REA_WECOM_APP_SECRET', token: 'REA_WECOM_CALLBACK_TOKEN',
  aesKey: 'REA_WECOM_ENCODING_AES_KEY', openKfId: 'REA_WECOM_OPEN_KFID',
} as const;
export function wecomConfigurationStatus() {
  return { enabled: process.env.REA_WECOM_ENABLED === 'true', missing: Object.values(fields).filter(k => !process.env[k]?.trim()) };
}
export function readWeComConfig(): WeComConfig | null {
  if (process.env.REA_WECOM_ENABLED !== 'true') return null;
  const status = wecomConfigurationStatus();
  if (status.missing.length) throw new Error(`Missing WeCom configuration: ${status.missing.join(', ')}`);
  const result = Object.fromEntries(Object.entries(fields).map(([key, env]) => [key, process.env[env]!.trim()])) as Omit<WeComConfig, 'deviceCode'>;
  return { ...result, deviceCode: process.env.REA_WECOM_DEVICE_CODE?.trim() || 'wecom-kf-001' };
}
