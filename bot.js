/**
 * ============================================================
 *  TELEGRAM BOT — Tra cứu hàng nhập khẩu
 *  ePort Saigon Newport & eWMS Tân Cảng Warehousing
 * ============================================================
 */

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const { spawnSync } = require('child_process');

const BOT_TOKEN = process.env.BOT_TOKEN || '8998825716:AAHtqiT25SiwvxiUdXywC8qBAYe5CmehT8s';
const PORT      = process.env.PORT || 3000;

// State: lưu session tạm cho từng user (captcha guid, config đang chờ)
const sessions = {};

// ── HTTP helper ────────────────────────────────────────────────
function request(opts, body) {
  return new Promise((resolve, reject) => {
    const useHttp = opts._forceHttp;
    const lib = useHttp ? http : https;
    delete opts._forceHttp;
    const options = { ...opts, rejectUnauthorized: false };
    const req = lib.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, data, raw });
      });
    });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Telegram API helpers ───────────────────────────────────────
async function tgCall(method, params) {
  const body = JSON.stringify(params);
  const res = await request({
    hostname: 'api.telegram.org',
    path    : `/bot${BOT_TOKEN}/${method}`,
    method  : 'POST',
    headers : { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) },
  }, body);
  return res.data;
}

async function sendMsg(chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

async function sendPhoto(chatId, base64, caption = '') {
  // Lưu tạm file ảnh rồi gửi bằng multipart
  const tmpPath = path.join(os.tmpdir(), `captcha_${chatId}.png`);
  fs.writeFileSync(tmpPath, Buffer.from(base64, 'base64'));
  const fileData = fs.readFileSync(tmpPath);
  const boundary = '----BotBoundary' + Date.now();
  const CRLF = '\r\n';

  const head = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}` +
    `${chatId}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="caption"${CRLF}${CRLF}` +
    `${caption}${CRLF}` +
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="photo"; filename="captcha.png"${CRLF}` +
    `Content-Type: image/png${CRLF}${CRLF}`
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const bodyBuf = Buffer.concat([head, fileData, tail]);

  const res = await request({
    hostname: 'api.telegram.org',
    path    : `/bot${BOT_TOKEN}/sendPhoto`,
    method  : 'POST',
    headers : {
      'Content-Type'  : `multipart/form-data; boundary=${boundary}`,
      'Content-Length': bodyBuf.length,
    },
  }, bodyBuf);
  fs.unlinkSync(tmpPath);
  return res.data;
}

