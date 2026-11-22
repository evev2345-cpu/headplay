# HEADPLAY Phase 1 — 설계 결정 기록 및 검증 가이드

## 1. 주요 설계 결정 기록 (ADR 요약)

1. **Offscreen Document (`USER_MEDIA`) + `MediaStreamTrackProcessor` 주 파이프라인**
   - **결정**: `requestAnimationFrame()` 대신 `MediaStreamTrackProcessor`의 `ReadableStream<VideoFrame>`으로 이벤트 기반 프레임을 수신하고, 재사용 `320×240` `<canvas>`에 복사한 즉시 `videoFrame.close()`를 호출한다.
   - **Canvas 가속 최적화**: `delegate: 'GPU'`일 때는 `willReadFrequently: false`로 GPU 가속 2D 캔버스를 유지하고, `delegate: 'CPU'`(또는 런타임 CPU 폴백)일 때만 `willReadFrequently: true`로 전환해 불필요한 GPU↔CPU 리드백 왕복을 피한다.
   - **성능 분리 계측**: 프레임당 `blitMs`(`drawImage`)와 `inferMs`(`detectForVideo`)를 분리 집계한다.

2. **MediaPipe WASM 및 모델 100% 로컬 번들링**
   - **결정**: `@mediapipe/tasks-vision`의 `wasm/*` 및 `face_landmarker.task` 모델을 `dist/vendor/mediapipe/`에 로컬 번들링하고 `chrome.runtime.getURL()`로만 로드한다. `manifest.json`에는 `'wasm-unsafe-eval'`만 허용한다.

3. **고개 회전(Head Yaw)과 안구 시선 분리**
   - **결정**: `FaceLandmarker`의 `outputFacialTransformationMatrixes: true`로 4×4 변환 행렬을 수신해 `headYawDeg`를 산출한다(행렬 미제공 시 코끝/양 볼 랜드마크 비대칭 비율로 폴백).
   - `headYawGateEnabled === true`이고 `|headYawDeg| > headYawMaxDeg`(초기값 22°)이면 시선을 `UNKNOWN`으로 마스킹하고 EMA를 갱신하지 않아 고개 회전으로 인한 좌/우 시선 오판을 억제한다.

4. **실제 창 상태(`chrome.windows.getAll()`) 기반 최소화 vs 포커스 상실 구분**
   - **결정**: `chrome.windows.onFocusChanged`의 `windowId`만으로 최소화를 추정하지 않고, `onFocusChanged`, `onBoundsChanged`, `onRemoved` 및 트래킹 시작 시점에 항상 `chrome.windows.getAll()`을 조회해 `classifyWindowVisibility()`로 판별한다.
   - **상태 구분**:
     - `CHROME_ALL_MINIMIZED`: 열려 있는 모든 Chrome 창의 `state === 'minimized'`일 때만 부여
     - `CHROME_UNFOCUSED_VISIBLE`: 포커스는 잃었으나 최소 1개 Chrome 창이 보이는 상태(`state !== 'minimized'`)
     - `CHROME_FOCUSED`: 보이는 Chrome 창 중 하나 이상이 `focused === true`

5. **2계층 0 FPS 동결·중단 감지 및 관측 한계 명시**
   - **1계층(능동 워치독)**: Offscreen 내부 1초 간격 타이머(`checkWatchdog`)로 `stallThresholdMs`(초기값 1000ms) 이상 프레임 미수신 시 `STALL_DETECTED` 기록.
   - **2계층(재개·종료 시 타임스탬프 비교)**: Chrome 최소화로 인해 **프레임 캡처와 워치독 타이머가 함께 동결**되더라도, 다음 프레임 재개 시(`recordFrame`) 또는 중지 시(`finalizeStallAtStop`) 직전 프레임의 `performance.now()`와 `Date.now()`(벽시계)를 모두 비교해 `Math.max(perfGapMs, wallGapMs) >= stallThresholdMs`이면 `STALL_RECOVERED`와 구간별(`segmentStats`) `stallCount`·`totalStallMs`·`maxStallMs`를 기록한다.
   - **감지할 수 없는 한계(Unobservable Limits)**:
     1. Offscreen 문서가 재개/중지 전에 Chrome 또는 OS에 의해 **강제 종료·크래시**되면 직전 아카이브 이후 메모리에 있던 타임스탬프가 소실되어 정확한 중단 길이를 산출할 수 없다.
     2. 완전 동결 구간 `[lastFrameTime, resumeTime]` 내부에서 언제 Chrome이 멈췄는지 vs 언제 OS 절전이 시작되었는지 세부 하위 구간은 분해할 수 없으며 총 중단 시간만 관측 가능하다.
     3. 시스템 시계(NTP/수동)가 강제 점프하면 `wallGapMs`가 왜곡될 수 있으므로 로그에 `perfGapMs`와 `wallGapMs`를 함께 기록해 교차 판독한다.

---

## 2. 검증 현황 (3단 분류: 단위 테스트 / 일반 Chrome / Windows 11 전용)

