/**
 * Chạy 1 lần sau khi deploy để đăng ký webhook:
 * node setup-webhook.js <RAILWAY_URL>
 * Ví dụ: node setup-webhook.js https://import-check-bot.up.railway.app
 */
const https = require('https');

const BOT_TOKEN   = process.env.BOT_TOKEN || '8998825716:AAHtqiT25SiwvxiUdXywC8qBAYe5CmehT8s';
const RAILWAY_URL = process.argv[2];

if (!RAILWAY_URL) {
  console.error('❌ Thiếu URL. Dùng: node setup-webhook.js https://your-app.up.railway.app');
  process.exit(1);
}

const webhookUrl = `${RAILWAY_URL}/webhook`;
const body = JSON.stringify({ url: webhookUrl });

const req = https.request({
  hostname: 'api.telegram.org',
  path    : `/bot${BOT_TOKEN}/setWebhook`,
  method  : 'POST',
  headers : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
}, res => {
  let raw = '';
  res.on('data', c => raw += c);
  res.on('end', () => {
    const d = JSON.parse(raw);
    if (d.ok) {
      console.log(`✅ Webhook đã được đăng ký thành công!`);
      console.log(`   URL: ${webhookUrl}`);
    } else {
      console.error('❌ Lỗi:', raw);
    }
  });
});
req.on('error', e => console.error('❌', e.message));
req.write(body);
req.end();
