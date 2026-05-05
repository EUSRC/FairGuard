const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const session = require('express-session');
const mediasoup = require('mediasoup');
const db = require('./db');
const config = require('./config');
const multer = require('multer');
const os = require('os'); // 用于获取CPU核数

// SSL 证书加载
const privateKey = fs.readFileSync(config.ssl.keyPath, 'utf8');
const certificate = fs.readFileSync(config.ssl.certPath, 'utf8');
const credentials = { key: privateKey, cert: certificate };

// 2. 初始化 Express 和服务器
const app = express();
const httpsServer = https.createServer(credentials, app);
const io = socketIo(httpsServer);
const httpServer = http.createServer(app);

// 3. 配置 Express 中间件
app.set('view engine', 'ejs');
app.set('views', config.paths.viewsDir);
app.set('trust proxy', config.server.trustProxy);

const sessionMiddleware = session({
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: config.session.cookieSecure,
        httpOnly: true,
        maxAge: config.session.maxAge // 8小时
    }
});

app.use(sessionMiddleware);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(config.paths.publicDir));

// 强制 HTTPS 重定向
app.use((req, res, next) => {
    if (config.server.redirectToHttps && !req.secure) return res.redirect(`https://${req.hostname}:${config.server.httpsPort}${req.url}`);
    next();
});

// Multer 存储配置 (处理录像上传)
const recordingStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const recordingsDir = config.paths.recordingsDir;
        try {
            if (!fs.existsSync(recordingsDir)) {
                fs.mkdirSync(recordingsDir, { recursive: true });
            }
            cb(null, recordingsDir);
        } catch (error) {
            console.error('[Multer] 创建录像目录失败:', error);
            cb(error);
        }
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: recordingStorage });

// 4. 定义全局变量 (多核架构)
const workers = [];      // 存储所有 Mediasoup Workers
const routers = [];      // 存储所有 Routers (每个Worker一个)
let nextRouterIndex = 0; // 轮询计数器
const peers = new Map(); // 存储所有在线用户状态
let lastStats = { cpu: 0, mem: 0, uptime: 0 }; // Server performance stats


// Start System Monitoring
setInterval(() => {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // CPU Load (Simple approximation using loadavg)
    const load = os.loadavg()[0]; // 1 minute load average
    const cpus = os.cpus().length;
    const cpuPercent = Math.min(100, (load / cpus) * 100).toFixed(1);

    lastStats = {
        cpu: cpuPercent,
        mem: ((totalMem - freeMem) / totalMem * 100).toFixed(1),
        uptime: process.uptime().toFixed(0),
        activeConnections: peers.size
    };
}, 2000);

// --- 核心配置 (从数据库加载) ---
// studentPreviewMode: 
// 0: 禁止查看 (Hidden)
// 1: 仅摄像头 (Camera Only)
// 2: 仅屏幕 (Screen Only)
// 3: 画中画 (PiP)
let examConfig = {
    studentPreviewMode: 1 // 默认值
};

// 初始化时从数据库读取配置
(async () => {
    try {
        // 确保 system_settings 表存在，否则创建 (兼容旧库)
        await db.query(`CREATE TABLE IF NOT EXISTS system_settings (setting_key varchar(50) PRIMARY KEY, setting_value varchar(255), description varchar(100))`);

        const [rows] = await db.query('SELECT setting_value FROM system_settings WHERE setting_key = "student_preview_mode"');
        if (rows.length > 0) {
            examConfig.studentPreviewMode = parseInt(rows[0].setting_value);
            console.log(`[Config] 从数据库加载配置: studentPreviewMode = ${examConfig.studentPreviewMode}`);
        } else {
            // 插入默认值
            await db.query('INSERT INTO system_settings (setting_key, setting_value, description) VALUES ("student_preview_mode", "1", "考生端画面显示模式")');
        }
    } catch (e) {
        console.error('[Config] 数据库配置加载失败，使用默认值:', e);
    }
})();

