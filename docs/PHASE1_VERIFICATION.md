# HEADPLAY Phase 1 — 설계 결정 기록 및 검증 가이드

## 1. 주요 설계 결정 기록 (ADR 요약)

1. **Offscreen Document (`USER_MEDIA`) + `MediaStreamTrackProcessor(maxBufferSize: 1)` 최신 프레임 우선 파이프라인 (Phase 1.1 개선)**
   - **결정**: `MediaStreamTrackProcessor({ track, maxBufferSize: 1 })`의 리더 루프(`pumpReader`)와 추론 스케줄러(`MessageChannel` 기반 `LatestFrameSlot`)를 분리해 추론 중 프레임이 쌓이지 않고 항상 최신 프레임만 처리한다(이전 미처리 `VideoFrame`은 즉시 `close()`).
   - **Zero-Copy GPU 경로 & Canvas 분기**: `delegate: 'GPU'`이고 카메라 프레임 너비가 `inputMaxWidth`(기본 320px) 이하이면 `VideoFrame`을 `FaceLandmarker.detectForVideo()`에 직접 전달(복사 0ms, `finally`에서 즉시 `close()`)하며, 드라이버 비호환·고해상도·`CPU` delegate에서는 비율 유지 리사이즈 캔버스(`CPU`일 때만 `willReadFrequently: true`)로 자동 폴백한다.
   - **카메라 30fps 협상 & 클리핑 제거**: 기본 `targetFps`를 `30`으로 상향하고 `frameRate: { ideal: 30, min: 15, max: 30 }`으로 요청하며, `targetFps === 30`일 때 인위적 소프트웨어 프레임 드롭을 제거해 30fps(33.3ms) 웹캠이 15fps로 반감되는 문제를 해소했다.
   - **단계별 병목 분리 계측 (Phase 1.1 진단 확장)**:
     - 4종 FPS 분리: `trackReportedFps`(`MediaStreamTrack.getSettings().frameRate`), `sourceFrameFps`/`avgSourceFrameDeltaMs`(`VideoFrame.timestamp` μs 기준 하드웨어 출력 추정), `cameraInputFps`/`avgAppReadFps`(애플리케이션 `reader.read()` 수신 속도), `rollingFps`/`avgFps`(실제 추론·처리 FPS).
     - `reader.read()` 및 스케줄링 구간 계측: `avgReadWaitMs`/`maxReadWaitMs`, `avgReadCallIntervalMs`, `avgReadToNextReadCallMs`, `avgScheduleDelayMs`(`MessageChannel` post→onmessage 지연), `avgReceiveToInferStartMs`(프레임 수신→추론 시작), `avgInferEndToNextReadCallMs`/`avgInferEndToNextReadResolveMs`(추론 종료→다음 `read()` 호출/도착), `avgBlitMs`, `avgInferMs`, `avgProcessMs`, `avgDtMs`/`p95DtMs`/`maxDtMs`.
     - **추론 비활성화 진단 모드(`diagnosticBypassInference`) & 캡처 해상도 프리셋(`cameraCaptureResolution`: `320x240` / `640x480` / `default`)**: MediaPipe 추론·WebGL 호출을 완전히 끄고 순수 `reader.read()` 입력 FPS를 실측해 카메라 드라이버/노출 병목 vs GPU/WebGL 경합 vs Offscreen 스로틀링을 분리 검증한다.

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

6. **연속 짧은 깜빡임 분석 진단 (Phase 1.1 — 임계값 임의 변경 금지 원칙 준수)**
   - **검증 결과(단위 테스트)**: `GestureStateMachine`은 `LONG_BLINK`를 단일 연속 `CLOSED` 구간만으로 판단하며, 20 FPS(`dt = 50ms`)로 중간 `OPEN` 구간(100ms)이 샘플링되면 4회 연속 짧은 깜빡임도 `LONG_BLINK`로 오분류하지 않는다. 반면 8.3 FPS(`dt = 120ms`)에서는 100ms `OPEN` 구간이 샘플 사이에 빠져(에일리어싱) 단일 `480ms+` `LONG_BLINK`로 병합됨을 단위 테스트로 재현했다.
   - **로그 보강**: 모든 `BLINK` 로그에 `closedDurationMs`, `openGapMs`, `frameCount`, `maxDtDuringCloseMs`, `minBlinkAvgDuringClose..peakBlinkAvgDuringClose`, `suspectedMissedOpenValley`(단일 `CLOSED` 구간 내 W자형 재개방 딥 감지 플래그)를 기록한다.

