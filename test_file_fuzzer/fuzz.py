import asyncio
import random
import psutil
from playwright.async_api import async_playwright

# 配置参数
TARGET_URL = 'https://192.168.100.111:19001' 
STUDENT_COUNT = 15
MIN_DURATION = 180
MAX_DURATION = 600
MAX_CPU_USAGE = 85
MAX_MEM_USAGE = 90

async def wait_for_system_cooldown(student_id):
    while True:
        cpu = psutil.cpu_percent(interval=0.5)
        mem = psutil.virtual_memory().percent
        
        if cpu < MAX_CPU_USAGE and mem < MAX_MEM_USAGE:
            return
        
        print(f"[系统告警] CPU:{cpu}% 内存:{mem}% -> 负载过高，暂停启动 {student_id}号，等待冷却...")
        await asyncio.sleep(3)

async def run_student_lifecycle(p, student_id, is_permanent=False):
    browser = None
    try:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                '--ignore-certificate-errors',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--allow-insecure-localhost',
                f'--unsafely-treat-insecure-origin-as-secure={TARGET_URL}',
                '--disable-gpu', 
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-setuid-sandbox',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote'
            ]
        )

        context = await browser.new_context(
            ignore_https_errors=True,
            permissions=['camera', 'microphone']
        )
        
        page = await context.new_page()

        await page.add_init_script("""
            const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getDisplayMedia = async (constraints) => {
                const stream = await originalGetDisplayMedia(constraints);
                const track = stream.getVideoTracks()[0];
                const originalGetSettings = track.getSettings.bind(track);
                track.getSettings = () => {
                    const settings = originalGetSettings();
                    settings.displaySurface = 'monitor'; 
                    return settings;
                };
                return stream;
            };
        """)

        page.on("dialog", lambda dialog: dialog.accept())

        await page.goto(TARGET_URL)

        try:
            skip = await page.wait_for_selector('#skip-wizard-btn', state='visible', timeout=2000)
            if skip: await skip.click()
        except: pass

        await page.click('#request-webcam')
        await asyncio.sleep(0.2)
        await page.click('#request-screen')
        await asyncio.sleep(0.2)

        await page.wait_for_function("!document.getElementById('next-to-info').disabled", timeout=5000)
        await page.click('#next-to-info')
        
        await page.wait_for_selector('#student-id', state='visible')
        s_id = f"AUTO_{student_id:03d}"
        await page.fill('#student-id', s_id)
        await page.fill('#name', f"压测_{student_id}")
        await page.fill('#class', '抗压班')

        await page.click('#enter-wait-room-btn')
        
        try:
            await page.wait_for_selector('#exam-interface.active', timeout=60000)
            print(f"[{student_id}号] 入场成功")
        except:
            print(f"[{student_id}号] UI未切换，但可能已连接")

        if is_permanent:
            print(f"[{student_id}号] 守护进程 (不退)")
            while True: await asyncio.sleep(3600)
        else:
            duration = random.randint(MIN_DURATION, MAX_DURATION)
            await asyncio.sleep(duration)

            print(f"[{student_id}号] 准备退出...")
            await page.click('#exit-exam-btn')
            
            try:
                await page.wait_for_function(
                    "document.getElementById('upload-complete-message').innerText.includes('关闭') || document.getElementById('upload-complete-message').innerText.includes('完成')",
                    timeout=90000
                )
                print(f"[{student_id}号] 上传完毕")
            except:
                print(f"[{student_id}号] 上传超时")

    except Exception as e:
        print(f"[{student_id}号] 错误: {str(e).splitlines()[0]}")
    
    finally:
        if browser: await browser.close()

async def main():
    async with async_playwright() as p:
        print(f"智能压测启动 | 目标: {TARGET_URL} | 计划并发: {STUDENT_COUNT}")
        print(f"温控阈值: CPU > {MAX_CPU_USAGE}% 或 内存 > {MAX_MEM_USAGE}% 时暂停启动")
        
        tasks = []
        
        for i in range(1, STUDENT_COUNT + 1):
            await wait_for_system_cooldown(i)
            
            is_perm = (i == 1)
            
            base_delay = random.uniform(1.0, 3.0) if i < 5 else random.uniform(3.0, 6.0)
            await asyncio.sleep(base_delay)
            
            print(f"[{i}号] 启动浏览器实例...")
            task = asyncio.create_task(run_student_lifecycle(p, i, is_perm))
            tasks.append(task)

        print("所有任务已派发，正在运行中...")
        await asyncio.gather(*tasks)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n停止")