// 计算 CPU 占用率的辅助函数
function getCpuUsage() {
    return new Promise((resolve) => {
        const start = os.cpus().map(cpu => cpu.times);
        setTimeout(() => {
            const end = os.cpus().map(cpu => cpu.times);
            let idle = 0, total = 0;
            for (let i = 0; i < start.length; i++) {
                const startT = start[i], endT = end[i];
                for (let type in startT) {
                    const diff = endT[type] - startT[type];
                    total += diff;
                    if (type === 'idle') idle += diff;
                }
            }
            const usage = 100 - Math.round(100 * idle / total);
            resolve(usage);
        }, 1000);
    });
}

// 5. 将 Express Session 共享给 Socket.IO
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// ====================================================================
// ======================= 核心架构辅助函数 =======================
// ====================================================================

// 获取下一个 Router (轮询负载均衡算法)
function getNextRouterIndex() {
    const index = nextRouterIndex;
    nextRouterIndex = (nextRouterIndex + 1) % routers.length;
    return index;
}

// 查找 Producer 所在的 Router Index
function getProducerRouterIndex(producerId) {
    for (const [socketId, peer] of peers.entries()) {
        if (peer.producers.some(p => p.id === producerId)) {
            return peer.routerIndex;
        }
    }
    return -1;
}