---

## 2. 검증 현황 (3단 분류: 단위 테스트 / 일반 Chrome / Windows 11 전용)

### ① 자동화 단위 테스트 및 정적·빌드 검증 (개발 VM 완료 — 통과)
- `npm run typecheck` (`tsc --noEmit`): 통과
- `npm run test` (`vitest run`): **6개 테스트 파일, 40개 단위 테스트 통과**
  - `gestureConfig.test.ts` (3): 임계값 범위·히스테리시스·가드밴드 불변조건 검증
  - `eyeFeatureExtractor.test.ts` (6): 양안 동시 감김/윙크 배제, EAR, Blendshape/Iris 시선, 고개 회전(4×4 행렬·랜드마크 폴백) 시선 차단 검증
  - `frameScheduler.test.ts` (4): `LatestFrameSlot` 최신 프레임 우선·이전 프레임 즉시 `close()`, 30fps 비클리핑, 비율 유지 리사이즈 검증
  - `gestureStateMachine.test.ts` (15): 기존 12개 + **20fps 4연속 짧은 깜빡임 비오탐**, **8.3fps(120ms) 중간 OPEN 누락 에일리어싱 재현**, **부분 재개방 W자형 밸리(`suspectedMissedOpenValley`) 감지** 검증
  - `sessionMetrics.test.ts` (8): 기존 6개 + **4종 FPS(`trackReportedFps`/`sourceFrameFps`/`cameraInputFps`/`rollingFps`)·`read()` 대기/간격·`MessageChannel`·`receiveToInferStart`/`inferEndToNextRead` 계측** 및 **추론 비활성화(`diagnosticBypassInference`) 진단 모드** 검증
  - `windowVisibility.test.ts` (4): `CHROME_ALL_MINIMIZED` vs `CHROME_UNFOCUSED_VISIBLE` vs `CHROME_FOCUSED` vs `NO_CHROME_WINDOWS` 분류 검증
- `npm run build`: `dist/` MV3 번들 생성 및 `dist/*.js` 내 `eval(`, `new Function`, 외부 `http(s)://` URL **0건** 확인

### ② 일반 Chrome 브라우저 검증 항목 (OS 무관 — Phase 1.1 변경 후 **재검증 필요 / 미검증**)

| ID | 항목 | 수행 절차 | 합격 기준 | 상태 |
| :--- | :--- | :--- | :--- | :---: |
| **TC-01** | 권한·로컬 실행·LED 소등 | `offscreen.html` DevTools Network 탭을 연 채 시작 → `permission.html`에서 **"항상 허용"** → 시작/중지 5회 | 외부 네트워크 요청 0건, 중지 즉시 카메라 LED 소등 및 Offscreen 문서 종료 | **미검증** |
| **TC-02** | 눈 감김 지속시간 & 오탐률 | 5분 일반 작업(자연 깜빡임) + 의도적 0.6초 긴 눈 감기 20회 + 2초 이상 눈 감고 쉬기 5회 | 자연 깜빡임 오탐 ≤1건/5분, 긴 눈 감기 ≥85%, 2초 감김 오발화 0건 | **미검증** |
| **TC-02B** | **Phase 1.1: 빠른 연속 짧은 깜빡임** | 빠른 짧은 깜빡임 2~4회 연속 10세트 수행 후 JSON 내보내기 | `BLINK` 로그에 개별 `closedDurationMs`/`openGapMs` 기록, `LONG_BLINK` 오분류 해소 여부 및 `suspectedMissedOpenValley` 발생 여부 확인 | **미검증** |
| **TC-03** | 더블 블링크·시선·고개 회전 | 단순 좌/우 시선 20회, 정면 응시 후 고개만 좌/우 30° 회전 10회, 더블 블링크+좌/우 응시 각 15회 | 단순 시선 오탐 0건, 고개 회전 시 `GATED(고개회전)` 표시 및 오탐 0건, 더블 블링크+방향 ≥80% | **미검증** |
| **TC-04** | 타 탭 활성화 상태 | `[다른 탭 활성]` 마커 클릭 후 일반 웹페이지 탭에서 3분간 제스처 각 10회 | `segmentStats` 기준 평균 ≥15 FPS, `stallCount === 0`, 제스처 정상 기록 | **미검증** |
| **TC-06** | 15분 안정성 & SW 유휴 종료 | 15분 연속 구동, `chrome://extensions`에서 Service Worker `비활성(Inactive)` 전환 후 제스처 수행 | SW 종료와 무관하게 인식 지속, 제스처 시 SW 자동 Wake-up 및 `lastCommand` 갱신 | **미검증** |

