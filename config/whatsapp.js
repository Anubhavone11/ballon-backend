// config/whatsapp.js
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const whatsappClient = new Client({
  authStrategy: new LocalAuth(), 
  puppeteer: {
    // 🛠️ ADD HEADLESS FALSE FOR TESTING (This opens a visible Chrome window so you can see what's wrong)
    headless: false, 
    args: ['--no-sandbox', '--disable-setuid-sandbox'], 
  }
});

whatsappClient.isReady = false;

whatsappClient.on('qr', (qr) => {
  whatsappClient.isReady = false;
  console.log('\n==================================================================');
  console.log('▼ SCAN THIS QR CODE WITH YOUR WHATSAPP APP TO CONNECT YOUR TESTING BED ▼');
  qrcode.generate(qr, { small: true });
  console.log('==================================================================\n');
});

whatsappClient.on('ready', () => {
  whatsappClient.isReady = true; 
  console.log('✅ Free WhatsApp Web Automation Gateway Connected & Ready!');
});

// 🛠️ Log authorization failures or disconnections
whatsappClient.on('auth_failure', (msg) => {
  console.error('❌ WhatsApp Auth Failure, clearing session...', msg);
});

whatsappClient.on('disconnected', (reason) => {
  console.log('❌ WhatsApp Client was disconnected:', reason);
  whatsappClient.isReady = false;
});

whatsappClient.initialize().catch(err => console.error("Initialization error:", err));

module.exports = whatsappClient;
