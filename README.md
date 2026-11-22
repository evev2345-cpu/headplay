# HEADPLAY (Phase 1 — 기술 검증)

일반 웹캠을 사용해 눈 깜빡임과 시선 방향을 100% 로컬에서 실시간 인식하는 Chrome Manifest V3 확장 프로그램의 **Phase 1 기술 검증 구현체**입니다.

> **현재 단계 범위**: Phase 1 기술 검증(웹캠 입력, 눈 감김·지속시간·더블 블링크·시선 분류, 다른 탭/Chrome 최소화 상태 동작 검증)만 포함되어 있으며, YouTube 제어 로직은 의도적으로 제외되어 있습니다.

## 주요 구조

- `src/core/`: Chrome API 비의존 순수 TypeScript 도메인 모듈 (Vitest 단위 테스트 대상)
  - `config/gestureConfig.ts`: 외부화 임계값 스키마·기본값·불변조건 검증
  - `vision/eyeFeatureExtractor.ts`: 양안 눈 감김 히스테리시스 + EAR 교차검증 + Blendshape/Iris 시선 분류
  - `gesture/gestureStateMachine.ts`: 시간 기반 FSM (`TOGGLE_PLAY_PAUSE`, `NEXT_VIDEO`, `PREV_VIDEO`, 프레임 갭 안전 리셋)
  - `diagnostics/sessionMetrics.ts`: 링 버퍼 기반 FPS/`dt`/이벤트 집계 및 JSON/CSV 내보내기
- `src/extension/`: Chrome MV3 컨텍스트별 어댑터
  - `background/index.ts`: Offscreen Document 라이프사이클, `chrome.storage.session` 상태 복원, 배지, 창 최소화 자동 마킹
  - `offscreen/`: `getUserMedia` + `MediaStreamTrackProcessor`(및 비교용 타이머 폴백) + 로컬 MediaPipe Face Landmarker (`GPU -> CPU` 자동 폴백)
  - `permission/`: 최초 1회 카메라 권한 승인 페이지 (`permission.html`)
  - `popup/`: 시작/중지 제어, 실시간 지표, 환경 마커, 임계값 조정, JSON/CSV 로그 내보내기

## 빌드 및 테스트

```bash
npm install
npm run fetch-model   # assets/models/face_landmarker.task 로컬 다운로드 (최초 1회)
npm run verify        # typecheck + unit tests + dist/ 빌드
```

## Chrome 언팩드 로드 방법

1. Chrome에서 `chrome://extensions` 열기
2. 우측 상단 **개발자 모드(Developer mode)** 활성화
3. **압축해제된 확장 프로그램을 로드합니다(Load unpacked)** 클릭 → `dist/` 디렉터리 선택
4. 확장 아이콘을 클릭해 **권한 설정** 또는 **카메라 시작**을 누르고 권한 팝업에서 **"항상 허용"** 선택

자세한 Phase 1 실제 브라우저 검증 절차 및 설계 결정 기록은 [`docs/PHASE1_VERIFICATION.md`](docs/PHASE1_VERIFICATION.md)를 참고하세요.
