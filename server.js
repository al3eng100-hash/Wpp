const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// ===== Sesión persistente =====
// En hosting con disco persistente, apunta DATA_PATH a un volumen persistente.
// En Railway/Render/Fly, monta un volumen y usa /data por ejemplo.
const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, '.wwebjs_auth');

// ===== Carpeta temporal para archivos subidos =====
const uploadDir = path.join(os.tmpdir(), 'whatshack_uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
    dest: uploadDir,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// ===== Middlewares =====
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS manual (sin librería) para que puedas llamarlo desde cualquier origen
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ===== Estado global =====
let client = null;
let isReady = false;
let currentQrDataUrl = null;
let isAuthenticated = false;
let lastQrTimestamp = 0;

// ===== Inicializar cliente =====
function initClient() {
    if (client) {
        try { client.destroy(); } catch (e) {}
        client = null;
    }

    console.log('[WPL] Inicializando cliente...');

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: DATA_PATH }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-zygote',
                '--single-process'
            ],
            // En hosting a veces hay que forzar el path de Chromium
            executablePath: process.env.CHROME_PATH || undefined
        }
    });

    client.on('qr', async (qr) => {
        console.log('[WPL] QR recibido');
        qrcodeTerminal.generate(qr, { small: true });
        try {
            currentQrDataUrl = await qrcode.toDataURL(qr, { width: 500 });
            lastQrTimestamp = Date.now();
        } catch (e) {
            console.error('[WPL] Error generando QR:', e.message);
        }
    });

    client.on('authenticated', () => {
        console.log('[WPL] Autenticado');
        isAuthenticated = true;
    });

    client.on('ready', () => {
        console.log('[WPL] Cliente listo');
        isReady = true;
        currentQrDataUrl = null;
    });

    client.on('auth_failure', (msg) => {
        console.error('[WPL] Fallo de autenticación:', msg);
        isReady = false;
        isAuthenticated = false;
    });

    client.on('disconnected', (reason) => {
        console.log('[WPL] Desconectado:', reason);
        isReady = false;
        isAuthenticated = false;
        currentQrDataUrl = null;
        setTimeout(initClient, 5000);
    });

    client.initialize().catch(err => {
        console.error('[WPL] Error init:', err.message);
        setTimeout(initClient, 10000);
    });
}

initClient();

// ===== ENDPOINTS =====

// Status + QR actual
app.get('/status', (req, res) => {
    res.json({
        success: true,
        loggedIn: isReady,
        authenticated: isAuthenticated,
        qr: isReady ? null : currentQrDataUrl,
        timestamp: lastQrTimestamp
    });
});

// QR directo
app.get('/qr', (req, res) => {
    if (isReady) return res.json({ success: false, error: 'Ya conectado' });
    if (!currentQrDataUrl) return res.status(503).json({ success: false, error: 'QR aún no disponible' });
    res.json({ success: true, qr: currentQrDataUrl });
});

// Lista de chats
app.get('/get-chats', async (req, res) => {
    if (!isReady) return res.status(503).json({ success: false, error: 'Cliente no listo' });
    try {
        const chats = await client.getChats();
        const list = chats.map(c => ({
            id: c.id._serialized,
            name: c.name || c.id.user || 'Sin nombre',
            lastMessage: c.lastMessage ? c.lastMessage.body : '',
            timestamp: c.timestamp || 0,
            unreadCount: c.unreadCount || 0,
            isGroup: !!c.isGroup
        }));
        list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        res.json({ success: true, chats: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Mensajes de un chat
app.get('/get-messages', async (req, res) => {
    if (!isReady) return res.status(503).json({ success: false, error: 'Cliente no listo' });
    const chatId = req.query.id;
    if (!chatId) return res.status(400).json({ success: false, error: 'id requerido' });

    try {
        const chat = await client.getChatById(chatId);
        const msgs = await chat.fetchMessages({ limit: 100 });
        const list = msgs.map(m => ({
            id: m.id._serialized,
            body: m.body || '',
            fromMe: m.fromMe,
            timestamp: m.timestamp,
            type: m.type,
            hasMedia: m.hasMedia,
            from: m.from,
            author: m.author || null
        }));
        res.json({ success: true, messages: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Enviar texto
app.get('/send-message', async (req, res) => {
    if (!isReady) return res.status(503).json({ success: false, error: 'Cliente no listo' });
    const { id, text } = req.query;
    if (!id || !text) return res.status(400).json({ success: false, error: 'id y text requeridos' });

    try {
        await client.sendMessage(id, text);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Enviar media
app.post('/send-media', upload.single('file'), async (req, res) => {
    const cleanup = () => { if (req.file) fs.unlink(req.file.path, () => {}); };

    if (!isReady) { cleanup(); return res.status(503).json({ success: false, error: 'Cliente no listo' }); }

    const chatId = req.body.chatId;
    if (!chatId || !req.file) { cleanup(); return res.status(400).json({ success: false, error: 'chatId y file requeridos' }); }

    try {
        const media = MessageMedia.fromFilePath(req.file.path);
        const opts = {};
        if (req.body.caption) opts.caption = req.body.caption;
        await client.sendMessage(chatId, media, opts);
        cleanup();
        res.json({ success: true });
    } catch (e) {
        cleanup();
        res.status(500).json({ success: false, error: e.message });
    }
});

// Verificar si un número tiene WhatsApp + devolver su ID
app.get('/new-chat', async (req, res) => {
    if (!isReady) return res.status(503).json({ success: false, error: 'Cliente no listo' });
    const phone = (req.query.phone || '').replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ success: false, error: 'phone requerido' });

    try {
        const numberId = await client.getNumberId(phone);
        if (!numberId) return res.status(404).json({ success: false, error: 'Número sin WhatsApp' });
        res.json({ success: true, id: numberId._serialized });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Logout
app.get('/logout', async (req, res) => {
    try {
        if (client) {
            try { await client.logout(); } catch (e) {}
            try { await client.destroy(); } catch (e) {}
        }
        isReady = false;
        isAuthenticated = false;
        currentQrDataUrl = null;
        setTimeout(initClient, 2000);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Health check para hosting
app.get('/', (req, res) => {
    res.json({ service: 'whatshack-server', ok: true, ready: isReady });
});

// ===== Arrancar =====
app.listen(PORT, HOST, () => {
    console.log(`[WPL] Servidor escuchando en http://${HOST}:${PORT}`);
    console.log(`[WPL] DATA_PATH: ${DATA_PATH}`);
    console.log(`[WPL] Uploads:   ${uploadDir}`);
    console.log('[WPL] Esperando conexión de WhatsApp...');
});

// Cierre limpio
process.on('SIGTERM', () => { console.log('[WPL] SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[WPL] SIGINT');  process.exit(0); });
