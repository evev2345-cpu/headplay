# HEADPLAY Phase 2 — YouTube 제어 지원 범위 및 실기기 검증 가이드

## 1. 아키텍처 및 최소 권한 정책

- **Phase 1 동결 영역 무변경:** `src/core/gesture/gestureStateMachine.ts`, `src/core/config/gestureConfig.ts`, `src/core/vision/*`, `src/core/diagnostics/*`, `src/extension/offscreen/*`는 변경하지 않고 기존 제스처 설정(`chrome.storage.local`)을 그대로 유지한다.
- **최소 권한:** `permissions: ["offscreen", "storage"]` 유지 + `host_permissions: ["https://www.youtube.com/*"]` + `content_scripts` (`https://www.youtube.com/*`, `run_at: "document_idle"`). `"tabs"`, `"scripting"`, `"<all_urls>"`는 요청하지 않는다.
- **실시간 검증 기반 제어:** 모든 명령은 `commandId`로 3단계(`YOUTUBE_COMMAND_RECEIVED` → `YOUTUBE_TARGET_SELECTED` → `YOUTUBE_EXECUTION_RESULT`)가 1:1 연결되며, 메시지 전달이나 버튼 클릭만으로 성공 처리하지 않고 실제 `<video>` 상태 변화(`paused` 또는 `videoId` 전환)를 검증한다.

---

## 2. YouTube 페이지 유형별 지원 범위

| 페이지 유형 | URL 패턴 | `TOGGLE_PLAY_PAUSE` | `NEXT_VIDEO` | `PREV_VIDEO` |
| :--- | :--- | :--- | :--- | :--- |
| **일반 영상 (`WATCH`)** | `/watch?v=...`, `/live/...` | 지원 (`<video>` play/pause + `paused` 변화 검증) | 조건부 지원 (`.ytp-next-button` 활성 시 클릭 + `videoId` 전환 검증) | 조건부 지원 (`.ytp-prev-button` 표시·활성 시만; 단독 영상에서 미노출이면 `UNSUPPORTED` — `history.back()` 미사용) |
| **재생목록 (`PLAYLIST`)** | `/watch?v=...&list=...` | 지원 | 지원 (`.ytp-next-button` 활성 시 + `videoId` 전환 검증) | 지원 (`.ytp-prev-button` 표시·활성 시 + `videoId` 전환 검증; 동일 영상 처음부터 재시작만 되고 `videoId`가 안 바뀌면 `FAILED: PREV_RESTARTED_SAME_VIDEO_NO_SWITCH`) |
| **Shorts (`SHORTS`)** | `/shorts/...` | 지원 (활성 `ytd-reel-video-renderer[is-active] video` 제어) | 지원 (`#navigation-button-down button` 활성 시 + `videoId` 전환 검증) | 지원 (`#navigation-button-up button` 활성 시 + `videoId` 전환 검증) |
| **비재생 페이지 (`OTHER`)** | `/`, `/results`, `/feed/*`, `/playlist?list=...` 등 | 대상 제외 (`hasPlayableVideo: false`) | 대상 제외 | 대상 제외 |

---

## 3. 알려진 제약사항

1. **기존에 열려 있던 YouTube 탭 1회 새로고침 필요:** `"scripting"` 권한을 추가하지 않았으므로 확장 프로그램 설치/새로고침 이전부터 열려 있던 YouTube 탭에는 Content Script가 자동 주입되지 않는다. 이 경우 안전하게 `SKIPPED (CONTENT_SCRIPT_NOT_READY)`로 기록되며, 해당 YouTube 탭을 1회 새로고침하면 즉시 동작한다.
2. **일반 단독 영상에서의 `PREV_VIDEO`:** YouTube가 이전 영상 버튼(`.ytp-prev-button`)을 제공하지 않는 단독 `/watch` 페이지에서는 임의로 `history.back()`을 실행하지 않고 `UNSUPPORTED (PREV_NOT_AVAILABLE_ON_WATCH)`로 안전하게 종료한다.
3. **재생목록 `PREV_VIDEO`의 처음부터 재생 동작:** 일부 YouTube 플레이어 상태에서 재생 시간이 3초 이상 지났을 때 `.ytp-prev-button` 클릭이 이전 곡 전환 대신 현재 곡 0초 재시작으로 동작할 수 있다. 이때 HEADPLAY는 `videoId` 전환이 일어나지 않았음을 감지해 성공으로 위장하지 않고 `FAILED (PREV_RESTARTED_SAME_VIDEO_NO_SWITCH)`로 기록한다.
4. **브라우저 자동재생 정책(Autoplay Policy):** 사용자가 한 번도 상호작용하지 않은 채 새로 연 YouTube 탭에서 백그라운드 `video.play()`가 Chrome 정책에 의해 거부될 수 있다. 이 경우 `FAILED (PLAY_REJECTED:NotAllowedError)`로 정확히 보고하며 다른 탭으로 우회하지 않는다.
5. **YouTube UI DOM 변경 가능성:** YouTube가 `.ytp-next-button`, `.ytp-prev-button`, `#navigation-button-down/up` 구조를 변경할 경우 `UNSUPPORTED (*_DOM_MISSING)` 또는 `FAILED`로 안전 실패하며 임의 페이지 이동을 수행하지 않는다.
6. **모바일/뮤직 도메인 미포함:** 최소 권한 원칙상 현재 `https://www.youtube.com/*`만 포함한다(`m.youtube.com`, `music.youtube.com`은 필요 시 별도 승인 후 추가).

