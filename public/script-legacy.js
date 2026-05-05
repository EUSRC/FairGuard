const screenStatus = document.getElementById('screen-status');
const startCheckBtn = document.getElementById('start-check-btn');
const enterExamBtn = document.getElementById('enter-exam-btn');
const infoForm = document.getElementById('info-form');

const socket = io();
let device;
let sendTransport;

startCheckBtn.addEventListener('click', startScreenShare);
infoForm.addEventListener('input', checkIfReadyToEnter);
infoForm.addEventListener('submit', (e) => {
	e.preventDefault();
	if (enterExamBtn.disabled) return;
	alert('验证通过，准备进入考试系统！');
});

function checkIfReadyToEnter() {
	const isScreenReady = screenStatus.classList.contains('success');
	const isFormValid = infoForm.checkValidity();
	enterExamBtn.disabled = !(isScreenReady && isFormValid);
}

async function startScreenShare() {
	console.log('[调试] 点击了开始检测');
	startCheckBtn.disabled = true;
	startCheckBtn.textContent = '连接中...';
	screenStatus.classList.remove('success', 'failed');

	try {
		const routerRtpCapabilities = await new Promise(resolve => {
			socket.emit('getRouterRtpCapabilities', resolve);
		});

		device = new mediasoupClient.Device(); // mediasoupClient 来自 window 全局变量
		await device.load({
			routerRtpCapabilities
		});

		const transportParams = await new Promise(resolve => {
			socket.emit('createWebRtcTransport', resolve);
		});

		sendTransport = device.createSendTransport(transportParams);

		sendTransport.on('connect', ({
			dtlsParameters
		}, callback, errback) => {
			socket.emit('connectTransport', {
				dtlsParameters
			}, callback);
		});

		sendTransport.on('produce', ({
			kind,
			rtpParameters
		}, callback, errback) => {
			socket.emit('produce', {
				kind,
				rtpParameters
			}, ({
				id
			}) => callback({
				id
			}));
		});

		const stream = await navigator.mediaDevices.getDisplayMedia({
			video: true
		});
		const track = stream.getVideoTracks()[0];
		await sendTransport.produce({
			track
		});

		screenStatus.classList.add('success');
		startCheckBtn.textContent = '检测成功';
		checkIfReadyToEnter();
	} catch (err) {
		screenStatus.classList.add('failed');
		startCheckBtn.disabled = false;
		startCheckBtn.textContent = '重新检测';
		alert('屏幕共享失败：' + err.message);
		console.error(err);
	}
}