async function logEvent(eventType, data = {}) {
    const { socketId, userInfo, ip, details } = data;
    try {
        const sql = `INSERT INTO proctoring_logs (event_type, socket_id, student_name, student_id, student_major, ip_address, details) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        const [result] = await db.query(sql, [eventType, socketId || null, userInfo?.name || null, userInfo?.studentId || null, userInfo?.class || null, ip || null, details ? JSON.stringify(details) : null]);

        const newLogEntry = {
            id: result.insertId,
            event_type: eventType,
            socket_id: socketId || null,
            student_name: userInfo?.name || null,
            student_id: userInfo?.studentId || null,
            student_major: userInfo?.class || null,
            ip_address: ip || null,
            details: details,
            event_timestamp: new Date().toISOString()
        };
        for (const proctor of getProctors()) {
            proctor.socket.emit('new_event_log', newLogEntry);
        }
    } catch (error) {
        console.error(`[数据库日志] 记录事件 '${eventType}' 失败:`, error);
    }
}

async function logProctorActivity(actionType, data = {}) {
    const { proctorId, username, ip, details } = data;
    try {
        const sql = `INSERT INTO proctor_activity_logs (proctor_id, proctor_username, action_type, ip_address, details) VALUES (?, ?, ?, ?, ?)`;
        await db.query(sql, [proctorId || null, username, actionType, ip, details ? JSON.stringify(details) : null]);
    } catch (error) {
        console.error(`[活动日志] 记录监考活动 '${actionType}' 失败:`, error);
    }
}

function getProctors() {
    return Array.from(peers.values()).filter(p => p.role === 'proctor');
}

// 6. 路由与业务逻辑
function checkAuth(req, res, next) {
    if (req.session && req.session.isLoggedIn) return next();
    res.redirect('/login');
}

app.get('/', (req, res) => {
    if (req.session && req.session.isLoggedIn) return res.redirect('/admin');
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    const errorMsg = req.query.error === '1' ? '用户名或密码错误！' : (req.query.error === '2' ? '服务器内部错误' : null);
    res.render('admin-login', { error: errorMsg });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress;
    try {
        const [rows] = await db.query('SELECT * FROM proctors WHERE username = ? AND is_active = TRUE', [username]);
        if (rows.length > 0 && password === rows[0].password) {
            const user = rows[0];
            req.session.isLoggedIn = true;
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.save(async (err) => {
                if (err) return res.redirect('/login?error=2');
                await logProctorActivity('LOGIN_SUCCESS', { proctorId: user.id, username: user.username, ip });
                res.redirect('/admin');
            });
        } else {
            await logProctorActivity('LOGIN_FAIL', { username, ip, details: { reason: 'Invalid credentials' } });
            res.redirect('/login?error=1');
        }
    } catch (error) {
        console.error('[登录失败]', error);
        res.redirect('/login?error=2');
    }
});

app.get('/logout', (req, res) => {
    const { userId, username } = req.session;
    const ip = req.ip || req.connection.remoteAddress;
    req.session.destroy(async () => {
        try {
            if (username) await logProctorActivity('LOGOUT', { proctorId: userId, username, ip });
        } catch (e) { }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/admin', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../views/monitor.html'));
});

// 指纹 API
app.get('/api/fingerprints', checkAuth, async (req, res) => {
    try {
        const [fingerprints] = await db.query('SELECT * FROM student_fingerprints ORDER BY timestamp DESC');
        res.json(fingerprints);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to retrieve fingerprints.' });
    }
});

app.get('/api/fingerprints/:id', checkAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM student_fingerprints WHERE id = ?', [req.params.id]);
        rows.length > 0 ? res.json(rows[0]) : res.status(404).json({ error: 'Fingerprint not found.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve fingerprint details.' });
    }
});

// 录像播放 API (支持 Range 请求)
app.get('/api/play-recording/:filename', checkAuth, (req, res) => {
    const filename = req.params.filename;
    if (filename.includes('..') || filename.includes('/')) return res.status(400).send('Invalid filename.');

    const filePath = path.join(config.paths.recordingsDir, filename);
    fs.stat(filePath, (err, stat) => {
        if (err) return res.status(404).send('File not found.');

        const fileSize = stat.size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;
            const file = fs.createReadStream(filePath, { start, end });
            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': 'video/webm',
            });
            file.pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': fileSize,
                'Content-Type': 'video/webm',
            });
            fs.createReadStream(filePath).pipe(res);
        }
    });
});

app.get('/api/recordings', checkAuth, async (req, res) => {
    try {
        const [recordings] = await db.query('SELECT * FROM recordings ORDER BY start_time DESC');
        res.json(recordings);
    } catch (error) {
        res.status(500).json({ error: 'Failed to retrieve recordings.' });
    }
});

app.delete('/api/recordings/:id', checkAuth, async (req, res) => {
    const { id } = req.params;
    const proctorInfo = req.session;
    try {
        const [rows] = await db.query('SELECT * FROM recordings WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Recording not found.' });

        const { video_filename, student_name, student_id } = rows[0];
        if (video_filename) {
            const filePath = path.join(config.paths.recordingsDir, video_filename);
            fs.access(filePath, fs.constants.F_OK, (err) => {
                if (!err) {
                    fs.unlink(filePath, (unlinkErr) => {
                        if (unlinkErr) console.error('[文件删除失败]', unlinkErr);
                    });
                }
            });
        }

        await db.query('DELETE FROM recordings WHERE id = ?', [id]);
        await logEvent('RECORDING_DELETED', {
            userInfo: { name: student_name, studentId: student_id },
            details: { recordingId: id, filename: video_filename, deletedBy: proctorInfo.username }
        });
        res.status(200).json({ message: 'Recording deleted successfully.' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete recording.' });
    }
});

// --- 流式上传接口 (Streaming APIs) ---

// 1. 初始化录像 (Init)
app.post('/api/recording/init', async (req, res) => {
    try {
        const { studentId, studentName, type } = req.body;
        const filename = `${studentId}_${type}_${Date.now()}.webm`;

        // 确保目录存在
        const recordingsDir = config.paths.recordingsDir;
        if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

        // 创建空文件
        const filePath = path.join(recordingsDir, filename);
        fs.closeSync(fs.openSync(filePath, 'w'));

        const [result] = await db.query(
            `INSERT INTO recordings (student_id, student_name, video_filename, start_time, recording_status, file_size_bytes) VALUES (?, ?, ?, ?, 'recording', 0)`,
            [studentId, studentName, filename, new Date()]
        );

        res.json({ recordingId: result.insertId, filename: filename });
    } catch (error) {
        console.error('[Init Error]', error);
        res.status(500).json({ error: 'Init failed' });
    }
});

// 2. 追加分片 (Append)
// 使用 raw body parser 处理二进制流
app.post('/api/recording/append/:id', express.raw({ type: 'video/webm', limit: '50mb' }), async (req, res) => {
    try {
        const { id } = req.params;
        const chunk = req.body;

        // 查询文件名
        const [rows] = await db.query('SELECT video_filename FROM recordings WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: 'Recording not found' });

        const filename = rows[0].video_filename;
        const filePath = path.join(config.paths.recordingsDir, filename);

        // 追加写入
        // 追加写入
        fs.appendFile(filePath, chunk, async (err) => {
            if (err) {
                console.error('[Append Error] File write failed:', err);
                return res.status(500).json({ error: 'Write failed' });
            }
            // 更新数据库元数据 (可选：为了性能可以减少数据库更新频率，这里每次都更为了数据也实时)
            await db.query('UPDATE recordings SET file_size_bytes = file_size_bytes + ?, end_time = NOW() WHERE id = ?', [chunk.length, id]);
            res.json({ success: true });
        });
    } catch (error) {
        console.error('[Append Error]', error);
        res.status(500).json({ error: 'Append failed' });
    }
});

// 3. 完成录像 (Finalize)
app.post('/api/recording/finalize/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { duration } = req.body; // 秒

        await db.query('UPDATE recordings SET recording_status = "completed", duration_seconds = ? WHERE id = ?', [duration || 0, id]);

        // 日志 (复用之前的逻辑)
        const [rows] = await db.query('SELECT * FROM recordings WHERE id = ?', [id]);
        if (rows.length > 0) {
            const r = rows[0];
            await logEvent('RECORDING_UPLOADED', {
                socketId: r.student_socket_id || 'stream',
                userInfo: { name: r.student_name, studentId: r.student_id },
                details: { filename: r.video_filename, size: (r.file_size_bytes / 1024 / 1024).toFixed(2) + 'MB', mode: 'streaming' }
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('[Finalize Error]', error);
        res.status(500).json({ error: 'Finalize failed' });
    }
});

// 上传录像 API (Legacy - 保留用于兼容旧逻辑或 crash recovery)
app.post('/api/upload-recording', upload.single('video'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send({ message: 'No file' });

        let userInfo = {};
        try { userInfo = JSON.parse(req.body.userInfo); } catch (e) { }

        const peer = peers.get(req.body.socketId);

        // 优先从内存获取 VM 检测结果，如果断开了则可能为空
        const vmReasons = peer ? JSON.stringify(peer.vmDetectionReasons || []) : '[]';

        await db.query(
            `INSERT INTO recordings (student_socket_id, student_name, student_id, student_ip_address, start_time, end_time, duration_seconds, video_filename, recording_status, file_size_bytes, vm_detection_reasons) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                req.body.socketId,
                userInfo.name || 'Unknown',
                userInfo.studentId || 'Unknown',
                req.ip,
                new Date(parseInt(req.body.startTime)),
                new Date(),
                parseInt(req.body.duration) || 0,
                req.file.filename,
                'completed',
                req.file.size,
                vmReasons
            ]
        );

        await logEvent('RECORDING_UPLOADED', {
            socketId: req.body.socketId,
            userInfo: userInfo,
            ip: req.ip,
            details: { filename: req.file.filename, size: (req.file.size / 1024 / 1024).toFixed(2) + 'MB' }
        });

        res.json({ message: 'ok' });
    } catch (e) {
        console.error('[Upload Error]', e);
        res.status(500).json({ message: 'error' });
    }
});

