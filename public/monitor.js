document.addEventListener('DOMContentLoaded', () => {
    const { Device } = window.mediasoupClient;

    // 事件类型汉化映射表
    const EVENT_MAP = {
        'STUDENT_JOIN': '考生进入',
        'STUDENT_LEAVE': '考生离开',
        'STREAM_START': '推流开始',
        'STREAM_STOPPED': '推流结束',
        'WEBCAM_SKIPPED': '跳过摄像头',
        'VM_DETECTION_TRIGGERED': '虚拟机警告',
        'RECORDING_UPLOADED': '录像上传',
        'RECORDING_DELETED': '录像删除',
        'CHAT_MESSAGE': '聊天消息',
        'BROADCAST_MESSAGE': '全员广播'
    };

    const AppState = {
        students: [],
        pageSize: 9,
        currentPage: 1,
        isCruiseMode: false,
        cruiseInterval: 10000,
        cruiseTimer: null,
        currentViewMode: 'pip'
    };

    const UIManager = {
        videoGrid: document.getElementById('video-grid'),
        logList: document.getElementById('event-log'),
        modals: {
            recordings: document.getElementById('recordings-modal'),
            fingerprints: document.getElementById('fingerprint-modal'),
            lightbox: document.getElementById('lightbox-modal'),
            broadcast: document.getElementById('broadcast-modal')
        },
        activeChatStudentId: null,

        init() {
            this.bindEvents();
            const sizeSelect = document.getElementById('grid-size-select');
            AppState.pageSize = parseInt(sizeSelect.value);
            this.updateGridLayout(AppState.pageSize);
            this.renderGrid();
        },

        bindEvents() {
            // 分页
            document.getElementById('prev-page').addEventListener('click', () => { this.stopCruise(); this.changePage(-1); });
            document.getElementById('next-page').addEventListener('click', () => { this.stopCruise(); this.changePage(1); });

            // 视图模式切换
            document.querySelectorAll('.mode-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
                    const btnEl = e.currentTarget;
                    btnEl.classList.add('active');
                    AppState.currentViewMode = btnEl.dataset.mode;
                    this.videoGrid.classList.remove('mode-pip', 'mode-split', 'mode-cam', 'mode-screen');
                    this.videoGrid.classList.add(`mode-${AppState.currentViewMode}`);
                });
            });

            // 考生自显模式
            document.getElementById('student-preview-mode').addEventListener('change', (e) => {
                const mode = parseInt(e.target.value);
                SocketClient.socket.emit('update_exam_config', { studentPreviewMode: mode });
                const modeText = e.target.options[e.target.selectedIndex].text;
                this.addLog(`系统配置: 考生显示模式更新为 [${modeText}]`, 'normal');
            });

            // 网格大小
            document.getElementById('grid-size-select').addEventListener('change', (e) => {
                const newSize = parseInt(e.target.value);
                AppState.pageSize = newSize;
                AppState.currentPage = 1;
                this.updateGridLayout(newSize);
                this.renderGrid();
            });

            // 自动巡航
            document.getElementById('cruise-btn').addEventListener('click', () => this.toggleCruise());
            document.getElementById('cruise-interval').addEventListener('change', (e) => {
                let val = parseInt(e.target.value);
                if (val < 3) val = 3;
                AppState.cruiseInterval = val * 1000;
                if (AppState.isCruiseMode) { this.stopCruise(); this.startCruise(); }
            });

            // 按钮功能
            document.getElementById('show-recordings-btn').addEventListener('click', () => this.loadRecordings());
            document.getElementById('show-fingerprints-btn').addEventListener('click', () => this.loadFingerprints());
            document.getElementById('broadcast-btn').addEventListener('click', () => {
                document.getElementById('broadcast-text').value = '';
                this.modals.broadcast.classList.add('active');
            });
            document.getElementById('confirm-broadcast').addEventListener('click', () => {
                const text = document.getElementById('broadcast-text').value.trim();
                if (text) {
                    SocketClient.broadcast(text);
                    this.modals.broadcast.classList.remove('active');
                    this.addLog(`管理员群发: ${text}`, 'success');
                }
            });

            // 聊天
            document.getElementById('chat-close').addEventListener('click', () => document.getElementById('chat-panel').classList.remove('open'));
            document.getElementById('chat-send').addEventListener('click', () => this.sendChatMessage());
            document.getElementById('chat-input').addEventListener('keypress', e => { if (e.key === 'Enter') this.sendChatMessage(); });

            // 通用关闭
            document.querySelectorAll('.close-button').forEach(btn => btn.addEventListener('click', e => {
                e.target.closest('.modal').classList.remove('active');
                const v = document.getElementById('lightbox-video'); if (v) v.pause();
            }));
        },

        updateGridLayout(size) {
            let cols = 3;
            if (size === 12) cols = 4;
            this.videoGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        },

        toggleCruise() {
            if (AppState.isCruiseMode) this.stopCruise();
            else this.startCruise();
        },

        startCruise() {
            AppState.isCruiseMode = true;
            document.getElementById('cruise-btn').classList.add('active');
            this.addLog('系统: 自动巡航已开启', 'info');
            AppState.cruiseTimer = setInterval(() => {
                const max = Math.ceil(AppState.students.length / AppState.pageSize) || 1;
                if (max > 1) {
                    let n = AppState.currentPage + 1; if (n > max) n = 1;
                    AppState.currentPage = n; this.renderGrid();
                }
            }, AppState.cruiseInterval);
        },

        stopCruise() {
            AppState.isCruiseMode = false;
            document.getElementById('cruise-btn').classList.remove('active');
            if (AppState.cruiseTimer) clearInterval(AppState.cruiseTimer);
            this.addLog('系统: 自动巡航已停止', 'info');
        },

        addLog(msg, type = 'normal') {
            const li = document.createElement('li');
            li.className = type;
            const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
            li.innerHTML = `<span class="time">[${time}]</span> ${msg}`;
            this.logList.prepend(li);
            if (this.logList.children.length > 200) this.logList.lastChild.remove();
        },

        loadHistoryLogs(logs) {
            if (!logs || logs.length === 0) return;
            const fragment = document.createDocumentFragment();
            const marker = document.createElement('li');
            marker.className = 'log-history-marker';
            marker.innerHTML = '<span>以上为实时日志，以下为历史记录</span>';
            fragment.appendChild(marker);

            logs.forEach(log => {
                const li = document.createElement('li');
                // 颜色样式
                if (log.event_type && (log.event_type.includes('VM') || log.event_type.includes('LEAVE'))) li.className = 'warn';
                else if (log.event_type && log.event_type.includes('JOIN')) li.className = 'success';

                const time = new Date(log.event_timestamp).toLocaleTimeString('zh-CN', { hour12: false });
                let msg = this.formatLogMessage(log);
                li.innerHTML = `<span class="time">[${time}]</span> ${msg}`;
                fragment.appendChild(li);
            });
            this.logList.appendChild(fragment);
        },

        // 🔥 核心：日志格式化（汉化）
        formatLogMessage(log) {
            const userStr = log.student_name ? log.student_name : '未知用户';
            const typeStr = EVENT_MAP[log.event_type] || log.event_type; // 映射为中文

            let detailStr = '';
            try {
                if (log.details) {
                    const d = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
                    // 根据不同类型解析 detail
                    if (d.text) detailStr = `: ${d.text}`;
                    if (d.filename) detailStr = ` (文件: ${d.filename})`;
                    if (d.detections) detailStr = ` (异常: ${d.detections.join(', ')})`;
                    if (d.reason) detailStr = ` (${d.reason})`;
                }
            } catch (e) { }

            return `${typeStr} - ${userStr}${detailStr}`;
        },

        updateServerStats(stats) {
            document.getElementById('stat-cpu').innerText = stats.cpu + '%';
            document.getElementById('stat-mem').innerText = stats.mem + '%';
            document.getElementById('stat-users').innerText = stats.activeStudents;
        },

        syncConfig(cfg) {
            if (cfg.studentPreviewMode !== undefined) document.getElementById('student-preview-mode').value = cfg.studentPreviewMode;
        },

        changePage(d) {
            const max = Math.ceil(AppState.students.length / AppState.pageSize) || 1;
            let n = AppState.currentPage + d; if (n > max) n = 1; if (n < 1) n = max;
            AppState.currentPage = n; this.renderGrid();
        },

        renderGrid() {
            this.videoGrid.innerHTML = '';
            const total = AppState.students.length;
            document.getElementById('page-info').textContent = `${AppState.currentPage}/${Math.ceil(total / AppState.pageSize) || 1}`;

            if (total === 0) {
                this.videoGrid.innerHTML = `<div id="empty-grid-placeholder" class="empty-state"><i class="fas fa-satellite-dish fa-spin"></i><h2>正在等待考生接入...</h2></div>`;
                return;
            }

            const start = (AppState.currentPage - 1) * AppState.pageSize;
            const visible = AppState.students.slice(start, start + AppState.pageSize);
            SocketClient.updateStreamStates(visible);

            visible.forEach(s => {
                const div = document.createElement('div');
                div.className = `monitor-card ${s.hasWarning ? 'warning' : ''}`;
                let vmBadge = s.vmDetectionReasons?.length ? `<span class="badge" style="color:var(--danger)">VM</span>` : '';
                let skipBadge = s.webcamSkipped ? `<span class="badge" style="color:var(--warning)">无摄</span>` : '';

                div.innerHTML = `
                    <div class="stream-box screen"><video id="vid-screen-${s.socketId}" autoplay playsinline muted></video></div>
                    <div class="stream-box webcam" id="cam-box-${s.socketId}"><video id="vid-webcam-${s.socketId}" autoplay playsinline muted></video></div>
                    <div class="card-overlay">
                        <div class="info"><div class="name">${s.userInfo.name}</div><div class="meta">${s.userInfo.studentId} | ${s.ip}</div></div>
                        <div class="actions">${vmBadge}${skipBadge}<i class="fas fa-comment chat-btn ${s.unreadMessages ? 'unread' : ''}" id="chat-${s.socketId}"></i></div>
                    </div>
                `;
                div.querySelector(`#chat-${s.socketId}`).addEventListener('click', e => { e.stopPropagation(); this.openChat(s.socketId); });
                this.enableDrag(div.querySelector(`#cam-box-${s.socketId}`), div);

                const screenVid = div.querySelector(`#vid-screen-${s.socketId}`);
                const camVid = div.querySelector(`#vid-webcam-${s.socketId}`);
                screenVid.addEventListener('dblclick', () => this.openLightbox(s, 'screen'));
                camVid.addEventListener('dblclick', () => this.openLightbox(s, 'webcam'));

                this.videoGrid.appendChild(div);
                this.attachStream(s, 'webcam');
                this.attachStream(s, 'screen');
            });
        },

        enableDrag(el, container) {
            let isDown = false, offX, offY;
            el.addEventListener('mousedown', e => { e.preventDefault(); isDown = true; offX = e.clientX - el.offsetLeft; offY = e.clientY - el.offsetTop; el.style.cursor = 'grabbing'; });
            window.addEventListener('mousemove', e => {
                if (!isDown) return;
                let l = e.clientX - offX, t = e.clientY - offY;
                const cw = container.clientWidth, ch = container.clientHeight, ew = el.clientWidth, eh = el.clientHeight;
                if (l < 0) l = 0; if (l + ew > cw) l = cw - ew; if (t < 0) t = 0; if (t + eh > ch) t = ch - eh;
                el.style.left = l + 'px'; el.style.top = t + 'px'; el.style.bottom = 'auto'; el.style.right = 'auto';
            });
            window.addEventListener('mouseup', () => { isDown = false; el.style.cursor = 'grab'; });
        },

        attachStream(s, type) { const el = document.getElementById(`vid-${type}-${s.socketId}`); const str = type === 'webcam' ? s.webcamStream : s.screenStream; if (el && str) { el.srcObject = str; el.play().catch(() => { }); } },

        openChat(sid) {
            const s = AppState.students.find(x => x.socketId === sid); if (!s) return;
            this.activeChatStudentId = sid; s.unreadMessages = 0; this.renderGrid();
            document.getElementById('chat-title').textContent = `与 ${s.userInfo.name} 对话`;
            SocketClient.socket.emit('get_chat_history', { studentId: s.userInfo.studentId }, h => {
                const body = document.getElementById('chat-body'); body.innerHTML = '';
                (h || []).forEach(m => {
                    const d = document.createElement('div'); d.className = `msg-bubble ${m.sender}`;
                    d.innerHTML = `${m.isBroadcast ? '<span style="color:#fbbf24">[全员]</span> ' : ''}${m.text}<span class="msg-time">${new Date(m.time).toLocaleTimeString()}</span>`;
                    body.appendChild(d);
                });
                document.getElementById('chat-panel').classList.add('open'); body.scrollTop = body.scrollHeight;
            });
        },

        sendChatMessage() {
            const i = document.getElementById('chat-input'), t = i.value.trim(); if (!t || !this.activeChatStudentId) return;
            const b = document.getElementById('chat-body'), d = document.createElement('div'); d.className = 'msg-bubble proctor'; d.innerHTML = `${t}<span class="msg-time">...</span>`; b.appendChild(d); b.scrollTop = b.scrollHeight;
            SocketClient.sendMsg(this.activeChatStudentId, t); i.value = '';
        },

        receiveChatMessage(sid, txt) {
            const s = AppState.students.find(x => x.socketId === sid); if (!s) return;
            if (this.activeChatStudentId === sid) {
                const b = document.getElementById('chat-body'), d = document.createElement('div'); d.className = 'msg-bubble student'; d.innerHTML = `${txt}<span class="msg-time">New</span>`; b.appendChild(d); b.scrollTop = b.scrollHeight;
            } else { s.unreadMessages++; this.renderGrid(); this.addLog(`${s.userInfo.name} 发来消息`, 'success'); }
        },

        openLightbox(s, sourceType) {
            const m = this.modals.lightbox;
            const type = sourceType || 'webcam';
            const str = type === 'webcam' ? s.webcamStream : s.screenStream;
            if (!str) return;

            m.classList.add('active');
            document.getElementById('lightbox-video').srcObject = str;
            document.getElementById('lightbox-caption').textContent = `${s.userInfo.name} - ${type === 'webcam' ? '摄像头' : '屏幕'}`;

            if (type === 'webcam' && s.webcamConsumer) {
                this.modals.lightbox.cid = s.webcamConsumer.id;
                SocketClient.setQuality(s.webcamConsumer.id, 2);
            }
        },

        // --- 录像列表 ---
        async loadRecordings() {
            const modal = this.modals.recordings; modal.classList.add('active');
            const body = document.getElementById('recordings-modal-body');
            body.innerHTML = '<div style="text-align:center;color:#aaa;padding:50px"><i class="fas fa-circle-notch fa-spin fa-2x"></i><br><br>加载中...</div>';

            try {
                const res = await fetch('/api/recordings');
                const data = await res.json();

                if (data.length === 0) { body.innerHTML = '<div class="empty-state"><i class="fas fa-film"></i><p>暂无录像记录</p></div>'; return; }

                const grouped = data.reduce((acc, r) => {
                    if (!acc[r.student_id]) acc[r.student_id] = { name: r.student_name, id: r.student_id, list: [] };
                    acc[r.student_id].list.push(r); return acc;
                }, {});

                body.innerHTML = `<div class="rec-grid"></div>`;
                const grid = body.querySelector('.rec-grid');

                Object.values(grouped).forEach(g => {
                    const card = document.createElement('div');
                    card.className = 'rec-card';
                    card.innerHTML = `
                        <i class="fas fa-film card-icon"></i>
                        <div class="card-header">
                            <span class="card-title">${g.name}</span>
                            <span class="card-id">${g.id}</span>
                        </div>
                        <div class="card-body" style="flex:1">
                            <div class="card-row">
                                <span><i class="fas fa-video"></i> 录像数量</span>
                                <span>${g.list.length}</span>
                            </div>
                            <div class="card-row" style="margin-top:5px">
                                <span><i class="fas fa-clock"></i> 最近上传</span>
                                <span>${new Date(g.list[0].created_at).toLocaleTimeString()}</span>
                            </div>
                        </div>
                        <div style="margin-top:15px; text-align:right">
                            <button class="action-button blue small">查看详情 <i class="fas fa-chevron-right"></i></button>
                        </div>
                    `;
                    card.onclick = () => this.renderRecordingDetail(g);
                    grid.appendChild(card);
                });
            } catch (e) { body.innerHTML = '<div style="text-align:center;color:var(--danger)">加载失败</div>'; }
        },

        renderRecordingDetail(group) {
            const body = document.getElementById('recordings-modal-body');
            body.innerHTML = `
                <div style="margin-bottom:20px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border); padding-bottom:15px;">
                    <h3 style="margin:0; color:var(--primary)"><i class="fas fa-user"></i> ${group.name} (${group.id})</h3>
                    <button class="action-button" id="rec-back"><i class="fas fa-arrow-left"></i> 返回列表</button>
                </div>
                <div class="rec-list-container"></div>
            `;
            const listDiv = body.querySelector('.rec-list-container');
            group.list.forEach(r => {
                const isCamera = r.video_filename.includes('camera');
                const row = document.createElement('div');
                row.className = 'rec-list-item';
                const duration = r.duration_seconds ? `${Math.floor(r.duration_seconds / 60)}分${r.duration_seconds % 60}秒` : '未知';
                const size = r.file_size_bytes ? (r.file_size_bytes / 1024 / 1024).toFixed(2) + ' MB' : '--';
                row.innerHTML = `
                    <div style="display:flex; align-items:center; gap:15px; flex:1">
                        <div style="font-size:24px; color:${isCamera ? 'var(--accent)' : 'var(--primary)'}; width:40px; text-align:center">
                            <i class="fas ${isCamera ? 'fa-user-circle' : 'fa-desktop'}"></i>
                        </div>
                        <div>
                            <div style="font-weight:bold; color:#fff; font-size:14px;">${isCamera ? '摄像头录像' : '屏幕录像'}</div>
                            <div style="font-size:12px; color:var(--text-sub); margin-top:2px;">
                                <i class="far fa-clock"></i> ${new Date(r.start_time).toLocaleString()} | 
                                <i class="fas fa-hourglass-half"></i> ${duration} | 
                                <i class="fas fa-save"></i> ${size}
                            </div>
                        </div>
                    </div>
                    <div style="display:flex; gap:10px">
                        <button class="action-button blue" onclick="window.open('/api/play-recording/${r.video_filename}')"><i class="fas fa-play"></i> 播放</button>
                    </div>
                `;
                listDiv.appendChild(row);
            });
            document.getElementById('rec-back').onclick = () => this.loadRecordings();
        },

        // --- 指纹列表 ---
        async loadFingerprints() {
            const modal = this.modals.fingerprints; modal.classList.add('active');
            const body = document.getElementById('fingerprint-modal-body');
            body.innerHTML = '<div style="text-align:center;color:#aaa;padding:50px"><i class="fas fa-fingerprint fa-spin fa-2x"></i><br><br>分析中...</div>';

            try {
                const res = await fetch('/api/fingerprints');
                const data = await res.json();
                body.innerHTML = `<div class="rec-grid"></div>`;
                const grid = body.querySelector('.rec-grid');

                data.forEach(d => {
                    const card = document.createElement('div'); card.className = 'fp-card';
                    let vmWarn = ''; try { if (JSON.parse(d.vm_detection_reasons || '[]').length) vmWarn = '<div class="vm-alert">⚠️ 疑似虚拟机</div>'; } catch (e) { }

                    card.innerHTML = `
                        <i class="fas fa-id-card card-icon" style="color:rgba(255,255,255,0.02)"></i>
                        <div class="card-header">
                            <span class="card-title">${d.student_name}</span>
                            <span class="card-id">${d.student_id || 'ID未知'}</span>
                        </div>
                        <div class="card-body" style="flex:1">
                            <div class="card-row">
                                <span><i class="fas fa-globe"></i> IP地址</span>
                                <span style="font-family:monospace">${d.ip_address}</span>
                            </div>
                            <div class="card-row" style="margin-top:5px">
                                <span><i class="fab fa-windows"></i> 系统</span>
                                <span title="${d.platform}">${d.platform.substring(0, 15)}...</span>
                            </div>
                            ${vmWarn}
                        </div>
                        <div style="margin-top:10px; font-size:11px; color:var(--text-sub); text-align:right">
                            采集时间: ${new Date(d.timestamp).toLocaleString()}
                        </div>
                    `;
                    card.onclick = () => {
                        body.innerHTML = `
                            <div style="margin-bottom:15px"><button class="action-button small" id="fp-back"><i class="fas fa-arrow-left"></i> 返回</button></div>
                            <div style="background:#111; padding:20px; border-radius:8px; border:1px solid #333;">
                                <h3 style="color:var(--primary); margin-top:0">${d.student_name} (${d.student_id})</h3>
                                <div class="fp-detail-list">
                                    <div class="fp-item"><span class="fp-label">浏览器 UA</span><span class="fp-val">${d.user_agent}</span></div>
                                    <div class="fp-item"><span class="fp-label">屏幕分辨率</span><span class="fp-val">${d.screen_resolution} (${d.color_depth}bit)</span></div>
                                    <div class="fp-item"><span class="fp-label">CPU 核心数</span><span class="fp-val">${d.cpu_cores || 'N/A'}</span></div>
                                    <div class="fp-item"><span class="fp-label">设备内存</span><span class="fp-val">${d.device_memory_gb ? d.device_memory_gb + ' GB' : 'N/A'}</span></div>
                                    <div class="fp-item"><span class="fp-label">WebGL渲染器</span><span class="fp-val">${d.webgl_renderer}</span></div>
                                    <div class="fp-item"><span class="fp-label">采集时间</span><span class="fp-val">${new Date(d.timestamp).toLocaleString()}</span></div>
                                </div>
                                ${vmWarn ? '<div style="margin-top:20px; color:var(--danger)"><strong>检测到的异常特征:</strong><br>' + JSON.parse(d.vm_detection_reasons).join('<br>') + '</div>' : ''}
                            </div>
                        `;
                        document.getElementById('fp-back').onclick = () => this.loadFingerprints();
                    };
                    grid.appendChild(card);
                });
            } catch (e) { body.innerHTML = '<div style="text-align:center;color:var(--danger)">加载失败</div>'; }
        }
    };

    const SocketClient = {
        socket: io(),
        init() {
            this.socket.on('connect', () => {
                this.initT();
                this.socket.emit('get_exam_config', (cfg) => UIManager.syncConfig(cfg));
                this.socket.emit('get_initial_logs', (logs) => UIManager.loadHistoryLogs(logs));
                UIManager.addLog('成功连接到服务器', 'success');
            });
            this.socket.on('initial_student_list', l => { AppState.students = l.map(this.norm); UIManager.renderGrid(); });
            this.socket.on('student_joined', d => { if (!AppState.students.find(s => s.socketId === d.socketId)) { AppState.students.push(this.norm(d)); UIManager.renderGrid(); UIManager.addLog(`考生 ${d.userInfo.name} 加入`, 'success'); } });
            this.socket.on('student_left', d => {
                const s = AppState.students.find(x => x.socketId === d.socketId);
                const name = d.name || (s ? s.userInfo.name : d.socketId);
                AppState.students = AppState.students.filter(x => x.socketId !== d.socketId);
                UIManager.renderGrid();
                UIManager.addLog(`考生 ${name} 离开`, 'warn');
            });

            this.socket.on('newProducer', d => {
                const s = AppState.students.find(x => x.socketId === d.socketId);
                if (s && ((d.appData.streamType === 'webcam' && s.webcamConsumer) || (d.appData.streamType === 'screen' && s.screenConsumer))) return;
                WebRTCManager.consume(d);
                UIManager.addLog(`${s ? s.userInfo.name : '未知'} 开启 ${d.appData.streamType === 'webcam' ? '摄像头' : '屏幕'}`, 'normal');
            });

            this.socket.on('student_vm_detected', d => {
                const s = AppState.students.find(x => x.socketId === d.socketId);
                if (s) { s.hasWarning = true; s.vmDetectionReasons = d.reasons; AppState.students = AppState.students.filter(x => x !== s); AppState.students.unshift(s); UIManager.renderGrid(); UIManager.addLog(`⚠️ 发现虚拟机: ${s.userInfo.name}`, 'warn'); }
            });

            this.socket.on('receive_message_from_student', d => UIManager.receiveChatMessage(d.studentSocketId, d.text));
            this.socket.on('server_performance_stats', stats => UIManager.updateServerStats(stats));
            this.socket.on('proctor_config_sync', cfg => UIManager.syncConfig(cfg));
        },
        norm(d) { return { ...d, webcamStream: null, screenStream: null, webcamConsumer: null, hasWarning: false, unreadMessages: 0 }; },
        async initT() { try { const caps = await this.req('getRouterRtpCapabilities'); await WebRTCManager.init(caps); const info = await this.req('createWebRtcTransport'); await WebRTCManager.createRecvTransport(info); this.socket.emit('join_proctor_room'); } catch (e) { console.error(e); } },
        updateStreamStates(visible) { const vIds = new Set(visible.map(s => s.socketId)); AppState.students.forEach(s => { const show = vIds.has(s.socketId);[s.webcamConsumer, s.screenConsumer].forEach(c => { if (c) { if (show && c.paused) { c.resume(); this.socket.emit('consumerResume', { consumerId: c.id }); this.setQuality(c.id, 0); } else if (!show && !c.paused) { c.pause(); } } }); }); },
        setQuality(cid, layer) { this.socket.emit('setConsumerPreferredLayers', { consumerId: cid, spatialLayer: layer }); },
        sendMsg(sid, txt) { this.socket.emit('send_message_to_student', { studentSocketId: sid, text: txt }); },
        broadcast(txt) { this.socket.emit('broadcast_message_to_all_students', { text: txt }); },
        req(type, data) { return new Promise((resolve, reject) => this.socket.emit(type, data, r => r?.error ? reject(r.error) : resolve(r))); }
    };

    const WebRTCManager = {
        device: null, recvTransport: null,
        async init(caps) { this.device = new Device(); await this.device.load({ routerRtpCapabilities: caps }); },
        async createRecvTransport(info) { this.recvTransport = this.device.createRecvTransport(info); this.recvTransport.on('connect', ({ dtlsParameters }, cb, eb) => { SocketClient.socket.emit('connectTransport', { transportId: this.recvTransport.id, dtlsParameters }, r => r === 'success' ? cb() : eb(r)); }); },
        async consume(info) {
            if (!this.recvTransport) return;
            const s = AppState.students.find(x => x.socketId === info.socketId);
            if (!s) return;
            if (info.appData.streamType === 'webcam' && s.webcamConsumer) return;
            if (info.appData.streamType === 'screen' && s.screenConsumer) return;
            try {
                const params = await SocketClient.req('consume', { transportId: this.recvTransport.id, producerId: info.producerId, rtpCapabilities: this.device.rtpCapabilities });
                const consumer = await this.recvTransport.consume(params);
                consumer.pause();
                const stream = new MediaStream([consumer.track]);
                if (info.appData.streamType === 'webcam') { s.webcamStream = stream; s.webcamConsumer = consumer; } else { s.screenStream = stream; s.screenConsumer = consumer; }
                UIManager.renderGrid();
            } catch (e) { console.error(e); }
        }
    };

    UIManager.init();
    SocketClient.init();
});