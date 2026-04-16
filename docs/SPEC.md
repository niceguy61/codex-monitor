📄 Codex Monitor Spec

1. 목표

Codex 실행을 단순 상태 표시가 아니라
사용량, 한도, 이벤트 흐름, 파일 변경 흐름까지 볼 수 있는
웹 기반 observability 레이어로 만든다.

핵심 포지셔닝:
- Codex CLI 하단 바 = 현재 상태
- codex-monitor = 현재 상태 + usage analytics + execution flow

2. 현재 핵심 컨셉

Codex CLI
  ├─ `notify` hook
  └─ local session JSONL (`~/.codex/sessions`)
        ↓
Node.js monitor server
  ├─ runtime event ingest
  ├─ session log polling / parsing
  ├─ derived status and analytics
  └─ static web dashboard

3. 실제 수집 경로

현재 환경 기준으로 `hooks.json`보다 아래 경로가 우선이다.

1. `config.toml` 의 `notify` hook
2. `~/.codex/sessions/*.jsonl` tail / polling

즉 수집 전략은:
- turn-level event: notify hook
- tool / file / token / rate-limit data: session log parsing

4. 전체 아키텍처

Codex CLI (WSL2)
  ├─ notify hook -> `POST /codex/events`
  └─ sessions JSONL
       └─ polling parser
            └─ Node.js monitor server
                 ├─ in-memory event store
                 ├─ persisted JSONL mirror
                 ├─ SSE snapshot stream
                 └─ browser dashboard

5. 서버 API

`POST /codex/events`
- notify hook ingest endpoint

`GET /api/snapshot`
- current derived dashboard state

`GET /api/stream`
- SSE for snapshot refresh

6. 이벤트 정의

원시/정규화 이벤트:
- `turn_start`
- `turn_complete`
- `tool_start`
- `tool_complete`
- `file_read`
- `file_write`
- `file_edit`
- `file_delete`
- `approval_request`
- `approval_result`
- `token_usage`
- `error`

7. 파일 이벤트 기준

파일 이벤트는 두 소스에서 파생한다.

1. `exec_command_end.payload.parsed_cmd`
- read/search/write 계열

2. `custom_tool_call(name="apply_patch")`
- `*** Add File:` -> `file_write`
- `*** Update File:` -> `file_edit`
- `*** Delete File:` -> `file_delete`

8. 파생 상태

상태:
- `idle`
- `working`
- `tool_running`
- `wait`

계산 원칙:
- 상태는 저장하지 않고 최근 이벤트로 계산
- approval 대기가 있으면 `wait`
- active tool이 있으면 `tool_running`
- 최근 이벤트가 너무 오래되면 `idle`

9. 제품 우선순위

UI 우선순위:
1. `Now + Plan + Quota`
2. `Tokens`
3. `Recent Events` mix
4. `File Activity` mix

파일/이벤트 raw 리스트는 1차 우선순위가 아니다.

10. 현재 레이아웃 목표

그리드 구조:
- row 1: `Now`
- row 2: `Plan`, `Tokens`
- row 3: `Recent Events`, `File Activity`

즉 `[ ] / [][] / [][]` 구조를 유지한다.

11. 현재 표시 지표

메인 카드:
- current state
- current tool
- repo path
- plan badge
- `5h` window usage
- `7d` window usage
- reset countdown

Tokens 카드:
- last turn tokens
- session total tokens
- context ratio
- input / output / reasoning breakdown

Mix 카드:
- event type doughnut
- file activity doughnut

12. 사용량 / 플랜 지표

세션 로그의 `token_count` / `rate_limits` payload를 사용한다.

표시 항목:
- `plan_type`
- `primary.used_percent`
- `secondary.used_percent`
- `primary.resets_at`
- `secondary.resets_at`
- `last_token_usage`
- `total_token_usage`
- `model_context_window`

13. 시각화 원칙

- 차트는 `Chart.js`
- 숫자는 너무 길면 `k/m/b` 포맷 사용
- usage 상태는 색상 배지로 단순하게 표현
  - `0~50` green
  - `51~80` orange
  - `81~100` red

14. 금지사항

- 처음부터 Grafana 붙이지 말 것
- 이벤트 스키마를 과도하게 설계하지 말 것
- 상태를 직접 저장하지 말 것
- CLI 하단 바의 웹 복제본으로 끝내지 말 것

15. 다음 구현 우선순위

- approaching-limit warning
- heavy-turn detection
- session insight card
- edit/write/delete 중심 파일 intelligence

16. 한 줄 방향

👉 “Codex 실행을 usage and flow observability 레이어로 보여준다”