// ── Download file từ Telegram ──────────────────────────────────
async function downloadFile(fileId) {
  const info = await tgCall('getFile', { file_id: fileId });
  if (!info.ok) throw new Error('Không lấy được file path');
  const filePath = info.result.file_path;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = https.get(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`,
      { rejectUnauthorized: false },
      res => {
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Download timeout')); });
    req.on('error', reject);
  });
}

// ── Đọc PDF bằng Python ───────────────────────────────────────
function parsePDF(pdfBuffer) {
  const tmpPath = path.join(os.tmpdir(), `an_${Date.now()}.pdf`);
  fs.writeFileSync(tmpPath, pdfBuffer);

  const pyScript = `
import sys, json, re
import pdfplumber

def extract(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        text = ""
        for page in pdf.pages:
            text += (page.extract_text() or "") + "\\n"
    result = {}

    m_cont = re.search(r'CON[Ss]?TAINER\\b.{0,150}?([A-Z]{4}\\d{7})', text, re.IGNORECASE | re.DOTALL)
    if m_cont:
        result['containerNo'] = m_cont.group(1)
    else:
        hbl = result.get('hbl', '')
        mbl = result.get('mbl', '')
        all_iso = re.findall(r'\\b[A-Z]{4}\\d{7}\\b', text)
        filtered = [c for c in all_iso if c != hbl and c != mbl]
        if filtered: result['containerNo'] = filtered[0]

    m = re.search(r'VESSEL\\s*/?\\s*VOYAGE\\s*:?\\s*([A-Z][A-Z0-9 .\\-]+?)\\s*/\\s*([A-Z0-9\\-]+)', text, re.IGNORECASE)
    if m:
        result['vesselName'] = re.sub(r'\\s+', ' ', m.group(1)).strip().upper()
        result['voyage']     = m.group(2).strip().upper()
    else:
        mv = re.search(r'VESSEL\\s*:?\\s*([A-Z][A-Z0-9 .\\-]+)', text, re.IGNORECASE)
        mg = re.search(r'VOYAGE\\s*:?\\s*([A-Z0-9\\-]+)', text, re.IGNORECASE)
        if mv: result['vesselName'] = re.sub(r'\\s+', ' ', mv.group(1)).strip().upper()
        if mg: result['voyage']     = mg.group(1).strip().upper()

    m = re.search(r'\\bHBL\\s*:?\\s*(\\S+)', text, re.IGNORECASE)
    if not m: m = re.search(r'HOUSE\\s*B/?L\\s*(?:NO\\.?)?\\s*:?\\s*(\\S+)', text, re.IGNORECASE)
    if m: result['hbl'] = m.group(1).strip()

    m = re.search(r'\\bMBL\\s*:?\\s*(\\S+)', text, re.IGNORECASE)
    if m: result['mbl'] = m.group(1).strip()

    m = re.search(r'PORT OF DISCHARGE\\s*:\\s*([^\\n]+)', text)
    if m:
        port = m.group(1).strip().upper()
        if 'CAT LAI' in port:      result['siteId'] = 'CTL'
        elif 'HIEP PHUOC' in port: result['siteId'] = 'HPC'
        elif 'TCTT' in port:       result['siteId'] = 'TCTT'
        else:                       result['siteId'] = 'CTL'
        result['portOfDischarge'] = m.group(1).strip()
    if 'siteId' not in result: result['siteId'] = 'CTL'

    m = re.search(r'WAREHOUSE\\s*:\\s*([^\\n]+)', text)
    if m: result['warehouse'] = m.group(1).strip()

    m = re.search(r'ETA\\s*:\\s*(\\d{1,2}/\\d{1,2}/\\d{4})', text)
    if m: result['eta'] = m.group(1).strip()

    return result

try:
    data = extract(sys.argv[1])
    print(json.dumps(data, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

  const candidates = ['python3', 'python', 'py'];
  let result = null;
  for (const cmd of candidates) {
    result = spawnSync(cmd, ['-c', pyScript, tmpPath], { encoding:'utf8', timeout:30000 });
    if (!result.error && result.status === 0) break;
  }
  try { fs.unlinkSync(tmpPath); } catch {}

  if (!result || result.error || result.status !== 0)
    throw new Error('Không chạy được Python/pdfplumber');

  const data = JSON.parse(result.stdout.trim());
  if (data.error) throw new Error(data.error);
  return data;
}

// ── ePort: Tra cứu tàu ────────────────────────────────────────
const EWMS_HEADERS = {
  'Accept'    : 'application/json, text/plain, */*',
  'Language'  : 'vn',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer'   : 'https://ewms.tancangwarehousing.com.vn/',
  'Origin'    : 'https://ewms.tancangwarehousing.com.vn',
};

async function checkVessel(config) {
  const body = JSON.stringify({ siteId: config.siteId, vesselName: config.vesselName });
  const res = await request({
    hostname: 'eport.saigonnewport.com.vn',
    path    : '/ships/Searcher',
    method  : 'POST',
    headers : {
      'Content-Type':'application/json; charset=UTF-8', 'Content-Length':Buffer.byteLength(body),
      'X-Requested-With':'XMLHttpRequest', 'Accept':'application/json, text/plain, */*',
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer':'https://eport.saigonnewport.com.vn/Ships',
      'Origin':'https://eport.saigonnewport.com.vn',
    },
  }, body);
  if (res.status !== 200 || !res.data || res.data.type !== 'success') return null;
  const model = res.data.model || [];
  if (!model.length) return null;
  return model.find(m => (m.IN_OUT_VOYAGE||'').includes(config.voyage)) || model[0];
}

// ── eWMS: Lấy captcha ─────────────────────────────────────────
async function getCaptchaData() {
  const res = await request({
    hostname: 'ewms.tancangwarehousing.com.vn',
    port    : 8010,
    path    : '/gw/kvc/reportagg/api/v1/report/get-captcha-image',
    method  : 'GET',
    headers : EWMS_HEADERS,
  });
  if (res.status !== 200 || !res.data) return null;

  let imgB64 = null, guid = null;
  const scan = (obj, d=0) => {
    if (!obj || typeof obj !== 'object' || d > 5) return;
    for (const [k, v] of Object.entries(obj)) {
      const kl = k.toLowerCase();
      if (typeof v === 'string') {
        if (v.length > 200 && (kl.includes('image')||kl.includes('base64')||kl.includes('img')||kl.includes('data'))) imgB64 = v.replace(/^data:image\/\w+;base64,/, '');
        if ((kl.includes('guid')||kl==='id'||kl.includes('token')) && !guid) guid = v;
      } else if (typeof v === 'object') scan(v, d+1);
    }
  };
  scan(res.data);
  if (!imgB64 && res.raw) {
    const m = res.raw.match(/"([A-Za-z0-9+/]{500,}={0,2})"/);
    if (m) imgB64 = m[1];
  }
  if (!guid && res.raw) {
    const m = res.raw.match(/"(?:guid|captchaGuid|Guid|captchaId)"\s*:\s*"([^"]+)"/i);
    if (m) guid = m[1];
  }
  return imgB64 ? { imgB64, guid: guid||'' } : null;
}

// ── eWMS: Tra cứu kho ─────────────────────────────────────────
async function checkWarehouse(config, captchaCode, captchaGuid) {
  const now = new Date(), from = new Date(now);
  from.setDate(from.getDate() - 10);
  const body = JSON.stringify({
    billNo:config.hbl, captchaCode, captchaGuid:captchaGuid||'',
    containerNo:config.containerNo, customsDeclarationNo:'',
    fromDate:from.toISOString(), masterBookingNo:'', searchType:1, toDate:now.toISOString(),
  });
  const res = await request({
    hostname:'ewms.tancangwarehousing.com.vn', port:8010,
    path:'/gw/kvc/lookup/api/v1/Inventory/consignment-search', method:'POST',
    headers:{...EWMS_HEADERS,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
  }, body);
  if (res.status !== 200 || !res.data) return { error: `HTTP ${res.status}` };
  if (!res.data.isSuccess) {
    const msg = (res.data.message||'').toLowerCase();
    if (msg.includes('captcha')||msg.includes('invalid')||msg.includes('mã'))
      return { captchaError: true };
    return { error: res.data.message || 'Lỗi không rõ' };
  }
  return { data: res.data.data };
}

// ── Build tin nhắn kết quả ────────────────────────────────────
function buildResultMsg(config, trip, whData) {
  const fmt = s => s ? new Date(s).toLocaleString('vi-VN') : '—';
  const ci  = whData?.containersInfo?.[0];
  const lo  = whData?.consignmentsInfo?.[0];
  const isReceived = (ci?.status||'').toLowerCase().includes('hoàn tất') || (lo?.thongBao||'').includes('Nhập kho');
  const now = new Date().toLocaleString('vi-VN');
  const icon = isReceived ? '✅' : '⏳';

  return [
    `${icon} <b>BÁO CÁO HÀNG NHẬP</b>`,
    `🕐 ${now}`,
    '',
    `📄 <b>Bill (HBL):</b> <code>${lo?.billNo || config.hbl}</code>`,
    `📦 <b>Container:</b> <code>${ci?.containerNo || config.containerNo}</code>`,
    `🚢 <b>Tàu / Chuyến:</b> ${ci?.vessel||config.vesselName} / ${ci?.voyage||config.voyage}`,
    `⚓ <b>ATB (Tàu cập):</b> ${trip?.ACTUAL_BERTH_TIME || '—'}`,
    '',
    `🏭 <b>Kho / Cửa:</b> ${ci?.warehouse||'—'} / ${ci?.dockDoor||'—'}`,
    `📅 <b>Hàng vào kho:</b> ${fmt(ci?.receiptAdviceDate)}`,
    `📊 <b>Trạng thái:</b> ${ci?.status || '—'}`,
    `💬 <b>Thông báo:</b> ${lo?.thongBao || '—'}`,
    `⚖️ <b>Trọng lượng:</b> ${lo?.weight ? lo.weight + ' kg' : '—'}`,
    `📦 <b>Số lượng:</b> ${lo?.originalQuantity ? lo.originalQuantity + ' bales' : '—'}`,
    `🛃 <b>Hải quan:</b> ${lo?.msgHQBill || '—'}`,
    '',
    isReceived ? '✅ <b>Hàng đã về kho thành công!</b>' : '⏳ <b>Hàng chưa vào kho — kiểm tra lại sau.</b>',
  ].join('\n');
}

// ── Xử lý từng update từ Telegram ─────────────────────────────
async function handleUpdate(update) {
  const msg    = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  const doc    = msg.document;

  // Lệnh /start hoặc /help
  if (text === '/start' || text === '/help') {
    return sendMsg(chatId,
      '👋 <b>Chào mừng đến với Bot Tra Cứu Hàng Nhập!</b>\n\n' +
      'Cách dùng:\n' +
      '1️⃣ Gửi file <b>PDF Thông Báo Hàng Đến</b> vào đây\n' +
      '2️⃣ Bot tự đọc thông tin tàu, container, bill\n' +
      '3️⃣ Tra cứu ePort + eWMS tự động\n' +
      '4️⃣ Gửi kết quả về cho bạn\n\n' +
      '📎 Hãy gửi file PDF ngay!'
    );
  }

  // Nhận captcha từ user
  if (sessions[chatId] && sessions[chatId].waitingCaptcha && text) {
    const session = sessions[chatId];
    delete sessions[chatId].waitingCaptcha;

    await sendMsg(chatId, '⏳ Đang tra cứu kho...');

    try {
      const result = await checkWarehouse(session.config, text.toUpperCase(), session.captchaGuid);

      if (result.captchaError) {
        // Captcha sai — lấy captcha mới
        await sendMsg(chatId, '❌ Mã captcha không đúng. Đang lấy mã mới...');
        const captcha = await getCaptchaData();
        if (!captcha) return sendMsg(chatId, '❌ Không lấy được captcha. Thử lại sau.');
        sessions[chatId] = { ...session, captchaGuid: captcha.guid, waitingCaptcha: true };
        await sendPhoto(chatId, captcha.imgB64, '🔐 Nhập mã captcha trong ảnh:');
        return;
      }

      if (result.error) return sendMsg(chatId, `❌ Lỗi: ${result.error}`);

      const msg = buildResultMsg(session.config, session.trip, result.data);
      delete sessions[chatId];
      return sendMsg(chatId, msg);

    } catch(e) {
      return sendMsg(chatId, `❌ Lỗi khi tra cứu: ${e.message}`);
    }
  }

  // Nhận file PDF
  if (doc) {
    const mime = doc.mime_type || '';
    if (!mime.includes('pdf') && !doc.file_name?.toLowerCase().endsWith('.pdf')) {
      return sendMsg(chatId, '⚠️ Vui lòng gửi file <b>PDF</b> Thông Báo Hàng Đến.');
    }

    await sendMsg(chatId, '📄 Đang đọc file PDF...');

    try {
      // Download PDF
      const pdfBuffer = await downloadFile(doc.file_id);

      // Parse PDF
      const config = parsePDF(pdfBuffer);
      const missing = [];
      if (!config.vesselName)  missing.push('VESSEL');
      if (!config.voyage)      missing.push('VOYAGE');
      if (!config.containerNo) missing.push('CONTAINER');
      if (!config.hbl)         missing.push('HBL');

      if (missing.length) {
        return sendMsg(chatId,
          `⚠️ Không đọc được: <b>${missing.join(', ')}</b> từ PDF.\n` +
          `Dữ liệu tìm được: ${JSON.stringify(config)}`
        );
      }

      await sendMsg(chatId,
        `✅ <b>Đọc PDF thành công!</b>\n\n` +
        `📄 HBL: <code>${config.hbl}</code>\n` +
        `📦 Container: <code>${config.containerNo}</code>\n` +
        `🚢 Tàu: ${config.vesselName} / ${config.voyage}\n` +
        `📅 ETA: ${config.eta || '—'}\n\n` +
        `⏳ Đang tra cứu tàu trên ePort...`
      );

      // Tra cứu tàu
      const trip = await checkVessel(config);
      if (!trip) {
        return sendMsg(chatId,
          `❌ Không tìm thấy tàu <b>${config.vesselName}</b> trên ePort SNP.\n` +
          `Kiểm tra lại tên tàu hoặc thử lại sau.`
        );
      }

      const atb = trip.ACTUAL_BERTH_TIME;
      if (!atb || !atb.trim()) {
        return sendMsg(chatId,
          `⏳ <b>Tàu chưa cập cảng</b>\n\n` +
          `🚢 ${(trip.VESSELNAME||'').trim()} / ${(trip.IN_OUT_VOYAGE||'').trim()}\n` +
          `📅 ETA: ${config.eta || '—'}\n` +
          `⏸ Chưa có ATB — chưa thể kiểm tra hàng vào kho.`
        );
      }

      await sendMsg(chatId,
        `⚓ Tàu đã cập cảng lúc <b>${atb}</b>\n\n` +
        `⏳ Đang lấy captcha eWMS...`
      );

      // Lấy captcha
      const captcha = await getCaptchaData();
      if (!captcha) return sendMsg(chatId, '❌ Không lấy được captcha từ eWMS. Thử lại sau.');

      // Lưu session
      sessions[chatId] = {
        config,
        trip,
        captchaGuid  : captcha.guid,
        waitingCaptcha: true,
      };

      // Gửi ảnh captcha
      await sendPhoto(chatId, captcha.imgB64, '🔐 Nhập mã captcha trong ảnh để tra cứu kho:');

    } catch(e) {
      return sendMsg(chatId, `❌ Lỗi: ${e.message}`);
    }
  }
}

// ── Webhook server ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const update = JSON.parse(body);
        await handleUpdate(update);
      } catch(e) {
        console.error('handleUpdate error:', e.message);
      }
      res.writeHead(200);
      res.end('OK');
    });
  } else {
    res.writeHead(200);
    res.end('🚢 Import Check Bot đang chạy!');
  }
});

server.listen(PORT, () => {
  console.log(`✅ Bot server đang chạy trên port ${PORT}`);
});