// ====================================================================
// ======================= Socket.IO 核心逻辑 =======================
// ====================================================================

// 在 setupSocketConnection 外部定义一个 Map 来存储清理定时器，防止重连时状态被误删
const cleanupTimeouts = new Map();

function setupSocketConnection(socket) {
    const clientIp = socket.request.headers['x-forwarded-for'] || socket.handshake.address;

    // 负载均衡：轮询分配 Router
    const routerIndex = getNextRouterIndex();
    const router = routers[routerIndex];

    // 初始化 Peer 数据
    peers.set(socket.id, {
        socket,
        routerIndex, // 记录所在的 CPU 核心 (Router)
        transports: [],
        producers: [],
        consumers: [],
        userInfo: null,
        role: null,
        ip: clientIp,
        webcamSkipped: false,
        vmDetectionReasons: []
    });

    // --- 优化后的断开连接逻辑 (支持断线重连) ---
    socket.on('disconnect', async () => {
        const peerId = socket.id;
        // console.log(`[连接] 用户 ${peerId} 断开连接，启动 5秒 缓冲清理...`);

        // 设置一个延时清理任务
        const timeout = setTimeout(async () => {
            const peer = peers.get(peerId);
            if (peer) {
                // console.log(`[连接] 用户 ${peerId} 缓冲超时，执行清理。`);

                // 1. 清理 Mediasoup 资源
                peer.consumers.forEach(c => c.close());
                peer.producers.forEach(p => p.close());
                peer.transports.forEach(t => t.close());

                // 2. 通知监考端
                if (peer.role === 'student') {
                    for (const admin of getProctors()) admin.socket.emit('student_left', {
                        socketId: peerId,
                        name: peer.userInfo ? peer.userInfo.name : 'Unknown'
                    });
                    await logEvent('STUDENT_LEAVE', { socketId: peerId, userInfo: peer.userInfo, ip: peer.ip });
                }

                // 3. 从 Map 中移除
                peers.delete(peerId);
                cleanupTimeouts.delete(peerId);
            }
        }, 5000); // 5秒缓冲期

        cleanupTimeouts.set(peerId, timeout);
    });

    // --- 优化后的加入逻辑 (处理重连) ---
    socket.on('join_exam', async (userInfo) => {
        try {
            // 如果是从断线中恢复，先清除清理定时器
            if (cleanupTimeouts.has(socket.id)) {
                clearTimeout(cleanupTimeouts.get(socket.id));
                cleanupTimeouts.delete(socket.id);
            }

            const peer = peers.get(socket.id);
            if (peer) {
                peer.userInfo = userInfo;
                peer.role = 'student';
                const studentData = {
                    socketId: socket.id,
                    userInfo: peer.userInfo,
                    ip: peer.ip,
                    webcamSkipped: peer.webcamSkipped,
                    vmDetectionReasons: peer.vmDetectionReasons
                };
                for (const proctor of getProctors()) proctor.socket.emit('student_joined', studentData);
                await logEvent('STUDENT_JOIN', { socketId: socket.id, userInfo, ip: peer.ip });

                // 考生加入时，发送当前的显示配置
                socket.emit('exam_config_updated', examConfig);
            }
        } catch (e) {
            console.error('[Socket Error] join_exam:', e);
        }
    });

    // 监考加入逻辑
    socket.on('join_proctor_room', async (_, callback) => {
        try {
            const session = socket.request.session;
            if (!session || !session.isLoggedIn) {
                if (callback) callback({ error: 'Unauthorized' });
                return;
            }
            const peer = peers.get(socket.id);
            if (peer) {
                peer.role = 'proctor';
                peer.userInfo = { name: session.username, id: session.userId };

                await logProctorActivity('JOIN_MONITOR_ROOM', { proctorId: session.userId, username: session.username, ip: peer.ip });

                const studentList = Array.from(peers.values())
                    .filter(p => p.role === 'student' && p.userInfo)
                    .map(p => ({
                        socketId: p.socket.id,
                        userInfo: p.userInfo,
                        ip: p.ip,
                        webcamSkipped: p.webcamSkipped,
                        vmDetectionReasons: p.vmDetectionReasons
                    }));

                // 仅发给当前新加入的监考
                socket.emit('initial_student_list', studentList);
                socket.emit('server_performance_stats', lastStats);
                socket.emit('proctor_config_sync', examConfig);

                // 同步现有的流 (Recovers logic that was accidentally deleted)
                for (const pData of peers.values()) {
                    if (pData.role === 'student' && pData.producers.length > 0) {
                        for (const producer of pData.producers) {
                            socket.emit('newProducer', {
                                socketId: pData.socket.id,
                                producerId: producer.id,
                                kind: producer.kind,
                                appData: producer.appData,
                                userInfo: pData.userInfo
                            });
                        }
                    }
                }

                if (callback) callback({ success: true });
            }
        } catch (e) {
            console.error('[Socket Error] join_proctor_room:', e);
            if (callback) callback({ error: 'Internal Error' });
        }
    });

    // Mediasoup Logic
    socket.on('getRouterRtpCapabilities', (_, cb) => cb(router.rtpCapabilities));

    socket.on('createWebRtcTransport', async (_, cb) => {
        try {
            const transportOptions = {
                initialAvailableOutgoingBitrate: 1000000,
                enableUdp: true, enableTcp: true, preferUdp: true
            };
            if (config.mediasoup.complexNetworkMode) {
                const peerIp = (socket.request.headers['x-forwarded-for'] || socket.handshake.address).replace('::ffff:', '');
                const announcedIp = peerIp.startsWith(config.mediasoup.internalSubnet) ? config.mediasoup.internalIp : config.mediasoup.announcedIp;
                transportOptions.listenIps = [{ ip: config.mediasoup.internalIp, announcedIp: announcedIp }];
            } else {
                transportOptions.listenIps = [{ ip: '0.0.0.0', announcedIp: config.mediasoup.announcedIp }];
            }
            const transport = await router.createWebRtcTransport(transportOptions);
            const peer = peers.get(socket.id);
            if (peer) peer.transports.push(transport);
            cb({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
        } catch (e) { cb({ error: e.message }); }
    });

    socket.on('connectTransport', async ({ transportId, dtlsParameters }, cb) => {
        try {
            const peer = peers.get(socket.id);
            if (peer) await peer.transports.find(t => t.id === transportId).connect({ dtlsParameters });
            cb('success');
        } catch (e) { cb({ error: e.message }); }
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, cb) => {
        try {
            const p = peers.get(socket.id);
            const producer = await p.transports.find(t => t.id === transportId).produce({ kind, rtpParameters, appData });
            p.producers.push(producer);
            for (const admin of getProctors()) admin.socket.emit('newProducer', { socketId: socket.id, producerId: producer.id, kind, appData, userInfo: p.userInfo });

            await logEvent('STREAM_START', { socketId: socket.id, userInfo: p.userInfo, ip: p.ip, details: { streamType: appData.streamType, producerId: producer.id } });

            producer.on('transportclose', () => producer.close());
            cb({ id: producer.id });
        } catch (e) { cb({ error: e.message }); }
    });

    socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, cb) => {
        try {
            const consumerPeer = peers.get(socket.id);
            if (!consumerPeer) return cb({ error: 'Peer not found' });

            const consumerRouter = routers[consumerPeer.routerIndex];
            const transport = consumerPeer.transports.find(t => t.id === transportId);
            if (!transport) return cb({ error: 'Transport not found' });

            const producerRouterIdx = getProducerRouterIndex(producerId);
            if (producerRouterIdx === -1) return cb({ error: 'Producer not found' });

            const producerRouter = routers[producerRouterIdx];
            let pid = producerId;

            // 跨核管道 (Pipe) 逻辑
            if (consumerPeer.routerIndex !== producerRouterIdx) {
                try {
                    const { pipeProducer } = await producerRouter.pipeToRouter({ producerId, router: consumerRouter });
                    pid = pipeProducer.id;
                } catch (e) {
                    pid = producerId;
                    if (!e.message.includes('same id') && !e.message.includes('exists')) console.warn('[Pipe Warning]', e.message);
                }
            }

            if (!consumerRouter.canConsume({ producerId: pid, rtpCapabilities })) return cb({ error: 'Cannot consume' });

            const consumer = await transport.consume({ producerId: pid, rtpCapabilities, paused: true });
            consumerPeer.consumers.push(consumer);
            consumer.on('transportclose', () => consumer.close());
            consumer.on('producerclose', () => { consumer.close(); consumerPeer.consumers = consumerPeer.consumers.filter(c => c.id !== consumer.id); });

            cb({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
        } catch (e) { cb({ error: e.message }); }
    });

    socket.on('consumerResume', async ({ consumerId }, cb) => {
        const c = peers.get(socket.id)?.consumers.find(x => x.id === consumerId);
        if (c) { await c.resume(); cb?.('resumed'); }
    });

    socket.on('setConsumerPreferredLayers', async ({ consumerId, spatialLayer }, cb) => {
        const c = peers.get(socket.id)?.consumers.find(x => x.id === consumerId);
        if (c) { await c.setPreferredLayers({ spatialLayer }); cb?.('success'); }
    });

    // --- Config & Chat & Events ---
    socket.on('get_exam_config', (cb) => cb?.(examConfig));

    socket.on('update_exam_config', async (newCfg) => {
        const p = peers.get(socket.id);
        if (p?.role === 'proctor') {
            examConfig = { ...examConfig, ...newCfg };
            try {
                if (newCfg.studentPreviewMode !== undefined) {
                    await db.query('INSERT INTO system_settings (setting_key, setting_value) VALUES ("student_preview_mode", ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)', [newCfg.studentPreviewMode]);
                }
            } catch (e) { console.error('DB Update Config Error', e); }
            socket.broadcast.emit('exam_config_updated', examConfig);
            socket.broadcast.emit('proctor_config_sync', examConfig);
        }
    });

    socket.on('submit_fingerprint', async ({ fingerprint }) => {
        const p = peers.get(socket.id);
        if (p) {
            p.vmDetectionReasons = fingerprint.vmDetectionReasons;
            await db.query('INSERT INTO student_fingerprints (student_id, student_name, socket_id, ip_address, user_agent, platform, language, screen_resolution, color_depth, device_memory_gb, cpu_cores, webgl_renderer, webgl_vendor, timezone, plugins_list, vm_detection_reasons) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                [p.userInfo.studentId, p.userInfo.name, socket.id, p.ip, fingerprint.userAgent, fingerprint.platform, fingerprint.language, fingerprint.screenResolution, fingerprint.colorDepth, fingerprint.deviceMemoryGb, fingerprint.cpuCores, fingerprint.webglRenderer, fingerprint.webglVendor, fingerprint.timezone, fingerprint.pluginsList, JSON.stringify(fingerprint.vmDetectionReasons)]);
            if (fingerprint.vmDetectionReasons.length) {
                for (const admin of getProctors()) admin.socket.emit('student_vm_detected', { socketId: socket.id, reasons: fingerprint.vmDetectionReasons });
                await logEvent('VM_DETECTION_TRIGGERED', { socketId: socket.id, userInfo: p.userInfo, details: { detections: fingerprint.vmDetectionReasons } });
            }
        }
    });

    socket.on('stream_stopped', async ({ streamType }) => {
        const peer = peers.get(socket.id);
        if (peer?.role === 'student') {
            await logEvent('STREAM_STOPPED', { socketId: socket.id, userInfo: peer.userInfo, ip: peer.ip, details: { streamType } });
            for (const proctor of getProctors()) proctor.socket.emit('student_stream_stopped', { socketId: socket.id, streamType });
        }
    });

    socket.on('anonymous_event', async ({ eventType }) => {
        const peer = peers.get(socket.id);
        if (peer && eventType === 'WEBCAM_SKIPPED') {
            peer.webcamSkipped = true;
            await logEvent('WEBCAM_SKIPPED', { socketId: socket.id, ip: peer.ip, userInfo: peer.userInfo || { name: '未知' }, details: { note: 'Skipped' } });
        } else if (peer) {
            await logEvent(eventType, { socketId: socket.id, ip: peer.ip, userInfo: { name: '未知' } });
        }
    });

    socket.on('send_message_to_proctor', async ({ text }) => {
        const p = peers.get(socket.id);
        await db.query('INSERT INTO chat_messages (student_id, student_name, sender_role, sender_name, message) VALUES (?,?,?,?,?)', [p.userInfo.studentId, p.userInfo.name, 'student', p.userInfo.name, text]);
        await logEvent('CHAT_MESSAGE', { socketId: socket.id, userInfo: p.userInfo, ip: p.ip, details: { text, direction: 'student_to_proctor' } });
        for (const admin of getProctors()) admin.socket.emit('receive_message_from_student', { from: p.userInfo.name, text, studentSocketId: socket.id, studentId: p.userInfo.studentId, timestamp: new Date() });
    });

    socket.on('send_message_to_student', async ({ studentSocketId, text }) => {
        const s = peers.get(studentSocketId); const admin = peers.get(socket.id);
        if (s && admin) {
            await db.query('INSERT INTO chat_messages (student_id, student_name, sender_role, sender_name, message) VALUES (?,?,?,?,?)', [s.userInfo.studentId, s.userInfo.name, 'proctor', admin.userInfo.name, text]);
            await logEvent('CHAT_MESSAGE', { socketId: studentSocketId, userInfo: s.userInfo, ip: s.ip, details: { text, direction: 'proctor_to_student', proctor: admin.userInfo.name } });
            s.socket.emit('receive_message_from_proctor', { from: '监考员', text, timestamp: new Date() });
        }
    });

    socket.on('broadcast_message_to_all_students', async ({ text }) => {
        const admin = peers.get(socket.id);
        await logEvent('BROADCAST_MESSAGE', { userInfo: admin.userInfo, details: { text } });
        for (const p of peers.values()) {
            if (p.role === 'student') {
                p.socket.emit('receive_message_from_proctor', { from: '监考员', text, timestamp: new Date(), isBroadcast: true });
                if (p.userInfo?.studentId) db.query('INSERT INTO chat_messages (student_id, student_name, sender_role, sender_name, message, is_broadcast) VALUES (?,?,?,?,?,1)', [p.userInfo.studentId, p.userInfo.name, 'proctor', admin.userInfo.name, text]);
            }
        }
    });

    socket.on('get_chat_history', async ({ studentId }, cb) => {
        try {
            const [rows] = await db.query('SELECT * FROM chat_messages WHERE student_id = ? ORDER BY created_at ASC', [studentId]);
            cb(rows.map(r => ({ sender: r.sender_role, text: r.message, time: r.created_at, isBroadcast: r.is_broadcast })));
        } catch (e) { cb([]); }
    });

    socket.on('get_initial_logs', async (cb) => {
        try { const [l] = await db.query('SELECT * FROM proctoring_logs ORDER BY event_timestamp DESC LIMIT 200'); cb(l); } catch (e) { cb([]); }
    });
}

// 7. 主启动函数
async function debugDatabaseStartup() {
    console.log(`[数据库] 正在连接 ${config.db.host}:${config.db.port}/${config.db.database} ...`);
    const connection = await db.getConnection();

    try {
        await connection.query('SELECT 1');
        console.log('[数据库] 连接成功');

        const [tables] = await connection.query('SHOW TABLES');
        const tableNames = tables.map(row => Object.values(row)[0]);
        console.log(`[数据库] 成功获取数据表，共 ${tableNames.length} 张: ${tableNames.join(', ') || '无数据表'}`);
    } finally {
        connection.release();
    }
}

async function run() {
    process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
    process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

    try {
        await debugDatabaseStartup();

        const cpuCount = os.cpus().length;
        const numWorkers = Math.max(1, cpuCount - config.mediasoup.reservedCpuCores);
        const finalWorkerCount = Math.min(numWorkers, config.mediasoup.maxWorkers);

        console.log(`[服务器] 检测到 ${cpuCount} 个 CPU 核心，启动 ${finalWorkerCount} 个 Workers。`);
        console.log(`[Mediasoup] WebRTC 监听 0.0.0.0，对客户端公告地址 ${config.mediasoup.announcedIp}`);

        const mediaCodecs = [
            { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
            { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
            { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } }
        ];

        for (let i = 0; i < finalWorkerCount; i++) {
            const workerMinPort = config.mediasoup.basePort + (i * config.mediasoup.portsPerWorker);
            const workerMaxPort = workerMinPort + config.mediasoup.portsPerWorker - 1;
            const worker = await mediasoup.createWorker({
                logLevel: 'warn',
                logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
                rtcMinPort: workerMinPort,
                rtcMaxPort: workerMaxPort,
            });
            worker.on('died', () => process.exit(1));
            const router = await worker.createRouter({ mediaCodecs });
            workers.push(worker);
            routers.push(router);
        }

        io.on('connection', setupSocketConnection);

        httpsServer.listen(config.server.httpsPort, () => {
            console.log(`[服务器] HTTPS 服务运行在 https://0.0.0.0:${config.server.httpsPort}`);
        });

        httpServer.listen(config.server.httpPort, () => {
            console.log(`[服务器] HTTP 服务运行在 http://0.0.0.0:${config.server.httpPort}`);
        });

        // 性能监控
        setInterval(async () => {
            try {
                const cpu = await getCpuUsage();
                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const memUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
                const activeStudents = Array.from(peers.values()).filter(p => p.role === 'student').length;
                const maxCap = activeStudents > 0 && cpu > 5 ? Math.round(activeStudents / (cpu / 80)) : '--';
                const stats = { cpu, mem: memUsage, activeStudents, maxCap };
                for (const peer of peers.values()) {
                    if (peer.role === 'proctor') peer.socket.emit('server_performance_stats', stats);
                }
            } catch (e) { }
        }, 3000);

    } catch (err) {
        console.error('[服务器] 启动失败:', err);
        process.exit(1);
    }
}

run();