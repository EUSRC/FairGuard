document.addEventListener('DOMContentLoaded', () => {
    // ==========================================
    // 1. Simulcast 配置
    // ==========================================
    const WEBCAM_SIMULCAST_ENCODINGS = [
        { maxBitrate: 100000, scaleResolutionDownBy: 4.0 },
        { maxBitrate: 300000, scaleResolutionDownBy: 2.0 },
        { maxBitrate: 900000, scaleResolutionDownBy: 1.0 }
    ];

    const SCREEN_SIMULCAST_ENCODINGS = [
        { maxBitrate: 200000, scaleResolutionDownBy: 2.0 },
        { maxBitrate: 1500000, scaleResolutionDownBy: 1.0 }
    ];

    // ==========================================
    // 2. 引导页与加载屏逻辑
    // ==========================================
    const loadingScreen = document.getElementById('loading-screen');
    const wizardContainer = document.getElementById('instruction-wizard');
    const cardRight = document.querySelector('.card-right');
    const authGuide = document.getElementById('authorization-guide');
    const skipWizardBtn = document.getElementById('skip-wizard-btn');

    if (wizardContainer && loadingScreen && cardRight && authGuide) {
        cardRight.classList.add('hidden-on-load');

        setTimeout(() => {
            loadingScreen.style.opacity = '0';
            loadingScreen.addEventListener('transitionend', () => {
                loadingScreen.style.display = 'none';
                wizardContainer.classList.add('active');
                cardRight.classList.remove('hidden-on-load');
                cardRight.classList.add('visible-after-load');
            }, { once: true });
        }, 2000);

        const wizardSteps = wizardContainer.querySelectorAll('.wizard-step');
        const confirmButtons = wizardContainer.querySelectorAll('.wizard-confirm-btn');
        const successOverlay = document.getElementById('success-animation-overlay');
        const successCheckmark = successOverlay.querySelector('.success-checkmark');
        const totalSteps = wizardSteps.length;
        let currentStep = 1;

        const goToStep = (stepNumber) => {
            wizardSteps.forEach(step => step.classList.remove('active'));
            const nextStepElement = wizardContainer.querySelector(`.wizard-step[data-step="${stepNumber}"]`);
            if (nextStepElement) nextStepElement.classList.add('active');
        };

        const endWizard = () => {
            wizardContainer.classList.remove('active');
            authGuide.classList.add('active');
            const reqBtn = document.getElementById('request-webcam');
            if (reqBtn) reqBtn.focus();
        };

        const handleConfirmation = (event) => {
            const currentStepElement = event.target.closest('.wizard-step');
            if (!currentStepElement) return;
            currentStepElement.style.opacity = '0';
            successOverlay.classList.add('visible');
            successCheckmark.classList.add('animate');
            setTimeout(() => {
                successOverlay.classList.remove('visible');
                successCheckmark.classList.remove('animate');
                currentStep++;
                if (currentStep > totalSteps) endWizard();
                else goToStep(currentStep);
            }, 1200);
        };

        if (skipWizardBtn) skipWizardBtn.addEventListener('click', (e) => { e.preventDefault(); endWizard(); });
        confirmButtons.forEach(button => button.addEventListener('click', handleConfirmation));
    }

    // ==========================================
    // 3. 核心业务逻辑
    // ==========================================
    (function () {
        let webcamStream = null, screenStream = null;
        let webcamGranted = false, screenGranted = false;
        let userInfo = null, device = null, sendTransport = null;
        let cameraRecorder = null, screenRecorder = null;
        let examStartTime = null, uploadCompletedCount = 0;
        let currentExamConfig = { studentPreviewMode: 1 }; // 默认
        const socket = io();

        const ui = {
            requestWebcamBtn: document.getElementById('request-webcam'),
            skipWebcamBtn: document.getElementById('skip-webcam'),
            requestScreenBtn: document.getElementById('request-screen'),
            webcamStatus: document.getElementById('webcam-status'),
            screenStatus: document.getElementById('screen-status'),
            nextToInfoBtn: document.getElementById('next-to-info'),
            infoForm: document.getElementById('info-form'),
            enterWaitRoomBtn: document.getElementById('enter-wait-room-btn'),
            backToGuideBtn: document.getElementById('back-to-guide'),
            chatMessages: document.getElementById('chat-messages'),
            messageInput: document.getElementById('message-input'),
            sendButton: document.getElementById('send-button'),
            exitExamBtn: document.getElementById('exit-exam-btn'),

            // 上传相关
            uploadModal: document.getElementById('upload-modal'),
            cameraProgress: document.getElementById('camera-progress'),
            cameraProgressText: document.getElementById('camera-progress-text'),
            screenProgress: document.getElementById('screen-progress'),
            screenProgressText: document.getElementById('screen-progress-text'),
            uploadCompleteMessage: document.getElementById('upload-complete-message'),

            // 预览相关
            cameraPreviewVideo: document.getElementById('camera-preview'),
            videoContainer: document.querySelector('.video-container'),
        };

        function formatFullTimestamp(timestamp) {
            return new Date(timestamp || Date.now()).toLocaleString('zh-CN', { hour12: false });
        }

        const handleBeforeUnload = (event) => { event.preventDefault(); event.returnValue = ''; };

        // --- 1. IndexDB 存储 ---
        const DBManager = {
            db: null,
            init() {
                return new Promise((resolve, reject) => {
                    const request = indexedDB.open('ExamRecordingsDB', 1);
                    request.onerror = (e) => reject('DB Error');
                    request.onsuccess = (e) => { this.db = e.target.result; resolve(); };
                    request.onupgradeneeded = (e) => {
                        const db = e.target.result;
                        if (!db.objectStoreNames.contains('videoChunks')) db.createObjectStore('videoChunks', { autoIncrement: true });
                    };
                });
            },
            addChunk(chunk) {
                return new Promise((resolve) => {
                    if (!this.db) return resolve(null);
                    const tx = this.db.transaction(['videoChunks'], 'readwrite');
                    const request = tx.objectStore('videoChunks').add(chunk);
                    request.onsuccess = (e) => resolve(e.target.result); // Returns ID (Key)
                    request.onerror = () => resolve(null);
                });
            },
            deleteChunk(key) {
                if (!this.db) return;
                const tx = this.db.transaction(['videoChunks'], 'readwrite');
                tx.objectStore('videoChunks').delete(key);
            },
            getAllChunks() {
                return new Promise((resolve, reject) => {
                    if (!this.db) return reject('DB not init');
                    const tx = this.db.transaction(['videoChunks'], 'readonly');
                    const req = tx.objectStore('videoChunks').getAllKeys(); // Get keys to map later if needed, but getAll() is values
                    // We need values. But for recovery we might need keys.
                    // Let's stick to simple getAll() for bulk recovery, but specific deleteChunk for streaming.
                    const valReq = tx.objectStore('videoChunks').getAll();
                    valReq.onsuccess = () => resolve(valReq.result);
                    valReq.onerror = () => reject(valReq.error);
                });
            },
            clearChunks() {
                if (this.db) {
                    const tx = this.db.transaction(['videoChunks'], 'readwrite');
                    tx.objectStore('videoChunks').clear();
                }
            },
            getChunkCount() {
                return new Promise((resolve) => {
                    if (!this.db) return resolve(0);
                    const countRequest = this.db.transaction(['videoChunks'], 'readonly').objectStore('videoChunks').count();
                    countRequest.onsuccess = () => resolve(countRequest.result);
                    countRequest.onerror = () => resolve(0);
                });
            },
            getChunk(key) {
                return new Promise((resolve) => {
                    if (!this.db) return resolve(null);
                    const tx = this.db.transaction(['videoChunks'], 'readonly');
                    const req = tx.objectStore('videoChunks').get(key);
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => resolve(null);
                });
            }
        };

        // --- 1.5 Stream Uploader (流式上传核心) ---
        const StreamUploader = {
            queues: { camera: [], screen: [] },
            activeRecordingIds: { camera: null, screen: null },
            isProcessing: { camera: false, screen: false },

            async start(type, studentInfo) {
                try {
                    const response = await fetch('/api/recording/init', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            studentId: studentInfo.studentId,
                            studentName: studentInfo.name,
                            type: type
                        })
                    });
                    const data = await response.json();
                    if (data.recordingId) {
                        this.activeRecordingIds[type] = data.recordingId;
                        console.log(`[Stream] Started ${type} recording ID: ${data.recordingId}`);
                        return true;
                    }
                } catch (e) {
                    console.error('[Stream] Start failed', e);
                    return false;
                }
            },

            async addChunk(type, blob) {
                // 1. 安全落盘 (Backup)
                const dbKey = await DBManager.addChunk({ type: type, data: blob, timestamp: Date.now() });

                // 2. 加入队列
                // 策略优化：如果DB写入成功，仅存Key (省内存)；如果DB失败(e.g. 空间满)，存Blob (保数据)
                if (dbKey) {
                    this.queues[type].push({ dbKey, retryCount: 0 });
                } else {
                    console.warn('[Stream] DB Write Failed, falling back to memory queue');
                    this.queues[type].push({ blob, dbKey: null, retryCount: 0 });
                }

                // 3. 触发处理
                this.processQueue(type);
            },

            async processQueue(type) {
                if (this.isProcessing[type]) return;
                this.isProcessing[type] = true;

                try {
                    let recordingId = this.activeRecordingIds[type];
                    if (!recordingId) {
                        // 如果还没有ID，尝试重新初始化
                        console.log(`[Stream] No Active ID for ${type}, retrying Init...`);

                        // 重新读取 userInfo (假设它是全局的或者存储在某处，这里直接用全局 userInfo)
                        if (window.userInfo) {
                            const success = await this.start(type, window.userInfo);
                            if (!success) {
                                // 初始化依然失败，稍后重试
                                setTimeout(() => this.processQueue(type), 3000);
                                return;
                            }
                            recordingId = this.activeRecordingIds[type];
                        } else {
                            // 根本没有用户信息，无法初始化，放弃本次轮询
                            return;
                        }
                    }

                    while (this.queues[type].length > 0) {
                        const task = this.queues[type][0];

                        // 获取Blob: 优先看内存(fallback情况)，没有则从DB取
                        let blob = task.blob;
                        if (!blob && task.dbKey) {
                            const chunkRecord = await DBManager.getChunk(task.dbKey);
                            if (chunkRecord) blob = chunkRecord.data;
                        }

                        // 如果取不到Blob (极为罕见可能是被误删)，就只能跳过
                        if (!blob) {
                            console.warn('Chunk data missing for key', task.dbKey);
                            this.queues[type].shift();
                            continue;
                        }

                        try {
                            const res = await fetch(`/api/recording/append/${recordingId}`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'video/webm' },
                                body: blob
                            });

                            if (res.ok) {
                                // 成功：删除本地备份
                                if (task.dbKey) DBManager.deleteChunk(task.dbKey);
                                this.queues[type].shift(); // 移除队列头部
                            } else {
                                throw new Error(`HTTP ${res.status}`);
                            }
                        } catch (err) {
                            console.warn(`[Stream] Upload failed for ${type}:`, err);
                            task.retryCount++;
                            // 失败无限重试（指数退避），保证顺序
                            // 暂停 3秒 ~ 10秒
                            await new Promise(r => setTimeout(r, Math.min(task.retryCount * 1000, 10000)));

                            // 这里不 break，而是会 continue loop re-trying same item
                            // 但是为了避免在这里死循环阻塞主线程太久，我们可以 break 出去，利用 finally 里的重置标志位，
                            // 但由于我们没有外部定时器再次触发 processQueue，所以最好还是在这里等。
                            // 上面的 await setTimeout 已经释放了主线程。
                        }
                    }
                } finally {
                    this.isProcessing[type] = false;
                }
            },

            async stop(type) {
                // 等待队列清空 (简单等待一下，实际生产可能需要更复杂的同步锁)
                // 这里我们直接发送 Finalize，假设最后的队列会继续在后台尝试传完
                // 为了严谨，应该在 UI 上显示 "正在同步最后数据..."

                // 强制再刷一次队列
                if (this.queues[type].length > 0) await this.processQueue(type);

                const rid = this.activeRecordingIds[type];
                if (rid) {
                    await fetch(`/api/recording/finalize/${rid}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ duration: 0 }) // 暂时填0，实际可计算
                    });
                }
                this.activeRecordingIds[type] = null;
            }
        };

        // --- 2. 录制管理器 (适配流式上传) ---
        const RecorderManager = {
            setupAndStart(stream, type) {
                const options = { mimeType: 'video/webm; codecs=vp8', videoBitsPerSecond: type === 'camera' ? 200000 : 1000000 };

                // 1. 启动流式上传会话
                if (userInfo) StreamUploader.start(type, userInfo);

                try {
                    const recorder = new MediaRecorder(stream, options);

                    recorder.ondataavailable = (event) => {
                        if (event.data && event.data.size > 0) {
                            // 直接推送到 StreamUploader
                            StreamUploader.addChunk(type, event.data);
                        }
                    };

                    // 5秒一个分片 (关键配置: 不要太大也不要太小)
                    recorder.start(5000);
                    return recorder;
                } catch (e) {
                    console.error('Recorder Error:', e);
                    return null;
                }
            }
        };

        // --- 3. 上传管理器 (修复显示文件大小) ---
        const Uploader = {
            formatSpeed(bytesPerSecond) {
                if (bytesPerSecond < 1024) return bytesPerSecond + ' B/s';
                else if (bytesPerSecond < 1024 * 1024) return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
                else return (bytesPerSecond / (1024 * 1024)).toFixed(1) + ' MB/s';
            },

            formatSize(bytes) {
                if (bytes === 0) return '0 B';
                const k = 1024;
                const sizes = ['B', 'KB', 'MB', 'GB'];
                const i = Math.floor(Math.log(bytes) / Math.log(k));
                return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
            },

            getCongestionStatus(bytesPerSecond) {
                if (bytesPerSecond < 50 * 1024) return '<span style="color:#ef4444">拥堵</span>';
                if (bytesPerSecond < 200 * 1024) return '<span style="color:#f59e0b">繁忙</span>';
                return '<span style="color:#00e676">流畅</span>';
            },

            downloadLocalBackup(blob, filename, type) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { document.body.removeChild(a); window.URL.revokeObjectURL(url); }, 100);

                const progressTextElement = type === 'camera' ? ui.cameraProgressText : ui.screenProgressText;
                progressTextElement.innerHTML = `<span style="color:#ef4444">上传失败，已自动下载。请手动发给管理员！</span>`;
            },

            async uploadRecordings() {
                if (ui.uploadModal) ui.uploadModal.style.display = 'flex';

                const camLabel = document.querySelector('label[for="camera-progress"]');
                const screenLabel = document.querySelector('label[for="screen-progress"]');
                if (camLabel) camLabel.innerHTML = '加密通道 A (Bio-Stream) 状态:';
                if (screenLabel) screenLabel.innerHTML = '加密通道 B (Desktop-Stream) 状态:';

                const waitTime = Math.floor(Math.random() * 8000) + 2000;
                ui.uploadCompleteMessage.textContent = `正在建立加密隧道... 排队等待中 (${(waitTime / 1000).toFixed(1)}s)`;

                await new Promise(r => setTimeout(r, waitTime));

                ui.uploadCompleteMessage.innerHTML = '<span style="color:#3b82f6"><i class="fas fa-satellite-dish fa-spin"></i> 链路已建立，正在传输加密数据...</span>';

                try {
                    const allChunks = await DBManager.getAllChunks();
                    const cameraChunks = allChunks.filter(c => c.type === 'camera').map(c => c.data);
                    const screenChunks = allChunks.filter(c => c.type === 'screen').map(c => c.data);

                    const uploadsToPerform = (cameraChunks.length > 0 ? 1 : 0) + (screenChunks.length > 0 ? 1 : 0);
                    if (uploadsToPerform === 0) { this.onAllUploadsFinished(); return; }

                    const tasks = [];
                    if (cameraChunks.length > 0) tasks.push(this.uploadFileWithRetry(cameraChunks, 'camera', uploadsToPerform));
                    if (screenChunks.length > 0) tasks.push(this.uploadFileWithRetry(screenChunks, 'screen', uploadsToPerform));

                    await Promise.all(tasks);
                } catch (err) {
                    console.error(err);
                    ui.uploadCompleteMessage.innerHTML = `<span style="color:#ef4444">错误: ${err.message}</span>`;
                }
            },

            async uploadFileWithRetry(chunks, type, totalUploads) {
                const MAX_RETRIES = 3;
                let attempt = 0;

                while (attempt < MAX_RETRIES) {
                    try {
                        await this.doUpload(chunks, type, totalUploads);
                        return;
                    } catch (error) {
                        attempt++;
                        console.warn(`Upload ${type} failed (Attempt ${attempt}):`, error);
                        const progressTextElement = type === 'camera' ? ui.cameraProgressText : ui.screenProgressText;

                        if (attempt >= MAX_RETRIES) {
                            const blob = new Blob(chunks, { type: 'video/webm' });
                            const filename = `${userInfo.studentId}_${type}_BACKUP_${Date.now()}.webm`;
                            this.downloadLocalBackup(blob, filename, type);
                            return;
                        } else {
                            progressTextElement.innerHTML = `<span style="color:#f59e0b">连接中断，3秒后重试 (${attempt}/${MAX_RETRIES})...</span>`;
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    }
                }
            },

            doUpload(chunks, type, totalUploads) {
                return new Promise((resolve, reject) => {
                    const blob = new Blob(chunks, { type: 'video/webm' });
                    // 🔥 立即计算文件大小
                    const fileSizeFormatted = this.formatSize(blob.size);

                    const formData = new FormData();
                    const filename = `${userInfo.studentId}_${type}_${Date.now()}.webm`;

                    formData.append('video', blob, filename);
                    formData.append('userInfo', JSON.stringify(userInfo));
                    formData.append('socketId', socket.id);
                    formData.append('startTime', examStartTime);
                    formData.append('duration', Math.round((Date.now() - examStartTime) / 1000));

                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', '/api/upload-recording', true);

                    const progressElement = type === 'camera' ? ui.cameraProgress : ui.screenProgress;
                    const progressTextElement = type === 'camera' ? ui.cameraProgressText : ui.screenProgressText;

                    const streamName = type === 'camera' ? 'Bio-Stream' : 'Desktop-Stream';

                    let lastLoaded = 0;
                    let lastTime = Date.now();

                    xhr.upload.onprogress = (event) => {
                        if (event.lengthComputable) {
                            const now = Date.now();
                            const diffTime = (now - lastTime) / 1000;

                            if (diffTime > 0.5) {
                                const diffLoaded = event.loaded - lastLoaded;
                                const speedBytes = diffLoaded / diffTime;
                                const speedStr = this.formatSpeed(speedBytes);
                                const congestion = this.getCongestionStatus(speedBytes);

                                const percent = Math.round((event.loaded / event.total) * 100);
                                progressElement.value = percent;

                                // 🔥 这里加上了 (总大小: xxx)
                                progressTextElement.innerHTML = `
                                    <span style="font-family:monospace; font-size:12px;">
                                        [${streamName}] 进度:${percent}% | 速度:${speedStr} | 大小:${fileSizeFormatted}
                                    </span>
                                `;

                                lastLoaded = event.loaded;
                                lastTime = now;
                            }
                        }
                    };

                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) {
                            progressTextElement.innerHTML = `<span style="color:#00e676">[${streamName}] 传输完成 (${fileSizeFormatted})</span>`;
                            this.onUploadFinished(totalUploads);
                            resolve();
                        } else { reject(new Error('HTTP ' + xhr.status)); }
                    };
                    xhr.onerror = () => reject(new Error('Network Error'));
                    xhr.send(formData);
                });
            },

            onUploadFinished(totalUploads) {
                uploadCompletedCount++;
                if (uploadCompletedCount >= totalUploads) this.onAllUploadsFinished();
            },

            onAllUploadsFinished() {
                const durationMs = Date.now() - (examStartTime || Date.now());
                const durationStr = new Date(durationMs).toISOString().substr(11, 8); // format HH:mm:ss

                ui.uploadCompleteMessage.innerHTML = `
                    <div style="text-align:center; padding: 20px;">
                        <i class="fas fa-check-circle" style="color:#00e676; font-size: 3em; margin-bottom: 15px;"></i>
                        <h3 style="color:#00e676; margin:0;">上传成功 / Uploaded</h3>
                        <p style="color:#aaa; margin-top:10px;">本次考核时长: <span style="color:#fff">${durationStr}</span></p>
                        <p style="color:#666; font-size: 0.9em;">您可以随时关闭此页面</p>
                    </div>
                `;
                DBManager.clearChunks();
                if (socket) socket.disconnect();
                // 移除自动刷新
                // setTimeout(() => { ... }, 3000); 
            }
        };

        // --- 4. UI 管理器 (修复预览逻辑 Bug) ---
        const UIManager = {
            showView(viewName) {
                document.querySelectorAll('.view-container').forEach(v => {
                    if (v.id !== 'loading-screen' && v.id !== 'instruction-wizard') v.classList.remove('active');
                });
                const view = document.getElementById(viewName);
                if (view) view.classList.add('active');
            },

            updateDeviceStatus(deviceType, status, message) {
                const statusEl = deviceType === 'webcam' ? ui.webcamStatus : ui.screenStatus;
                statusEl.innerHTML = message;
                statusEl.className = 'status-text';
                if (status === 'granted') statusEl.classList.add('success');
                else if (status === 'denied' || status === 'error') statusEl.classList.add('error');
            },

            checkNextButtonState() {
                const isReady = (webcamGranted) && (screenGranted);
                ui.nextToInfoBtn.disabled = !isReady;
            },

            appendChatMessage(sender, text, timestamp) {
                const div = document.createElement('div');
                div.className = `message`;
                div.dataset.sender = sender === '我' ? 'student' : 'proctor';
                div.innerHTML = `<span class="sender">${sender === '我' ? '我:' : '监考员:'}</span><span class="text">${text}</span><span class="timestamp">${formatFullTimestamp(timestamp)}</span>`;
                ui.chatMessages.appendChild(div);
                ui.chatMessages.scrollTop = ui.chatMessages.scrollHeight;
            },

            updateCameraPreview(stream) {
                // 这里只更新数据源，不控制显示/隐藏
                // 真正的显示逻辑由 updatePreviewState 接管
                this.updatePreviewState();
            },

            // 🔥 核心修复：更健壮的预览状态控制
            updatePreviewState() {
                const mode = currentExamConfig.studentPreviewMode;
                const container = ui.videoContainer;
                const video = ui.cameraPreviewVideo;

                const oldMask = document.getElementById('preview-mask');
                if (oldMask) oldMask.remove();

                // 强制静音，否则不能自动播放
                video.muted = true;

                let targetStream = null;
                let showVideo = false;

                let maskType = 'mask-disabled';
                let maskIcon = 'fa-eye-slash';
                let maskTitle = '预览禁用';
                let maskDesc = '监考端已关闭预览';

                // 模式 0: 禁止
                if (mode === 0) {
                    // 保持默认禁止状态
                }
                // 模式 1 (Cam) & 3 (PiP): 显示摄像头
                else if (mode === 1 || mode === 3) {
                    if (webcamStream) {
                        targetStream = webcamStream;
                        showVideo = true;
                        video.style.transform = 'scaleX(-1)'; // 摄像头镜像
                    } else {
                        maskType = 'mask-skipped';
                        maskIcon = 'fa-camera-slash';
                        maskTitle = '无摄像头信号';
                        maskDesc = '设备未授权或已跳过';
                    }
                }
                // 模式 2: 显示屏幕
                else if (mode === 2) {
                    if (screenStream) {
                        targetStream = screenStream;
                        showVideo = true;
                        video.style.transform = 'none'; // 屏幕不镜像
                    } else {
                        maskType = 'mask-disabled';
                        maskIcon = 'fa-desktop';
                        maskTitle = '等待共享';
                        maskDesc = '尚未开始屏幕共享';
                    }
                }

                if (showVideo && targetStream) {
                    video.style.opacity = '1';
                    // 只有当流变了才重新赋值，防止闪烁
                    if (video.srcObject !== targetStream) {
                        video.srcObject = targetStream;
                        // 必须调用 play
                        video.play().catch(e => console.log('Auto-play blocked:', e));
                    }
                } else {
                    video.style.opacity = '0';
                    const mask = document.createElement('div');
                    mask.id = 'preview-mask';
                    mask.className = `placeholder-mask ${maskType}`;
                    mask.innerHTML = `<i class="fas ${maskIcon}"></i><h3>${maskTitle}</h3><p>${maskDesc}</p>`;
                    container.appendChild(mask);
                }
            }
        };

        // --- 5. WebRTC 管理 ---
        const WebRTCManager = {
            async connectAndProduce() {
                try {
                    const rtpCaps = await new Promise(r => socket.emit('getRouterRtpCapabilities', null, r));
                    device = new window.mediasoupClient.Device();
                    await device.load({ routerRtpCapabilities: rtpCaps });

                    const transportInfo = await new Promise(r => socket.emit('createWebRtcTransport', null, r));
                    sendTransport = device.createSendTransport(transportInfo);

                    sendTransport.on('connect', ({ dtlsParameters }, cb, eb) => {
                        socket.emit('connectTransport', { transportId: sendTransport.id, dtlsParameters }, r => r === 'success' ? cb() : eb(new Error('Transport Error')));
                    });

                    sendTransport.on('produce', ({ kind, rtpParameters, appData }, cb, eb) => {
                        socket.emit('produce', { transportId: sendTransport.id, kind, rtpParameters, appData }, r => r.error ? eb(r.error) : cb({ id: r.id }));
                    });

                    if (webcamStream) {
                        const track = webcamStream.getVideoTracks()[0];
                        await sendTransport.produce({ track, encodings: WEBCAM_SIMULCAST_ENCODINGS, appData: { streamType: 'webcam' } });
                        track.onended = () => socket.emit('stream_stopped', { streamType: 'webcam' });
                    }

                    if (screenStream) {
                        const track = screenStream.getVideoTracks()[0];
                        await sendTransport.produce({ track, encodings: SCREEN_SIMULCAST_ENCODINGS, appData: { streamType: 'screen' } });
                        track.onended = () => {
                            alert('警告：屏幕共享已中断！请立即联系监考。');
                            UIManager.updateDeviceStatus('screen', 'denied', '共享已中断');
                            screenGranted = false;
                            document.getElementById('next-to-info').disabled = true;
                            socket.emit('stream_stopped', { streamType: 'screen' });
                        };
                    }
                    UIManager.showView('exam-interface');
                } catch (e) { alert('连接服务器失败: ' + e.message); }
            }
        };

        // --- 6. 事件绑定 ---
        ui.requestWebcamBtn.addEventListener('click', async () => {
            try {
                webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });

                // 授权后立即尝试预览
                UIManager.updateCameraPreview(webcamStream);

                ui.requestWebcamBtn.disabled = true;
                ui.skipWebcamBtn.disabled = true;
                ui.requestScreenBtn.disabled = false;
                webcamGranted = true;
                document.getElementById('webcam-status').innerHTML = '<span style="color:#00e676"><i class="fas fa-check"></i> 授权成功</span>';

                cameraRecorder = null; // 以前这里直接启动，现在推迟到 join_exam
            } catch (e) {
                alert('授权失败，请检查设备权限');
                // 失败也要刷新一下状态，可能显示占位符
                UIManager.updatePreviewState();
            }
            UIManager.checkNextButtonState();
        });

        ui.skipWebcamBtn.addEventListener('click', () => {
            if (confirm('确认跳过摄像头授权？\n(仅限无设备或特殊许可情况)')) {
                webcamStream = null;
                UIManager.updatePreviewState();

                ui.requestWebcamBtn.disabled = true;
                ui.skipWebcamBtn.disabled = true;
                ui.requestScreenBtn.disabled = false;
                webcamGranted = true;
                document.getElementById('webcam-status').innerHTML = '<span style="color:#f59e0b"><i class="fas fa-forward"></i> 已跳过</span>';
                socket.emit('anonymous_event', { eventType: 'WEBCAM_SKIPPED' });
                UIManager.checkNextButtonState();
            }
        });

        ui.requestScreenBtn.addEventListener('click', async () => {
            try {
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { displaySurface: 'monitor', frameRate: 15 },
                    audio: false
                });

                const track = screenStream.getVideoTracks()[0];
                const settings = track.getSettings();

                if (settings.displaySurface && settings.displaySurface !== 'monitor') {
                    track.stop();
                    screenStream = null;
                    alert('【严重警告】检测到您未共享“整个屏幕”！\n\n为了防止作弊，系统强制要求选择【整个屏幕】(Entire Screen)。\n请重新点击按钮并选择正确的选项。');
                    UIManager.updateDeviceStatus('screen', 'denied', '错误: 未共享整个屏幕');
                    screenGranted = false;
                    UIManager.checkNextButtonState();
                    return;
                }

                // 授权成功后刷新预览（如果模式是仅屏幕，这里会显示）
                UIManager.updatePreviewState();

                ui.requestScreenBtn.disabled = true;
                screenGranted = true;
                document.getElementById('next-to-info').disabled = false;
                document.getElementById('screen-status').innerHTML = '<span style="color:#00e676"><i class="fas fa-check"></i> 授权成功 (全屏)</span>';

                screenRecorder = null; // 推迟启动
                UIManager.checkNextButtonState();

            } catch (e) {
                console.error(e);
                alert('屏幕授权失败或被取消');
                screenGranted = false;
                UIManager.checkNextButtonState();
            }
        });

        ui.nextToInfoBtn.addEventListener('click', () => {
            if (ui.nextToInfoBtn.disabled) return;
            UIManager.showView('info-form-container');
        });

        document.getElementById('info-form').addEventListener('submit', (e) => {
            e.preventDefault();
            examStartTime = Date.now();
            ui.enterWaitRoomBtn.disabled = true; ui.enterWaitRoomBtn.textContent = 'CONNECTING...';

            if (!socket.connected) {
                alert('网络连接异常，请刷新页面');
                ui.enterWaitRoomBtn.disabled = false; return;
            }

            userInfo = {
                class: document.getElementById('class').value,
                studentId: document.getElementById('student-id').value,
                name: document.getElementById('name').value
            };
            localStorage.setItem('exam_user_info', JSON.stringify(userInfo));

            socket.emit('join_exam', userInfo);
            socket.emit('submit_fingerprint', { fingerprint: Fingerprint.collect() });

            // 🔥 核心修复：确保在用户信息就绪后再启动录制和上传
            if (webcamStream) cameraRecorder = RecorderManager.setupAndStart(webcamStream, 'camera');
            if (screenStream) screenRecorder = RecorderManager.setupAndStart(screenStream, 'screen');

            WebRTCManager.connectAndProduce();
            window.addEventListener('beforeunload', handleBeforeUnload);
        });

        document.getElementById('send-button').addEventListener('click', () => {
            const txt = document.getElementById('message-input').value;
            if (txt) {
                socket.emit('send_message_to_proctor', { text: txt });
                UIManager.appendChatMessage('我', txt, new Date());
                document.getElementById('message-input').value = '';
            }
        });
        document.getElementById('message-input').addEventListener('keypress', (e) => { if (e.key === 'Enter') document.getElementById('send-button').click(); });

        ui.exitExamBtn.addEventListener('click', async () => {
            if (confirm('确认结束本次考核？\n\n系统将自动同步剩余数据并结束考试。')) {
                window.removeEventListener('beforeunload', handleBeforeUnload);

                // 停止录制 (会触发最后的 dataavailable)
                if (cameraRecorder && cameraRecorder.state === 'recording') cameraRecorder.stop();
                if (screenRecorder && screenRecorder.state === 'recording') screenRecorder.stop();

                if (webcamStream) webcamStream.getTracks().forEach(t => t.stop());
                if (screenStream) screenStream.getTracks().forEach(t => t.stop());
                if (sendTransport) sendTransport.close();

                // 停止上传服务 (此步骤会 Finalize)
                // 显示一个简单的“正在同步...”遮罩
                if (ui.uploadModal) {
                    ui.uploadModal.style.display = 'flex';
                    ui.uploadCompleteMessage.innerHTML = '正在最后同步剩余数据...';
                }

                await Promise.all([
                    StreamUploader.stop('camera'),
                    StreamUploader.stop('screen')
                ]);

                // 显示完成 UI
                const durationMs = Date.now() - (examStartTime || Date.now());
                const durationStr = new Date(durationMs).toISOString().substr(11, 8);

                ui.uploadCompleteMessage.innerHTML = `
                    <div style="text-align:center; padding: 20px;">
                        <i class="fas fa-check-circle" style="color:#00e676; font-size: 3em; margin-bottom: 15px;"></i>
                        <h3 style="color:#00e676; margin:0;">考试结束 / Finished</h3>
                        <p style="color:#aaa; margin-top:10px;">本次考核时长: <span style="color:#fff">${durationStr}</span></p>
                        <p style="color:#666; font-size: 0.9em;">数据同步已完成，您可以安全关闭此页面。</p>
                    </div>
                `;

                DBManager.clearChunks();
                if (socket) socket.disconnect();
            }
        });

        // --- Socket 监听 ---
        socket.on('exam_config_updated', (cfg) => {
            console.log('Config Update:', cfg);
            currentExamConfig = cfg;
            UIManager.updatePreviewState();
        });
        socket.on('receive_message_from_proctor', (d) => UIManager.appendChatMessage('监考员', d.text, d.timestamp));
        socket.on('disconnect', () => {
            if (ui.uploadModal.style.display !== 'flex') {
                // 不干扰上传过程
            }
        });

        // --- 指纹 ---
        const Fingerprint = {
            getGpuInfo() {
                try { const gl = document.createElement('canvas').getContext('webgl'); if (gl) { const dbg = gl.getExtension('WEBGL_debug_renderer_info'); return { renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) }; } } catch (e) { } return { renderer: 'N/A', vendor: 'N/A' };
            },
            detectVM(gpuRenderer) {
                const r = []; const renderer = gpuRenderer.toLowerCase();
                if (['swiftshader', 'llvmpipe', 'virtualbox', 'vmware'].some(k => renderer.includes(k))) r.push(`WebGL: ${renderer}`);
                if (navigator.deviceMemory && navigator.deviceMemory < 8) r.push(`内存<8GB`);
                if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) r.push(`CPU核心≤2`);
                return r;
            },
            collect() {
                const gpu = this.getGpuInfo();
                const d = { userAgent: navigator.userAgent, platform: navigator.platform, language: navigator.language, screenResolution: `${screen.width}x${screen.height}`, colorDepth: screen.colorDepth, deviceMemoryGb: navigator.deviceMemory || null, cpuCores: navigator.hardwareConcurrency || null, webglRenderer: gpu.renderer, webglVendor: gpu.vendor, timezone: new Date().getTimezoneOffset(), pluginsList: Array.from(navigator.plugins || []).map(p => p.name).join(', ') || 'N/A' };
                d.vmDetectionReasons = this.detectVM(d.webglRenderer);
                return d;
            }
        };

        // Init
        DBManager.init().then(async () => {
            // 崩溃恢复检测
            const count = await DBManager.getChunkCount();
            if (count > 0) {
                if (confirm('⚠️ 警告：检测到您上次考试有未上传的录像数据！\n\n这可能是因为浏览器崩溃或异常退出导致的。\n点击“确定”立即上传恢复数据，否则数据将丢失。')) {
                    const savedInfo = localStorage.getItem('exam_user_info');
                    if (savedInfo) {
                        userInfo = JSON.parse(savedInfo);
                        examStartTime = Date.now(); // 模拟一个时间以供上传命名使用
                        Uploader.uploadRecordings();
                    } else {
                        // 如果没有info，尝试让用户手动输入或使用匿名
                        const sid = prompt('未找到身份信息，请输入您的学号以继续上传:', '');
                        if (sid) {
                            userInfo = { studentId: sid, name: 'Recovered User', class: 'Unknown' };
                            examStartTime = Date.now();
                            Uploader.uploadRecordings();
                        } else {
                            alert('放弃上传，数据将被清理。');
                            DBManager.clearChunks();
                        }
                    }
                } else {
                    if (confirm('您确定要丢弃这些录像吗？此操作不可逆！')) {
                        DBManager.clearChunks();
                    } else {
                        location.reload(); // 重新加载再次询问
                    }
                }
            }
        }).catch(e => console.error(e));
    })();

    if (document.querySelector('.site-footer')) document.querySelector('.site-footer').innerHTML = `&copy; ${new Date().getFullYear()} EuSec. All Rights Reserved.`;
});