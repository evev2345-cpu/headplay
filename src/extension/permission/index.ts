import { BackgroundMessage } from '../../shared/messages';

const requestBtn = document.getElementById('requestBtn') as HTMLButtonElement;
const startAndCloseBtn = document.getElementById('startAndCloseBtn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;

const params = new URLSearchParams(window.location.search);
const autoStartRequested = params.get('autoStart') === '1';

function setStatus(text: string, variant?: 'ok' | 'err'): void {
  statusEl.textContent = text;
  statusEl.className = variant ?? '';
}

async function sendBg<T = unknown>(msg: BackgroundMessage): Promise<T> {
  return (await chrome.runtime.sendMessage(msg)) as T;
}

async function checkCurrentPermission(): Promise<void> {
  if (!navigator.permissions?.query) {
    setStatus('권한 상태를 자동 조회할 수 없습니다. 아래 버튼을 눌러 권한을 요청해 주세요.');
    return;
  }

  try {
    const result = await navigator.permissions.query({ name: 'camera' as PermissionName });
    if (result.state === 'granted') {
      setStatus('카메라 권한이 이미 허용되어 있습니다. 바로 트래킹을 시작할 수 있습니다.', 'ok');
      startAndCloseBtn.hidden = false;
    } else if (result.state === 'denied') {
      setStatus(
        '카메라 권한이 차단되어 있습니다. Chrome 주소창 왼쪽 아이콘(사이트 설정)에서 카메라를 "허용"으로 변경해 주세요.',
        'err',
      );
    } else {
      setStatus('아직 카메라 권한이 설정되지 않았습니다. "카메라 권한 요청" 버튼을 클릭해 주세요.');
    }
  } catch {
    setStatus('아래 버튼을 클릭해 카메라 권한을 허용해 주세요.');
  }
}

async function requestCameraPermission(): Promise<void> {
  requestBtn.disabled = true;
  setStatus('브라우저 카메라 권한 프롬프트를 기다리는 중...');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    // Release camera immediately after confirming permission so Offscreen Document can open it cleanly.
    for (const track of stream.getTracks()) {
      track.stop();
    }

    setStatus('카메라 권한이 허용되었습니다!', 'ok');
    startAndCloseBtn.hidden = false;

    const res = await sendBg<{ ok: boolean; error?: string }>({
      target: 'background',
      type: 'PERMISSION_GRANTED',
      autoStart: autoStartRequested,
    });

    if (autoStartRequested && res?.ok) {
      setStatus('권한 허용 및 백그라운드 트래킹이 시작되었습니다. 이 탭을 닫아도 계속 동작합니다.', 'ok');
    }
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    setStatus(
      `카메라 권한 요청 실패 (${message}). 브라우저 사이트 설정에서 카메라 허용 상태를 확인해 주세요.`,
      'err',
    );
    await sendBg({
      target: 'background',
      type: 'PERMISSION_DENIED',
      message,
    });
  } finally {
    requestBtn.disabled = false;
  }
}

requestBtn.addEventListener('click', () => {
  void requestCameraPermission();
});

startAndCloseBtn.addEventListener('click', () => {
  void (async () => {
    startAndCloseBtn.disabled = true;
    const res = await sendBg<{ ok: boolean; error?: string }>({
      target: 'background',
      type: 'START_TRACKING',
    });
    if (res?.ok) {
      window.close();
    } else {
      startAndCloseBtn.disabled = false;
      setStatus(`트래킹 시작 실패: ${res?.error ?? 'Unknown error'}`, 'err');
    }
  })();
});

void checkCurrentPermission();