---

## 4. Windows 11 Chrome 실기기 검증 절차 (현재 상태: **미검증**)

> **사전 준비:**
> ```bash
> git pull origin main
> npm run build
> ```
> 1. `chrome://extensions`에서 HEADPLAY **새로고침(↻)** (권한 변경으로 재활성화 알림이 뜨면 허용).
> 2. 테스트에 사용할 YouTube 탭은 확장 새로고침 **이후 새로 열거나 1회 새로고침(F5)**.
> 3. 팝업에서 기존 Phase 1 제스처 설정값이 그대로 유지되어 있는지 확인 후 **카메라 시작**.

| ID | 시나리오 | 수행 절차 | 기대 결과 (팝업 / JSON 로그 확인) | 상태 |
| :---: | :--- | :--- | :--- | :---: |
| **P2-01** | 다른 탭 활성 상태에서 재생/일시정지 및 재개 기억 | 1. YouTube 일반 영상 재생 시작<br>2. 일반 웹페이지 탭으로 전환<br>3. 긴 눈 감기(`TOGGLE_PLAY_PAUSE`) 1회 → 일시정지 확인<br>4. 2초 후 긴 눈 감기 1회 → 다시 재생 확인 | 두 번 모두 동일 탭 제어: `PAUSED_VERIFIED`(`paused:false->true`) 후 `LAST_CONTROLLED_TAB`으로 `PLAYING_VERIFIED`(`paused:true->false`) | **미검증** |
| **P2-02** | 다중 YouTube 탭 우선순위 | 1. YouTube 탭 A 재생 시작 → 3초 후 탭 B 재생 시작(둘 다 재생)<br>2. 다른 탭으로 이동 후 긴 눈 감기 | `MOST_RECENT_PLAYING_TAB`으로 **탭 B**가 일시정지됨 (탭 A 아님) | **미검증** |
| **P2-03** | 모호한 다중 일시정지 탭 거부 | 1. 새로 연 YouTube 탭 A, B를 재생하지 않은(또는 새로고침 직후 일시정지) 상태로 둠<br>2. 긴 눈 감기 수행 | `YOUTUBE_TARGET_SELECTED`: `AMBIGUOUS_TARGET`, `YOUTUBE_EXECUTION_RESULT`: `SKIPPED` — 어느 영상도 임의 재생되지 않음 | **미검증** |
| **P2-04** | 재생목록 다음/이전 영상 전환 검증 | 1. 재생목록(`/watch?v=...&list=...`) 2번 곡 재생<br>2. 더블 블링크 + 오른쪽 시선(`NEXT_VIDEO`)<br>3. 더블 블링크 + 왼쪽 시선(`PREV_VIDEO`) | 실제 `videoId` 변경 확인: `NEXT_VIDEO_CHANGED` (`vid:A->B`), `PREV_VIDEO_CHANGED` (`vid:B->A`) | **미검증** |
| **P2-05** | 일반 단독 영상 `PREV_VIDEO` 안전 실패 | 1. 재생목록이 아닌 단독 `/watch` 영상에서 더블 블링크 + 왼쪽 시선 | `UNSUPPORTED (PREV_NOT_AVAILABLE_ON_WATCH)`, 페이지 뒤로가기나 다른 탭 제어 없음 | **미검증** |
| **P2-06** | Shorts 제어 | 1. `/shorts/...` 영상에서 긴 눈 감기, 더블 블링크 + 오른쪽/왼쪽 시선 수행 | 재생/일시정지 및 다음/이전 Shorts `videoId` 전환 검증 (`EXECUTED`) | **미검증** |
| **P2-07** | **Chrome 완전 최소화 상태 검증** | 1. 재생목록 영상 재생 상태에서 **모든 Chrome 창 최소화**<br>2. 타 앱 화면에서 긴 눈 감기(일시정지) → 3초 후 긴 눈 감기(재개) → 더블 블링크+오른쪽(다음 영상)<br>3. Chrome 복원 후 **JSON 내보내기** | `youtubeControl.logs`에서 각 명령의 동일 `commandId`로 `YOUTUBE_COMMAND_RECEIVED` → `YOUTUBE_TARGET_SELECTED` → `YOUTUBE_EXECUTION_RESULT` 3건 모두 `windowVisibility: "CHROME_ALL_MINIMIZED"` 및 `verified: true` 확인 | **미검증** |
| **P2-08** | 새로고침/홈 이동 후 오래된 상태 무효화 | 1. 탭 A 제어 후 탭 A를 YouTube 홈(`/`)으로 이동하거나 새로고침<br>2. 다른 탭 B가 일시정지 상태로 있는 가운데 긴 눈 감기 | 탭 A의 오래된 `lastControlledTabId` / `lastPlayStartedAtMs`가 무효화되어 탭 A를 잘못 제어하지 않음 | **미검증** |