### ③ Windows 11 Chrome 환경 전용 검증 항목 (Phase 1.1 변경 후 **미검증**)

| ID | 항목 | 수행 절차 | 합격 기준 (Go/No-Go) | 상태 |
| :--- | :--- | :--- | :--- | :---: |
| **TC-05-W0A** | **Phase 1.1: 8~9 FPS 병목 원인 분리 진단** | 설정에서 **기본값 복원**(또는 `targetFps=30`) 후 4개 조건을 각 30초 측정:<br>A. `320×240`, 추론 OFF(`diagnosticBypassInference=ON`)<br>B. `640×480` 또는 `default`, 추론 OFF<br>C. 최고 입력 FPS 해상도 + 추론 ON (`ZC/GPU`)<br>D. 동일 조건 + `directVideoFrameGpu=OFF` (또는 `CPU`) | A vs B로 드라이버/해상도/조명 병목 분리, A vs C로 WebGL/MediaPipe 경합 분리. `trackReportedFps`/`sourceFrameFps`/`cameraInputFps`/`avgReadWaitMs`/`avgScheduleDelayMs` JSON 확보 | **미검증** |
| **TC-05-W0** | **Phase 1.1: FPS 병목 실측 (`320px` vs `256px`, `ZC` vs `CV`)** | 트래킹 시작 후 팝업의 `트랙/소스/수신/처리 FPS`, `read() 대기`, `MC/수신→추론/추론→수신`, `복사/추론(ms)` 1분 이상 관찰 및 JSON 내보내기 | 실제 처리 FPS ≥15(목표 ≥20), `avgDtMs` ≤66ms, 병목 수치 확보 | **미검증** |
| **TC-05-W1** | 포커스 상실 vs 완전 최소화 구분 | 1. Chrome 창을 열어둔 채 `Alt+Tab`으로 메모장 활성화<br>2. 모든 Chrome 창 최소화 | 로그 마커가 `CHROME_UNFOCUSED_VISIBLE`과 `CHROME_ALL_MINIMIZED`로 정확히 분리 기록 | **미검증** |
| **TC-05-W2** | Windows 11 완전 최소화 3분 지속성 (`GPU` vs `CPU`) | 모든 Chrome 창 최소화 상태에서 타 Windows 앱 사용하며 3분간 제스처 각 10회 수행 → 복원 → **카메라 중지 → JSON 내보내기** | `segmentStats.CHROME_ALL_MINIMIZED` 기준 평균 ≥12~15 FPS, `totalStallMs === 0`, 제스처 정상 인식 | **미검증** |
| **TC-05-W3** | Windows 카메라 점유 충돌 및 절전/잠금(`Win+L`) 복구 | Zoom/Windows 카메라 앱 동시 실행 시 오류 표시 확인, `Win+L` 잠금 후 복귀 시 상태 확인 | 오류/스트림 종료(`STREAM_ENDED`) 명확 표시, 침묵 정지 없음 | **미검증** |

> **Phase 1 Go / No-Go 판정 기준**: Windows 11 **TC-05-W2**에서 `MediaStreamTrackProcessor` + `GPU`/`CPU` 모두 `CHROME_ALL_MINIMIZED` 구간 중 0 FPS 동결(`STALL_RECOVERED`) 또는 <12 FPS 스로틀링이 발생한다면, 내보낸 JSON의 `segmentStats`와 `STALL_RECOVERED` 기록을 근거로 순수 MV3 한계를 확정하고 Windows 보조 앱(Native Messaging) 전환을 결정한다.