### ① 자동화 단위 테스트 및 정적·빌드 검증 (개발 VM 완료 — 통과)
- `npm run typecheck` (`tsc --noEmit`): 통과
- `npm run test` (`vitest run`): **5개 테스트 파일, 30개 단위 테스트 통과**
  - `gestureConfig.test.ts`: 임계값 범위·히스테리시스·가드밴드 불변조건 검증
  - `eyeFeatureExtractor.test.ts`: 양안 동시 감김/윙크 배제, EAR, Blendshape/Iris 시선, **고개 회전(4×4 행렬·랜드마크 폴백) 시선 차단** 검증
  - `gestureStateMachine.test.ts`: 자연 깜빡임·가드밴드·긴 눈 감기(0.6s)·더블 블링크+좌/우 시선·단순 시선 무시·**1.5초 초과 감김 / 2차 깜빡임 초과 / `ARMED_GAZE` 재감김 / `CLOSED` 중 프레임 갭의 모든 락아웃 및 재오픈 후 복구** 검증
  - `sessionMetrics.test.ts`: FPS/`dt`/`blitMs`/`inferMs`, 구간별(`segmentStats`) 집계, **능동 워치독 + 워치독 동결 시 타임스탬프 비교(벽시계 점프 포함) + 중지 시 동결 확정** 검증
  - `windowVisibility.test.ts`: `CHROME_ALL_MINIMIZED` vs `CHROME_UNFOCUSED_VISIBLE` vs `CHROME_FOCUSED` vs `NO_CHROME_WINDOWS` 분류 검증
- `npm run build`: `dist/` MV3 번들 생성 및 `dist/*.js` 내 `eval(`, `new Function`, 외부 `http(s)://` URL **0건** 확인

### ② 일반 Chrome 브라우저 검증 항목 (OS 무관 — 현재 **미검증**)

| ID | 항목 | 수행 절차 | 합격 기준 | 상태 |
| :--- | :--- | :--- | :--- | :---: |
| **TC-01** | 권한·로컬 실행·LED 소등 | `offscreen.html` DevTools Network 탭을 연 채 시작 → `permission.html`에서 **"항상 허용"** → 시작/중지 5회 | 외부 네트워크 요청 0건, 중지 즉시 카메라 LED 소등 및 Offscreen 문서 종료 | **미검증** |
| **TC-02** | 눈 감김 지속시간 & 오탐률 | 5분 일반 작업(자연 깜빡임) + 의도적 0.6초 긴 눈 감기 20회 + 2초 이상 눈 감고 쉬기 5회 | 자연 깜빡임 오탐 ≤1건/5분, 긴 눈 감기 ≥85%, 2초 감김 오발화 0건 | **미검증** |
| **TC-03** | 더블 블링크·시선·고개 회전 | 단순 좌/우 시선 20회, **정면 응시 후 고개만 좌/우 30° 회전 10회**, 더블 블링크+좌/우 응시 각 15회 | 단순 시선 오탐 0건, 고개 회전 시 `GATED(고개회전)` 표시 및 오탐 0건, 더블 블링크+방향 ≥80% | **미검증** |
| **TC-04** | 타 탭 활성화 상태 | `[다른 탭 활성]` 마커 클릭 후 일반 웹페이지 탭에서 3분간 제스처 각 10회 | `segmentStats` 기준 평균 ≥15 FPS, `stallCount === 0`, 제스처 정상 기록 | **미검증** |
| **TC-06** | 15분 안정성 & SW 유휴 종료 | 15분 연속 구동, `chrome://extensions`에서 Service Worker `비활성(Inactive)` 전환 후 제스처 수행 | SW 종료와 무관하게 인식 지속, 제스처 시 SW 자동 Wake-up 및 `lastCommand` 갱신 | **미검증** |

### ③ Windows 11 Chrome 환경 전용 검증 항목 (현재 **미검증**)

| ID | 항목 | 수행 절차 | 합격 기준 (Go/No-Go) | 상태 |
| :--- | :--- | :--- | :--- | :---: |
| **TC-05-W1** | **포커스 상실 vs 완전 최소화 구분** | 1. Chrome 창을 열어둔 채 `Alt+Tab`으로 메모장 활성화(비최소화)<br>2. Chrome 창을 모두 최소화(`Win+D` 또는 최소화 버튼) | 로그 마커가 ① `CHROME_UNFOCUSED_VISIBLE`, ② `CHROME_ALL_MINIMIZED`로 정확히 분리 기록됨 | **미검증** |
| **TC-05-W2** | **Windows 11 완전 최소화 3분 지속성 (`GPU` vs `CPU`)** | 모든 Chrome 창 최소화 상태에서 타 Windows 앱 사용하며 3분간 제스처 각 10회 수행 → 복원 → **카메라 중지 → JSON 내보내기** (`GPU` 실패 시 `CPU`로 재측정) | `segmentStats.CHROME_ALL_MINIMIZED` 기준 평균 ≥12 FPS, `totalStallMs === 0`(또는 허용 범위 내), 제스처 정상 인식 | **미검증** |
| **TC-05-W3** | **Windows 카메라 점유 충돌 및 절전/잠금(`Win+L`) 복구** | Zoom/Windows 카메라 앱 동시 실행 시 오류 표시 확인, `Win+L` 잠금 후 복귀 시 상태 확인 | 오류/스트림 종료(`STREAM_ENDED`) 명확 표시, 침묵 정지 없음 | **미검증** |

> **Phase 1 Go / No-Go 판정 기준**: Windows 11 **TC-05-W2**에서 `MediaStreamTrackProcessor` + `GPU`/`CPU` 모두 `CHROME_ALL_MINIMIZED` 구간 중 0 FPS 동결(`STALL_RECOVERED`) 또는 <12 FPS 스로틀링이 발생한다면, 내보낸 JSON의 `segmentStats`와 `STALL_RECOVERED` 기록을 근거로 순수 MV3 한계를 확정하고 Windows 보조 앱(Native Messaging) 전환을 결정한다.
