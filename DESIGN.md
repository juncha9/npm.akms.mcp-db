# @akms/mcp-db — 설계 (2026-10-11, 0.0.1 구현 · 시험 끝)

> 구현 전 설계 문서. 확정되면 README.md(사용) · README_DEV.md(개발)로 나뉘고 이 파일은 결정 기록으로 남는다.

## 1. 왜 만드나

- 지금 쓰는 `postgres-mcp`(0.3.0)는 **SSH 터널을 모른다** — 옵션이 `database_url` · `--access-mode` · `--transport` 뿐. RDS 처럼 퍼블릭으로 열지 않은 DB 에 붙으려면 `ssh -N -L` 포워딩을 따로 띄워 두고 `localhost` 를 보게 해야 하고, 그 프로세스가 죽으면 MCP 도 같이 끊긴다.
- 가드가 "읽기 전용 / 무제한" 둘뿐이라, 우리 규칙(TRUNCATE · WHERE 없는 UPDATE/DELETE 절대 금지, DROP 류는 확인)을 담을 자리가 없다.
- `@akms/mcp-ssh` · `@akms/mcp-wsl` 과 같은 모양(서버 항목 = 대상 하나, 환경 변수만, 가드 3단, `--check`)으로 DB 도 맞춘다.

## 2. 범위

| | 1차 (지금) | 뒤로 |
| --- | --- | --- |
| DBMS | **PostgreSQL** (`pg`) | MySQL/MariaDB (`mysql2`), SQLite (`better-sqlite3` — 터널 없음) |
| 연결 | 직접 TCP · **SSH 터널 경유** | — |
| 인증 | 비밀번호 · SSH 키/비밀번호 | IAM 토큰 등은 안 함 |

DBMS 는 `DB_DRIVER` 하나로 고르고, 드라이버 경계는 `connect / query / 메타 조회 SQL` 세 곳뿐 — 추상화는 이 세 곳 이상으로 키우지 않는다.

## 3. MCP 클라이언트 설정 — 항목 하나 = 데이터베이스 하나

```json
{
    "mcpServers": {
        "pg_aws_akms": {
            "command": "npx", "args": ["-y", "@akms/mcp-db"],
            "env": {
                "DB_DRIVER": "postgres",
                "DB_HOST": "mydb.xxxx.ap-northeast-2.rds.amazonaws.com",
                "DB_PORT": "15432", "DB_NAME": "akms", "DB_USER": "app_user", "DB_PASSWORD": "…",
                "DB_SSH_HOST": "203.0.113.5", "DB_SSH_PORT": "20022", "DB_SSH_USER": "ubuntu",
                "DB_SSH_KEY": "C:/…/bastion.pem", "DB_SSH_HOST_KEY": "SHA256:…"
            }
        }
    }
}
```

- mcp-ssh 와 같은 이유로 **환경 변수만**: "이 서버가 무엇에 어디까지 할 수 있나"가 항목 하나를 읽으면 끝난다. `DB_URL` 한 줄도 받되(기존 `postgres-mcp` 설정을 옮기기 쉽게), 분리 변수와 섞이면 시작 실패.
- `DB_SSH_*` 가 있으면 터널, 없으면 직접 연결. 터널의 목적지는 `DB_HOST:DB_PORT` 그대로 — 즉 **RDS 엔드포인트를 SSH 호스트가 풀어서** 간다(`forwardOut` 의 dstHost 에 이름을 그대로 넘기면 sshd 가 푼다).
- 잘못된 값은 조용히 무시하지 않고 시작 실패(mcp-ssh 와 같음). `DB_HOST` 가 없으면 서버는 뜨되 도구가 "등록된 DB 없음"이라 답한다.

### 연결

| 변수 | 설명 |
| --- | --- |
| `DB_DRIVER` ✅ | `postgres` (1차) |
| `DB_HOST` ✅ · `DB_PORT` · `DB_NAME` ✅ · `DB_USER` ✅ · `DB_PASSWORD` | 포트 기본은 드라이버 기본(5432) |
| `DB_URL` | 위 다섯을 한 줄로. 둘 다 주면 시작 실패 |
| `DB_SSL` | `require`(암호화, 인증서 검증 안 함) / `verify`(+ `DB_SSL_CA` 경로로 검증) / `off`. **기본 `require` — 터널이어도.** RDS 는 터널 안에서도 암호화 안 된 연결을 거절한다(실측: `no pg_hba.conf entry … no encryption`). `verify` 는 RDS CA 묶음(rds-ca-rsa2048-g1)이 Node 기본 신뢰 목록에 없어 CA 파일이 필요 |
| `DB_SSH_HOST` · `DB_SSH_PORT` · `DB_SSH_USER` · `DB_SSH_KEY` · `DB_SSH_PASSPHRASE` · `DB_SSH_PASSWORD` · `DB_SSH_HOST_KEY` | mcp-ssh 의 `SSH_*` 와 뜻 · 인증 순서 같음(키 경로 → 비밀번호 → 에이전트) |
| `DB_ALIAS` · `DB_DESCRIPTION` | 에이전트에게 보이는 이름(기본 `<database>@<host>`) · 용도. 처음 적은 `DB_NAME_ALIAS` 는 `DB_NAME` 과 헷갈려 구현에서 `DB_ALIAS` 로 |

### 정책

| 변수 | 기본 | 효과 |
| --- | --- | --- |
| `DB_READONLY` | `false` | 문장 종류를 SELECT/WITH(쓰기 CTE 없는)/EXPLAIN/SHOW/VALUES 로 제한하고, 실행은 **`BEGIN READ ONLY` … `ROLLBACK`** 안에서 (이중). 세션 기본값(`default_transaction_read_only`)이 아니라 트랜잭션으로 감싸는 건 postgres-mcp 와 같은 방식 — 함수 안의 쓰기(`nextval` · 쓰기 함수)까지 서버가 막는다 |
| `DB_ALLOW_DDL` | `true` | false 면 CREATE/ALTER/DROP 전부 거절 |
| `DB_DENY_PATTERNS` | 없음 | 정규식, 시작 때 컴파일, 문장마다 검사 |
| `DB_STATEMENT_TIMEOUT_MS` | `60000` | 세션 `statement_timeout` 으로 **서버 쪽에서** 끊는다(postgres-mcp 는 클라이언트 쪽 `asyncio.timeout` 이라 서버에서 질의가 계속 돈다) |
| `DB_MAX_ROWS` | `500` | 결과 로우 상한 — 넘으면 자르고 "N 로우 더 있음" |
| `DB_MAX_OUTPUT` | `100000` | 직렬화한 결과 바이트 상한 |

### 가드 — mcp-ssh 와 같은 3단

| 단 | 범위 | 걸리는 것 |
| --- | --- | --- |
| **재앙** (항상, 설정 불가) | 모든 문장 · AST 전체 | `TRUNCATE`, **WHERE 없는 `UPDATE`/`DELETE`**(쓰기 CTE `WITH d AS (DELETE …)` 안까지 — 이건 최상위가 `SelectStmt` 로 나와서 최상위만 보면 놓친다, 실측), `DROP DATABASE/SCHEMA/TABLESPACE`, `DROP OWNED`, `ALTER SYSTEM`, `COPY … TO/FROM PROGRAM`, 다중 문장 안의 위 어느 것 |
| `DB_READONLY` | 선택 | 읽기 외 전부 (+ 서버 쪽 `read_only` 세션으로 이중) |
| `DB_ALLOW_DDL=false` · `DB_DENY_PATTERNS` | 선택 | 적은 것 |

- 위협 모델은 mcp-ssh 와 같이 **실수하는 에이전트**이지 공격자가 아니다. 우회는 가능하고(예: `DO $$ … $$` 본문은 PL/pgSQL 문자열이라 AST 에 안 펼쳐진다 — 읽기 전용에선 `DO` 자체를 거절, 그 밖에선 통과), 그래서 단이 적다.
- `pg_terminate_backend` 는 넣지 않는다 — 특정 pid 를 끊는 건 정상 작업이고 "전부"의 경계가 흐리다.
- "DROP TABLE · ALTER TYPE · RENAME · NOT NULL 은 확인받는다"는 우리 규칙은 **도구가 할 수 없다**(MCP 는 중간에 사람에게 묻지 못한다). 이건 에이전트의 대화 규칙(CLAUDE.md · 메모리)으로 남고, 도구는 "절대"만 막는다. 단 `db_describe` 결과와 `db_query` 응답에 DDL 이면 `"ddl": true` 를 실어, 에이전트가 보고할 때 빠뜨리지 않게 한다.
- 가드는 드라이버의 `query()` 한 곳에서 실행된다 — 새 도구가 가드를 빼먹을 수 없게.
- 문장 분류는 정규식이 아니라 **실제 PostgreSQL 파서**로 — 아래 「파서 선택」. WHERE 유무 · 문장 종류 · DDL 여부를 AST 에서 읽는다. 파싱 실패 문장은 거절(모르는 건 안 보낸다).

## 4. 도구

이름은 `db_` 접두사 — 서버 항목 이름(`pg_aws_akms`)이 어느 DB 인지 말하므로 도구 이름에 DBMS 를 넣지 않는다.

| 도구 | 하는 일 |
| --- | --- |
| `db_list_hosts` | 이 서버의 DB(드라이버 · 호스트 · DB 이름 · 터널 여부 · 정책). 비밀은 없음 |
| `db_query` | SQL 한 문장(또는 `;` 로 여러 문장 — 하나의 트랜잭션). `{ rows, rowCount, fields, durationMs, truncated, ddl }` |
| `db_schemas` | 스키마 목록 + 테이블 수 |
| `db_tables` | 스키마의 테이블 · 뷰 · 시퀀스 목록(종류 · 대략 로우 수 · 크기) |
| `db_describe` | 한 객체: 컬럼(이름 · 타입 · null · 기본값) · PK · 인덱스 · FK(양방향) · 체크 · 트리거 · 주석 |
| `db_explain` | `EXPLAIN (ANALYZE 선택, BUFFERS, FORMAT TEXT)` — **항상 롤백되는 트랜잭션 안에서** 돈다. 그래서 ANALYZE 를 쓰기 문장에도 허용(효과는 되돌려짐 · 소비한 시퀀스 값만 안 돌아옴). 처음 설계(ANALYZE 는 읽기에만)보다 쓸모 있고 위험은 같다. 읽기 전용 프로필에선 쓰기 문장의 ANALYZE 거절 |

- `postgres-mcp` 의 `analyze_db_health` · `get_top_queries` · 인덱스 추천은 **안 만든다**. 필요하면 `db_query` 로 `pg_stat_statements` 를 직접 본다(단순성 우선).
- 응답은 JSON. 로우는 배열의 배열이 아니라 `{컬럼: 값}` 객체 배열(에이전트가 읽기 쉬움). `bigint` · `numeric` · 날짜는 문자열로 — 정밀도 손실 없이.
- 세션 개념 없음(mcp-ssh 와 다른 점): 풀 하나(`max 2`), 도구 호출마다 풀에서 빌린다. 다중 문장은 한 커넥션 · 한 트랜잭션에서 돌리고 실패하면 롤백. 터널은 첫 호출 때 열고 유지, 끊기면 다음 호출에서 다시 연다(mcp-ssh 는 "다음 호출에서 보고"지만 DB 는 상태가 없어 재연결이 안전).
- **호출마다 `DISCARD ALL`** (구현 중 추가): 읽기 전용 e2e 에서 `set_config(…, false)` 가 풀 연결에 남는 걸 보고 넣었다. 남겨 두면 연결이 둘이라 다음 호출에 보일 수도 안 보일 수도 있고, 읽기-쓰기 프로필에서 `SET statement_timeout = 0` 이 그 연결의 정책 시간 제한을 풀어 버린다. RESET 은 연결 시작 값으로 돌리므로 정책 값이 돌아온다(통합 시험으로 확인). 카탈로그 도구는 고정 SQL 이라 생략.
- **행 상한은 커서로** (`pg-cursor`): `maxRows + 1` 개만 읽고 멈춰서 큰 테이블이 메모리에 통째로 올라오지 않는다. 한 개 더 읽는 건 "더 있음"을 알기 위해.
- **날짜 · 시간 · interval · bytea 는 서버 문자열 그대로**: `pg` 기본 파서는 `timestamp`(시간대 없음)를 로컬 시각 Date 로 만들고 JSON 이 UTC 로 바꿔 KST 04:19 가 전날 `19:19Z` 로 나왔다(실측).
- **같은 이름의 컬럼**(`SELECT 1 AS a, 2 AS a`)은 객체에서 덮어써져 값이 사라진다 → 배열로 받아 `a`, `a#2` 로.

## 5. `--check`

```
akms-mcp-db --check
Checking pg_aws_akms  →  postgres akms@mydb…:15432 via ssh ubuntu@203.0.113.5:20022

  OK      ssh   ubuntu@203.0.113.5:20022  (key …/bastion.pem, 380ms)  host key SHA256:…
  OK      db    PostgreSQL 17.x  akms  as app_user  (41ms)  read_only=off  statement_timeout=60s
```

터널 · DB 를 단계별로 보고 — 설정 실수와 가드 거절을 구분할 수 있게.

## 6. 구현 구조 (mcp-ssh · wg-cli 와 같은 틀)

```
src/
  _defs/defaults.ts            상한 · 기본값
  _types/{settings,result}.ts
  _libs/settings.ts            환경 변수 → Settings (검증 · 시작 실패)
  _libs/tunnel.ts              ssh2: 연결 · forwardOut → Duplex, 호스트 키 핀
  _libs/guard/{classify,rules}.ts   AST 분류 · 재앙/읽기전용/DDL 규칙
  drivers/{driver.ts,postgres.ts}   Driver 인터페이스 + pg 구현 (stream 옵션으로 터널 스트림 주입)
  modules/tools.ts             MCP 도구 등록 (zod 스키마)
  cli.ts                       stdio 서버 · --check · --help
  index.ts                     라이브러리 export
tests/                         guard 분류(핵심) · settings 파싱 · 드라이버 메타 SQL 은 실제 PG(docker) 통합
```

- 의존: `@modelcontextprotocol/sdk` · `zod` · `ssh2` · `pg` · `libpg-query`. 빌드 tsup(esm+cjs+dts) · vitest · Node ≥ 22(mcp-ssh 는 18 이지만 wg-cli 와 맞춤).
- bin: `akms-mcp-db`. 로그는 stderr, `DB_MCP_LOG_LEVEL`.
- 터널 핵심 — **채널 어댑터 `ChannelSocket`(Duplex)**. `pg`(8.23)는 `stream` 이 함수면 연결마다 **동기로** 부르고, 곧바로 `setNoDelay()` · `connect(port, host)` 를 호출한 뒤 `'connect'` 이벤트를 기다린다(`lib/connection.js`). ssh2 `forwardOut` 은 비동기라 그대로 못 꽂는다 → 어댑터가 `connect(port, host)` 에서 `forwardOut(…, host, port)` 를 열고, 열리기 전 쓰기는 모아 뒀다가 흘리고, 열리면 `'connect'` 를 낸다. `setNoDelay` · `setKeepAlive` 는 아무것도 안 함. TLS 는 `pg` 가 이 Duplex 위에 그대로 올린다.
- 로컬 포트를 열지 않으므로 포트 충돌 · 같은 PC 의 다른 프로세스 노출이 없다. RDS 이름은 SSH 호스트(sshd)가 푼다.
- **실측 (2026-10-11, 시험 코드 · RDS 에 `SELECT` 만)**: `bastion`(app_user, 비밀번호) 경유 → `mydb` PostgreSQL 18.6. SSH 연결 195ms, DB 연결+첫 질의 163ms, 다음 질의 5ms, `pg_stat_ssl.ssl = true`, RDS 가 본 상대 `10.0.x.x`. `ssl=off` 는 거절됨.

## 7. 결정 (사용자 2026-10-11: "1 오케이 2 오케이 3 추천대로 할게 4 추천대로" · "4번같은경우 postgres-mcp 라이브러리에서는 어떻게 진행했는지 참고하면 좋을듯")

1. **1차는 PostgreSQL 만**, 드라이버 경계(연결 · 질의 · 메타 SQL)만 열어 둔다.
2. **`DB_READONLY` 기본 `false`** — mcp-ssh 와 같은 "허용이 기본". 운영 DB 항목만 `true`.
3. **여러 문장은 한 트랜잭션**(하나라도 실패하면 전체 롤백). 문장마다 자동 커밋이 필요하면 `db_query` 의 `transaction: false`.
4. **파서는 `libpg-query`(WASM)** — 처음 권했던 `pgsql-ast-parser` 에서 바꿈. 아래 「파서 선택」.

### 파서 선택 — postgres-mcp 를 참고해서

**postgres-mcp(0.3.0)가 하는 것** (설치된 소스 `postgres_mcp/sql/safe_sql.py` · `sql_driver.py`):
- 파서는 **`pglast`** — 실제 PostgreSQL 파서 libpg_query 의 파이썬 바인딩. 파싱 실패 = 거절.
- `restricted` 모드: 허용 목록 세 겹 — 문장 종류(Select · Explain · Show · Vacuum · Prepare …), **AST 노드 종류 전부**, **함수 이름 전부**. 거기에 `SELECT … FOR UPDATE` · `EXPLAIN ANALYZE` 거절, 실행은 `BEGIN TRANSACTION READ ONLY` … `ROLLBACK`, 클라이언트 쪽 30초 시간 제한.
- `unrestricted` 모드(**우리가 지금 모든 항목에 쓰는 것**): **파싱도 가드도 없다** — 문장이 그대로 간다. 지금은 TRUNCATE 든 WHERE 없는 DELETE 든 도구가 막아 주지 않는 상태.

**가져오는 것**: 실제 PG 파서(libpg_query) · 파싱 실패 = 거절 · 읽기 전용은 `BEGIN READ ONLY` … `ROLLBACK`.
**안 가져오는 것**: 노드 · 함수 허용 목록 — 평범한 함수(`jsonb_path_query` 등)까지 목록에 없으면 막혀 손이 많이 가고, 쓰기는 READ ONLY 트랜잭션이 서버에서 이미 막는다. 클라이언트 쪽 시간 제한 대신 서버 `statement_timeout`.

**JS 쪽 후보 비교 — 같은 문장 29개 (실측 2026-10-11)**:

| | 판 · 크기 | 파싱 실패 | 못 읽은 것 |
| --- | --- | --- | --- |
| `pgsql-ast-parser` (순수 JS, 자체 문법) | 12.0.2 · 2.0MB | **9 / 29** | `DROP SCHEMA` · `DROP DATABASE` · `ALTER SYSTEM` · `COPY … TO PROGRAM` — 정작 막아야 할 것들 — 과 `ALTER TYPE … ADD VALUE` · `MERGE` · `GRANT` · `CREATE POLICY` · `EXPLAIN (ANALYZE)` |
| **`libpg-query`** (libpg_query 를 **WASM** 으로, pglast 와 같은 C 파서) | 18.1.5 · 1.8MB · 설치 스크립트 없음 | **0 / 29** | — WHERE 유무 · 쓰기 CTE · 다중 문장까지 정확 |

처음 `libpg-query` 를 "네이티브 바인딩이라 설치가 무겁다"고 했던 건 옛 정보였다 — 지금은 WASM 이라 그 단점이 없고, "파싱 실패 = 거절"인 가드에서 9/29 실패는 일상 작업을 막는다.

## 8. 구현 기록 (2026-10-11)

**시험**: 단위 55 + 통합 8 = 63 통과. 통합은 `MCP_DB_TEST_URL` 이 있을 때만(로컬 `akms_test`, TEMP 테이블만 — 끝나면 사라짐).

**e2e — 빌드한 서버를 MCP 클라이언트(SDK)로 띄워 도구 6개 호출**:
- `bastion`(app_user 비밀번호, 호스트 키 고정) 경유 RDS `mydb`(PostgreSQL 18.6): 조회 · 행 상한 안내 · 한글 파라미터 · 카탈로그 · `EXPLAIN ANALYZE`(롤백) · 가드 거절 4종(아무것도 안 보냄) · 서버 오류(0 나누기) 시 롤백 안내 모두 정상. 첫 연결 약 1.2초(TLS + SCRAM), 이후 호출당 약 110ms(터널 왕복 × BEGIN · 커서 · 종료 · DISCARD), `db_describe` 약 0.6초.
- `--check`: 정상 / `DB_SSL=off`(RDS 가 거절 — 단계별로 db 에서 실패) / 틀린 `DB_SSH_HOST_KEY`(ssh 에서 끊고 "고정한 키와 다름") 세 경우 확인.
- 로컬 `akms_test` 직접 연결 + `DB_READONLY=true`: `transaction_read_only = on`, 쓰기 · 쓰기 CTE 거절, 도구 annotation 이 모두 readOnly 로.
- RDS 에는 아직 `postgres` · `rdsadmin` 데이터베이스만 있다(akms 데이터베이스 없음).

## 9. 검토와 수정 (2026-10-11, 질의 경로 중심)

요청: "버그가 발생 안 할지 확인해 보자, 특히 쿼리에서" · "DB 툴이기 때문에 검토는 빡세게". 네 관점(출력 · 카탈로그 · 가드 · 실행)으로 나눠 검토하고, 모든 지적을 따로 재현해 반박을 시도한 뒤 남은 것만 고쳤다. 고친 코드는 다시 같은 방식으로 검토했다 — 첫 검토 48건(관점끼리 겹친 것 포함) → 1차 수정 재검토 9건 → 2차 24건 → 3차 24건(26건 중 2건 반박, 겹친 것을 묶으면 18가지) → 4차 15건(16건 중 1건 반박, 겹친 것을 묶으면 13가지 — 3차 수정이 만든 회귀 둘 포함) → 5차 7건(8건 중 1건 반박 — 4차 수정이 만든 회귀 둘 포함) → 6차 4건(6건 중 2건 반박, 모두 낮음) → 7차 5건(모두 낮음). 여기서 반복을 멈췄다: 두 회차 연속 낮음뿐이었고, 5차부터는 지적이 모두 출력 문구 · 출력 예산 · 설정 값 해석 같은 휴리스틱에서 나왔다 — 질의 실행 · 트랜잭션 · 가드 · 연결 처리에서는 4차 수정 이후 새 지적이 없었다. 7차 수정은 회차마다 리뷰어가 남긴 퍼즈 도구(출력 예산 13만 건, 오류 경로 주입)로 다시 확인했다. 출력 계획기를 다시 설계한 뒤(아래 「검토 뒤 다시 설계했다」)에는 그 부분만 같은 방식으로 한 번 더 검토했다 — 8차 23건(높음 2 · 중간 6 · 낮음 15; 네 관점 — 불변식 · 문구 · 극단값 · 옛 구현과 비교). 높음 · 중간은 모두 고쳤고 낮음은 5건을 두었다(「고치지 않은 것」). 회차마다 심각도가 내려갔다 — 3차부터 치명 · 높음은 없었다. 3차부터의 지적은 대부분 바로 앞 회차의 수정이 만든 것이어서(문구를 고치면 다른 경우에서 틀리고, 예산 규칙을 바꾸면 다른 모양에서 숨는다), 고칠 때마다 그 수정만 다시 검토했다.

시험 환경을 셋 새로 세웠다. 단위 시험만으로는 이번 결함 대부분(연결 끊김 · 늦게 오는 오류 · 명령 태그 행 수)을 재현할 수 없었기 때문이다.
- **PGlite**(WASM 으로 돌린 실제 PostgreSQL 18.3) + `pglite-socket` — `npm test` 가 진짜 서버 프로토콜을 상대로 돈다. 연결 여러 개가 세션 하나를 나눠 쓰고, CancelRequest 와 시작 매개변수를 무시한다는 한계가 있다.
- **장애 주입 TCP 프록시**(`tests/support/tcp-proxy.ts`) — 특정 메시지에서 연결을 끊기 · 응답을 삼키기 · 응답 뒤에 `FATAL 57P01` 을 끼워 넣기.
- **실제 PostgreSQL 18.4**(로컬 `akms_test`, `lc_messages=ko`) 통합 시험 16건 — PGlite 가 흉내 내지 못하는 취소 · 세션 종료 · 지역화된 메시지를 여기서 본다.

### 결정 (사용자 2026-10-11: "권장대로 하자")

1. **잡히지 않은 예외가 나도 서버는 계속 돈다.** 로그를 남기고, 진행 중이던 연결을 모두 끊는다(`abortActiveConnections`). MCP 서버가 죽으면 클라이언트를 다시 시작할 때까지 도구 전체가 사라지지만, 끊긴 연결은 다음 호출이 새로 열면 된다. 프로토콜 처리 중에 던져진 예외는 그 연결을 중간 상태로 멈춰 두므로, 살려 두되 연결은 버린다. 이건 마지막 안전망이고, 본래 수정은 아래 「연결이 끊길 때」다.
2. **json/jsonb 는 정밀도를 잃는 숫자만 서버 글자 그대로 둔다.** `JSON.parse` 의 reviver 로 숫자마다 원문(`context.source`)과 비교하고, 다르면 `JSON.rawJSON(원문)` 으로 바꾼다. 값 전체를 문자열로 돌려주던 1차 수정은 JSON 문자열 값과 구분이 안 돼 되돌렸다(2차 R1). 비교는 십진 표기를 정규화해서 한다 — `1.10` 과 `1.1`, `1e20` 과 `100000000000000000000` 은 같은 값이라 손실이 아니다(2차 R2). V8 은 reviver 를 재귀로 돌려 2000단계쯤 넘게 중첩된 값에서 스택이 넘친다. 타입 파서 안에서 던진 예외는 pg 의 소켓 처리기 안이라 누구도 잡지 못하므로, 그때는 값 전체를 서버 글자로 돌려준다. 3차에서는 reviver 없이 다시 읽었는데, 그러면 포맷터의 `JSON.stringify` 가 4800단계쯤에서 같은 이유로 넘쳐, 이미 커밋된 호출이 "db_query failed" 로 보고됐다(4차).
3. **파티션은 부모 아래에 숨긴다.** `db_tables` 에는 부모만 나오고 종류에 `partitioned table (N partitions)`, 목록은 `db_describe` 에. 파티션이 수백 개인 테이블이 목록을 덮지 않게 하면서, 어디서도 안 보이던 원래 결함(파티션 테이블 0 bytes, 파티션이 어디에도 없음)을 고친다.
4. **PGlite 는 devDependency 로만.** 배포 패키지에는 들어가지 않는다.
5. **MCP 취소는 서버에서 돌던 문장도 멈춘다.** 취소가 오면 별도 연결로 CancelRequest(코드 80877102 · pid · secret)를 보내고, 5초 안에 연결이 돌아오지 않으면 소켓을 끊는다. 취소된 호출의 연결은 `DISCARD ALL` 로 정리하는 대신 버린다 — 취소가 어느 메시지 사이에 떨어졌는지 알 수 없어서다. 자동 커밋 문장의 RETURNING 행을 끝까지 읽는 도중이거나 잘린 포털을 닫기 전에 취소가 오면, Sync 를 보내지 않고 소켓을 끊는다. 그 Sync 가 곧 커밋이어서, 보냈다면 취소된 호출의 쓰기가 커밋되고 성공으로 보고됐다(3차). 마지막 읽기가 1000행을 못 채우면 그 읽기와 함께 Sync 가 이미 나갔으므로, 그 뒤의 취소는 확인하지 않고 커밋된 결과를 그대로 돌려준다 — 3차에서는 이것까지 "롤백됐다"고 보고했다(4차).

### 주요 수정 — 무엇이 틀렸고 왜 이렇게 고쳤나

**연결이 끊길 때 (critical).** pg-pool 은 연결을 빌려주는 동안 자기 `'error'` 리스너를 떼 둔다. 우리는 빌린 연결에 리스너를 달지 않았으므로, 질의 중에 DB 나 터널이 끊기면 처리되지 않은 `'error'` 이벤트로 **프로세스가 죽었다**. 이제 호출마다 리스너를 달고, 끊김을 질의와 경주(race)시켜 그 호출만 실패시키며, 그 연결은 풀에 돌려주지 않고 버린다(`release(err)`). `COPY … FROM STDIN / TO STDOUT` 도 같은 결과(pg-cursor 가 CopyIn 응답을 처리하지 못함)여서 "지원하지 않음"으로 거절한다.
- 세션이 끝난 오류인지는 **SQLSTATE** 로 먼저 가른다(57P01–57P05 · 25P03 · 25P04). 처음엔 severity 의 `FATAL` 을 봤는데, 실제 서버(`lc_messages=ko`)는 severity 를 `치명적오류` 로 보내고 pg-protocol 은 지역화되지 않은 `V` 필드를 버린다 — 실 PG 통합 시험에서 드러났다. 08 계열은 넣지 않는다: 08P01 은 params 개수가 틀렸을 때의 평범한 ERROR 이기도 해서, 넣었더니 실행조차 안 된 문장이 "연결이 끊겨 결과를 모른다"로 보고됐다(3차). 목록 밖의 지역화된 FATAL 도 그 문장은 중단시켰으므로 "적용되지 않았다"는 문구가 맞고, 닫힌 연결은 뒤따르는 ROLLBACK · DISCARD ALL 이 죽은 것을 발견해 버린다.

**늦게 오는 오류.** 자동 커밋 모드에서 지연 FK(`DEFERRABLE INITIALLY DEFERRED`)는 커서의 Sync 에서 암묵 커밋될 때 실패한다. pg-cursor 는 상태가 `done` 이 된 뒤의 오류를 버리므로 호출이 영원히 멈추고 연결이 샜다. `LateErrorCursor` 가 그 오류를 받아 둔다. 트랜잭션 모드의 `COMMIT` 실패는 `CommitError` 로 — 전체가 롤백됐다는 사실과 SQLSTATE 를 그대로 보인다.

**행 상한과 쓰기.** PostgreSQL 의 명령 태그(`INSERT 0 N`)는 포털을 여러 번 Execute 하면 **마지막 Execute 의 행 수만** 센다. 그래서 RETURNING 이 상한을 넘는 쓰기는 영향 행 수가 틀렸고, 안내는 "더 읽지 않았다, WHERE 로 좁혀라" — 실제로는 전부 실행된 뒤였다.
- 최상위가 `INSERT/UPDATE/DELETE/MERGE` 인 문장만 끝까지 읽어(drain, 1000행씩) 행 수를 직접 센다. `SELECT` 는 그대로 상한 + 1 행에서 멈춘다.
- 문구를 문장 종류별로 사실에 맞췄다.
  - SELECT 는 "한 행 더 읽고 멈췄다". "그 뒤는 계산하지 않았다"고 단정하던 문구는 뺐다(3차). select 목록 함수가 그 자체로 정렬 · DISTINCT · GROUP BY 키이면, 첫 행이 나오기 전에 모든 행에서 실행된다. 키가 다른 열이면 플래너가 함수를 정렬 위로 미뤄, 읽은 행에서만 실행된다 — "정렬하면 모든 행"이라고 넓게 쓴 3차 문구도 틀렸다(4차). 4차의 "키일 때만 모든 행" 도 틀렸다 — 집계 안, ORDER BY 없는 DISTINCT ON, 바깥에서 정렬하는 WITH · 서브쿼리 안의 함수도 모든 행에서 돈다(5차). 5차 문구도 조건 목록이 모자랐고(ORDER BY 없는 DISTINCT ON, EXCEPT, 두 번 조인되는 WITH), "적어도 보인 행 + 1" 이라는 하한도 `lag(f(x))` 나 CASE 안의 함수에서는 틀렸다(6차). 6차의 "PostgreSQL 이 첫 행 전에 모든 행을 읽으면 모든 행" 도 틀렸다 — 정렬 키가 아닌 함수는 정렬 위로 미뤄져, 모든 행을 읽어도 꺼낸 행에서만 돈다(7차). 그래서 지금은 횟수를 단정하지 않는다: "보인 것보다 많은 행에서 돌았을 수 있다 — 그 값이 정렬 · DISTINCT · GROUP BY · 집계 · 집합 연산에 쓰이거나, 정렬 · 그룹 · 조인되는 WITH · 서브쿼리에서 나오면 읽은 모든 행까지. 부작용은 SELECT 가 아니라 RETURNING 쓰기에".
  - `EXECUTE · SHOW · CALL` 은 첫 Execute 에서 끝까지 돌므로 "전부 실행됐고 앞부분만 보인다".
  - `WITH` 안에서 쓰는 SELECT 도 같다. PostgreSQL 이 이런 포털(PORTAL_ONE_MOD_WITH)은 첫 Execute 에서 바깥 쿼리까지 끝까지 계산해 둔다. 2차에서 "바깥 쿼리는 한 행 더 읽고 멈췄다"고 쓴 것은 틀렸다(3차).
  - `EXPLAIN` 은 실행 여부를 말하지 않는다. ANALYZE 가 없으면 감싼 쓰기는 실행되지 않았는데, "전부 실행됐다"가 그렇게 읽혔다(3차).

**값 그대로.** `numeric[]` · `bigint[]` 가 JS 숫자로 바뀌어 자릿수를 잃던 것, float `NaN/Infinity` 가 `null`(SQL NULL 과 구분 불가)로 나오던 것, 같은 이름 열의 `a#2` 가 실제 열 이름 `a#2` 와 겹치던 것, `__proto__` 열이 사라지던 것(행을 `Object.create(null)` 로)을 고쳤다. `params` 의 JSON 숫자가 ±2^53 을 넘으면 문자열로 보내라고 거절한다.

**가드.**
- DDL 판정을 최상위 문장 종류가 아니라 **AST 전체**로: `SELECT … INTO`, `EXPLAIN ANALYZE CREATE TABLE AS`, `PREPARE … SELECT INTO`, `REASSIGN OWNED` 가 `DB_ALLOW_DDL=false` 를 지나 커밋되고 있었다. 반대로 ANALYZE 없는 EXPLAIN 은 아무것도 실행하지 않으므로 DDL 도 쓰기도 아니다.
- 읽기 전용에서 **롤백으로 되돌릴 수 없는 함수**를 거절한다 — `pg_terminate_backend`, 복제 슬롯, `pg_stat_reset`, `lo_export` 등. READ ONLY 트랜잭션은 이것들을 막지 못하는데 결과에는 "read-only, rolled back" 이라고 쓰고 있었다. `set_config` 는 처음에 통째로 막았다가 `search_path` 까지 막는 회귀가 되어(2차 G1), 시간 제한(`statement_timeout` · `transaction_timeout`)과 이름이 상수가 아닌 경우만 막는다.
- `standard_conforming_strings` 를 off 로 바꾸는 `SET` 은 거절하고, 연결할 때 on 으로 고정한다. 가드의 파서(libpg-query)는 늘 on 으로 렉싱하므로, 서버가 off 면 가드가 본 `WHERE` 가 서버에서는 문자열 안으로 들어간다. on 으로 두는 `SET`(pg_dump 헤더, `= 1` 포함)은 통과(2차 G2). 같은 전환을 하는 다른 길도 막는다 — 이름이 상수가 아닌 `set_config`(값이 on 이 아닐 때)와 `UPDATE pg_settings`(뷰의 규칙이 `set_config` 를 부른다). 둘 다 같은 호출의 다음 문장에서 가드가 본 `WHERE` 를 지우는 데까지 재현됐다(3차).
- 거절을 세 가지로 나눴다 — `Refused by the guard`(정책: 바꿔서 다시 보내지 말고 보고), `Not supported by this tool`(COPY STDIN 등: 바꿔 쓰면 됨), `SQL syntax error`(고쳐서 다시). 에이전트가 정책 거절을 "다시 써서 통과시킬" 문제로 읽지 않게.
- 다중 문장을 자를 때 JS `trim()` 은 PostgreSQL 이 식별자 글자로 읽는 U+3000 · U+00A0 까지 지워, 서버가 실행하는 문장이 가드가 본 것과 달라졌다 → PostgreSQL 공백 6종만 지운다.
- `db_explain` 은 래퍼(`EXPLAIN (…)`)를 씌우기 전의 사용자 문장으로 deny 패턴과 정책을 검사한다(`^` 로 고정한 패턴이 빠지던 것). 래퍼에는 다시 적용하지 않는다 — `\banalyze\b` 패턴 하나로 모든 계획이 막혔다(3차). 도구 내부 카탈로그 SQL 에도 deny 패턴을 적용하지 않는다(`internalSql`).
- `db_explain` 은 `EXECUTE` 를 받지 않는다. 앞 호출의 `PREPARE` 는 호출 끝의 `DISCARD ALL` 로 사라지므로 늘 실패했다. 대신 준비된 문장의 SQL 을 `params` 와 함께 보내라고 안내한다. 3차에 안내한 `PREPARE …; EXPLAIN EXECUTE …` 는 읽기 전용 프로필이 `PREPARE` 를 거절해 정책 거절로 끝났다(4차). `PREPARE` 가 선언한 타입은 캐스트(`$1::numeric`)로 옮기라고도 말한다 — 빠지면 서버가 열 타입으로 추론해, 바로 그 타입 때문에 인덱스를 못 타는 계획과 다른 계획을 보인다(5차).

**출력 예산(`DB_MAX_OUTPUT`).** 문장 경계를 무시하고 뒤를 잘라 쓰기 문장의 결과가 통째로 사라지던 것 → 문장마다 머리줄(무엇이 실행됐고 몇 행)은 항상 남기고, 남는 예산으로 NOTICE 와 행을 채우며, 잘린 곳에 몇 개가 빠졌는지 적는다. 서버 오류 메시지 · detail 은 1000자, NOTICE 는 한 줄 500자 · 문장당 20개까지 — 입력값을 통째로 인용한 오류 하나가 "1–N 문장 커밋됨" 같은 결과 줄을 밀어내지 않게(2차 R5 · R6).
- 잘림 안내 줄도 예산에 넣는다. 처음 잘리는 문장 몫(안내 두 줄)과, 그 뒤 문장마다 짧은 안내 한 줄 몫을 미리 떼어 둔다. 2차에서는 안내 줄 두 개가 예산 밖이라, 쌓이면 마지막 쓰기 문장의 머리줄이 최종 컷에 잘렸다(3차). 처음 잘린 문장만 안내 두 줄로 자세히 말하고, 뒤에 잘린 문장은 "k notices and x of y rows not shown" 한 줄이다. 뒤 문장도 남은 예산에 들어가는 만큼은 보인다 — 3차에서 "첫 컷 뒤로는 머리줄만"으로 했더니, 넓은 목록 뒤의 `count(*)` 한 줄까지 숨었다(4차). 전부 들어가면 예약 없이 전부 보이고, 통째로 보이는 문장은 자기 안내 줄 몫을 자기 내용에 쓴다 — 4차에서는 예약이 풀리지 않아, 한도보다 짧은 출력에서도 count 한 줄이 그보다 긴 안내 줄로 바뀌었다(5차). 안내 줄을 쓰고 남은 예약도 돌려준다 — 첫 컷이 남긴 몫이 묶여 있어, 넓은 목록 뒤의 4~8행짜리 GROUP BY 결과가 숨었다(6차). 문장이 너무 많아 문장마다 안내 줄을 붙이면 한도를 넘는 경우에는, 머리줄을 모두 남기고 빠진 것을 한 줄로 말한다 — 전에는 최종 컷이 뒤 문장들의 머리줄을 잘랐다(6차, 원래 있던 결함). 그때도 머리줄이 남긴 예산은 통째로 들어가는 문장에 앞에서부터 준다 — 6차는 이 예산을 버려, 한도의 절반도 안 쓴 출력이 내용을 다 숨겼다(7차).
- **검토 뒤 다시 설계했다.** 위 3~7차의 문제는 모두 "문장 순서대로 한 번 훑으며 안내 줄 자리를 미리 떼어 두는" 구조에서 나왔다. 어떤 문장이 잘릴지는 다 훑기 전에는 모르므로 예약은 상한일 수밖에 없고, 남은 예약을 돌려주는 규칙을 덧붙일 때마다 다른 모양에서 샜다. 지금은 먼저 계획하고 그다음 렌더링한다.
  - 안내 줄은 빠진 수를 센다("… 15 of 20 rows not shown"). 더 보일수록 짧아지기만 하므로, 아무것도 안 보일 때의 길이가 정확한 상한이고, 줄을 더할 때 줄어드는 몫은 다시 쓸 수 있다.
  - 크기 순으로 통째로 넣다가, 다음 것을 넣으면 나머지가 저마다 안내 줄을 쓸 자리가 없어지는 지점에서 멈춘다. 남는 예산은 잘린 것들에 작은 것부터 준다. 출력 순서는 문장 순서 그대로다. 그래서 작은 결과가 큰 결과 때문에 잘리는 일은 없다(무작위 6만 건 측정에서 0건).
  - 잘린 것이 너무 많아 안내 줄들만으로 한도를 넘으면, 작은 것부터 통째로 넣고 나머지는 한 줄로 센다.
  - 머리줄만으로도 넘으면 연속된 같은 모양 문장(종류 · 행 수 문구 · DDL 이 같은 것)을 `[3–200] CREATE · 198 statements · DDL · 1–3 ms each` 한 줄로 접는다. 그래도 넘으면 섞인 이웃끼리 `[2–11] 10 statements: 8 SELECT, 2 CREATE` 구간으로 묶되, 들어가는 한 가장 잘게 나눈다. 어느 한도에서든 모든 문장 번호가 출력에 남는다.
  - 자동 커밋 실패의 커밋된 부분은 접지 않은 머리줄 전부를 최소치로 잡는다. 접은 형태를 최소치로 잡으면 NOTICE 가 자리를 더 가져가 필요 없이 접혔다. 그 최소치조차 안 들어갈 때만 다 접은 형태를 최소치로 쓴다(8차).
  - 8차 검토가 고친 것. 같은 모양 run 은 필요한 만큼만 접는다 — run 전체를 접으면 예산 대부분이 남은 채 RETURNING id 가 숨었다(이분 탐색으로 마지막 run 의 접는 길이를 정함). 내용 없는 run 을 먼저 접고, 그다음 절약량 순이다. 문장이 통째로 들어가는지 볼 때 그 문장의 비용은 min(통째, 안내 줄만)이다 — 짧은 행 하나를 안내 줄 값으로 세어 요약 모드로 떨어지거나, 작은 결과가 잘리고 큰 결과가 통째로 보였다. 블록이 하나뿐인 마지막 수단은 머리줄에 안내 줄을 붙인다(전에는 행 · NOTICE 가 표시 없이 사라졌다). 한 문장의 행이 약 12.5만 개를 넘으면 배열 전개(`...`)가 RangeError 로 죽어 커밋된 쓰기가 "db_query failed" 로 보고됐다 — 전개를 모두 반복문으로 바꿨다. 접기 루프는 run 을 한 번만 계산한다(4000문장 스크립트가 1~3초 걸리던 것).
  - 오류 경로의 서버 글(message · hint · detail · where)은 합쳐서 1000자다. 따로따로 1000자면 2000자 안팎 한도에서 결과 문구와 커밋된 머리줄이 모두 최종 컷에 잘렸다. 실패한 문장의 NOTICE 는 자리가 없어도 개수 줄 한 줄은 늘 남는다 — 커밋 부분이 자리를 다 가져가면 "batch 2 committed" 같은 진행 NOTICE 가 표시 없이 사라졌다. 그 개수 줄(약 60자) 때문에, 남은 자리가 커밋 머리줄 최소치보다 그만큼 못 미치게 크면 머리줄 몇 개가 접힌다 — NOTICE 를 지우는 쪽보다 낫다고 보고 그대로 둔다.
  - 문구. 쓰기의 RETURNING 이 잘리면 "the write itself is complete" 라고 말한다 — "select fewer columns or rows" 만 있으면 커밋된 쓰기를 다시 돌리게 한다. 머리줄은 "read"(읽었다)로 쓴다 — "shown" 은 출력 컷과 모순됐다. 드라이버가 보관하지 않은 NOTICE 는 "the statement sent K more than were kept" 로 따로 센다. 단수형("1 row", "1 more notice", "statement 1 was committed"). 잘린 NOTICE 의 안내가 잘라 낸 글보다 길면 원문을 그대로 둔다.
- 자동 커밋 실패의 "커밋된 결과" 부분이 통째로 들어가면, 실패 문장의 NOTICE 에는 그 나머지만 준다. 6차에서는 위 요약 형태 때문에 "커밋 부분 최소치" 가 작게 재여, 자리가 있는데도 커밋된 RETURNING id 가 모두 숨었다(7차).
- 드라이버가 문장당 20개 넘게 받은 NOTICE 는 개수만 따로 센다(`droppedNotices`). 그 개수를 알리는 줄을 NOTICE 하나로 세어, 25개가 "21 notices" 로 보였다(4차).
- 실패한 문장이 실패 전에 보낸 NOTICE 도 오류와 함께 보인다. 묶음마다 커밋하는 프로시저는 "batch 2 committed" 같은 진행 줄로 무엇이 남았는지 알려 주는데, 그 줄이 버려지고 있었다(3차).

**카탈로그.** 파티션(위 결정 3), 파티션이 만든 FK 복제 제약이 실제 FK 처럼 보이던 것, INVALID 인덱스(종류별 안내 — `ON ONLY` 로 만든 부모 인덱스는 `ATTACH PARTITION` 대기 중인 정상 상태), replica 전용 트리거, `NOT NULL … NOT VALID`, enum 배열 · 도메인, 생성 열 식, 시퀀스 설정, 5000행 상한을 알리지 않고 자르던 것을 고쳤다. PostgreSQL 12 이상을 요구한다(그 전에는 카탈로그 열이 없다).
- 이름은 모두 SQL 이 써야 하는 모양(`quote_ident`)으로 보여 주고, 받을 때도 같은 규칙으로 읽는다. 그래서 도구가 출력한 이름을 그대로 넣으면 같은 객체가 나온다. 2차에서는 테이블 이름에만 적용해, 한 화면 안에서 `"AspNetUsers"` 와 따옴표 없는 열 `Id` 가 섞였다. 3차부터 스키마 · 열 · 타입 · 제약 · 인덱스 · 트리거까지 같은 규칙이다.
- 다른 테이블을 가리키는 이름(partition of · inherits from · partitions · owned by)에는 늘 스키마를 붙인다. `::regclass::text` 는 search_path 에 보이는 스키마를 생략하는데, `db_describe` 는 스키마가 없으면 public 을 찾아 그 이름으로 다시 찾지 못했다(3차).
- 따옴표 없는 이름은 SQL 처럼 A–Z 만 접는다. 철자가 둘 다 있으면 SQL 이 고르는 쪽을 먼저 보이고, 다른 후보가 있다고 알린다(`db_tables` 의 스키마도 3차부터). 인자마다 자기 따옴표로만 읽고, 두 인자가 모두 스키마를 말하면 둘 다 허락하는 철자만 찾는다 — `"R4K".t` 에 schema `R4K` 를 주면 `r4k.t` 를 설명하던 것(4차).
- 스키마 없이 준 이름은 public 이 아니라 세션의 search_path 에서 찾는다(`current_schemas(true)` — temp · pg_catalog 포함, SQL 이 이름을 푸는 순서). 제약 · 트리거 정의처럼 PostgreSQL 이 search_path 기준으로 스키마를 생략해 찍는 이름도, 그대로 넣으면 SQL 과 같은 객체가 나온다(4차). 이름 철자 순서가 스키마 순서보다 먼저다 — 따옴표 없는 `SpOrder` 는 앞 스키마의 `"SpOrder"` 가 아니라 SQL 처럼 뒤 스키마의 `sporder` 다. 못 찾으면 찾아본 search_path 와 시도한 철자를 모두 말한다(5차). 따옴표 안내는 그것이 읽기를 바꿀 수 있을 때만 붙인다 — 점에서 실제로 나뉜 이름은 통째로 따옴표로(schema 인자와 함께 통째 이름으로 이미 찾았으면 붙이지 않음, 7차), 이름 부분이 따옴표 없는 소문자 하나뿐이면 대소문자 안내, 이미 따옴표로 쓴 이름 부분에는 없음(6 · 7차).

**설정.** 정책 변수(`DB_READONLY` 등)의 오타는 시작 실패 — 오타 난 `DB_READONLY` 는 조용히 쓰기 가능 서버가 된다. 그 밖의 변수 오타는 로그만 남긴다(관련 없는 `DB_*` 를 오타로 몰아 시작을 막던 2차 회귀). `DB_URL` 의 모르는 매개변수 거절, 포트 · 타이머 범위 검사.
- 오타 검사는 대소문자를 가리지 않는다. `db_readonly` 는 대소문자를 구분하는 POSIX 환경에서 `DB_READONLY` 가 아니어서, 경고도 없이 쓰기 가능 서버로 떴다. 대문자 이름으로 읽은 값이 같으면(Windows 처럼 대소문자를 무시하는 환경) 넘어간다. 뒤에 글자가 붙은 이름끼리 점수가 같으면 더 긴 이름을 고른다 — `DB_SSH_HOST_KEY_SHA256` 이 연결 변수 `DB_SSH_HOST` 로 판정돼, 호스트 키 고정이 빠진 채 로그만 남기고 떴다(3차). 잘린 이름(`DB_SS`)은 거꾸로 가장 짧은 완성형(`DB_SSL`)이 맞다. 3차에 이 규칙을 모든 동점에 적용했더니, `DB_SS` 가 `DB_SSH_PASSPHRASE` 로 판정돼 시작 실패 대신 경고로 끝났다(4차).
- `DB_DENY_PATTERNS` 는 JSON 으로 파싱되거나 JSON 문자열 배열 모양이면 JSON, 아니면 쉼표 목록이다(`{1,3}` 같은 수량자가 쉼표에서 쪼개지던 것). JSON 에서 `\b` 는 백스페이스여서, 역슬래시 하나로 쓴 `["\bdrop\b"]` 는 아무것에도 걸리지 않는 패턴이 되는데 "deny patterns 1" 로 보였다 — 시작 실패로 바꿨다(3차). 3차의 "`["` 로 시작하면 JSON" 은 따옴표 클래스로 시작하는 정규식(`["']\s*or`)까지 JSON 으로 읽어 시작을 막아서, 모양 검사로 좁혔다(4차). 4차의 "배열 전체 모양" 검사는 너무 좁아, 뒤에 꼬리 글이 붙은 JSON(`["\\bdrop\\b"] # no drops`)이 정규식 하나로 읽혀 deny 패턴이 조용히 사라졌다. 지금은 "첫 항목이 닫힌 문자열이고 그 뒤가 `,` `]` `"`" 이면 JSON 으로 본다(5차). 단 그 첫 문자열이 `]` 로 시작하면(큰따옴표 문자 클래스 `["]?secrets["]?`, `[ "]?…` 를 그렇게 읽은 것) 정규식이다(6 · 7차). `["'"]…` 처럼 JSON 과 정말 구분되지 않는 값은 시작 실패로 두고, 오류에 "그런 목록은 JSON 으로 쓰라" 를 덧붙였다.
- 원래 있던 결함 둘도 고쳤다. 없는 `DB_SSL_CA` 경로는 경고만 남긴 뒤 드라이버 생성자에서 맨 ENOENT 로 서버가 죽었다 → 시작 실패로 이유를 말한다. 읽기 전용 프로필의 `db_list_hosts` 가 "DDL allowed" 라고 하던 것 → "no DDL (read-only)".

**SSH 터널.** 연결 시간이 지난 뒤에 열린 채널이 새던 것, `close()` 중에 `ready` 가 오면 연결이 남던 것.

### 앞 절에서 바뀐 것

- §4 "`maxRows + 1` 개만 읽고 멈춘다" — `SELECT` 만. 최상위 쓰기 문장은 끝까지 읽는다(위 「행 상한과 쓰기」).
- §4 "`bigint` · `numeric` · 날짜는 문자열로" — 배열과 json 안의 숫자까지. json 은 손실 나는 숫자만 원문 그대로.
- §4 "같은 이름의 열은 `a`, `a#2`" — `a#2` 가 이미 있으면 다음 번호.
- §4 "호출마다 `DISCARD ALL`" — 취소됐거나 끊긴 호출의 연결은 정리하지 않고 버린다.
- §3 가드 표의 읽기 전용 단 — 문장 종류 외에 롤백되지 않는 함수 · 시간 제한 `set_config` 도 거절. `pg_terminate_backend` 는 여전히 재앙 단(항상 거절)에는 없다.

### 고치지 않은 것

- `DO $$ … $$` · 함수 본문은 문자열이라 가드가 보지 못한다(§3, 설계대로).
- 취소의 서버 쪽 효과(CancelRequest)는 PGlite 가 무시하므로 실 PostgreSQL 통합 시험에서만 확인된다.
- 행 상한에 걸린 `SELECT` 의 select 목록 함수는 보인 것보다 많은 행에서 실행됐을 수 있다(위 「행 상한과 쓰기」). 끝까지 읽으면 상한의 뜻(큰 결과를 계산하지 않음)이 사라지므로, 고치지 않고 문구로 알린다.
- 섞인 이웃을 구간으로 묶으면 그 문장들의 행 수는 사라지고 종류별 개수만 남는다. 머리줄조차 못 넣는 한도에서만 쓰는 마지막 수단이다. 그 구간에서 `CREATE TABLE AS` · `SELECT INTO` 는 명령 태그대로 `SELECT` 로 세어져 "8 SELECT · 2 DDL" 처럼 보인다(8차 W7, 낮음).
- 요약 모드("… the notices and rows of N of these statements are not shown")는 어느 문장의 NOTICE 가 숨었는지 말하지 않는다 — `already exists, skipping` 이 숨은 CREATE 가 새로 만든 것과 같아 보인다(8차 W3). 접기는 run 단위라, 접힌 run 안의 작은 결과가 밖의 더 큰 결과보다 먼저 숨을 수 있다.
- 안내 줄은 `DB_MAX_OUTPUT` 이라는 이름만 대고 값은 말하지 않는다 — 에이전트가 얼마나 좁혀야 하는지 가늠할 수 없다(8차 W8). `db_list_hosts` 의 Policy 줄에 값을 싣는 것이 자연스러운 자리다.
- 잘린 블록에 예산을 나눠 주는 루프는 패스마다 안내 줄을 다시 만들어, 안내 줄 길이와 행 길이가 정확히 맞아떨어지는 입력 + 수십만 자 한도에서만 이차로 느려진다(8차 EXT-4). 통째로 들어가는지 보는 빠른 길은 전체를 join 하므로, 행 합계가 V8 문자열 최대치(약 5억 자)를 넘으면 죽는다(8차 EXT-5) — 수백 MB 를 한 문장으로 받아야 하는 경우다.
- `DB_MAX_OUTPUT` 이 800자 안팎 이하면 오류 출력이 최종 컷에 잘렸다 — 서버 오류 메시지(최대 1000자) 하나가 한도보다 길 수 있어서다. 오류 출력도 예산에서 거꾸로 계산하는 배치를 둘 수 있었지만, 아무도 쓰지 않는 한도를 위해 또 하나의 어림 규칙을 넣는 셈이라 하지 않았다. 대신 하한 2,000자를 두어 그보다 작으면 다른 잘못된 값처럼 시작 실패로 처리한다(사용자 결정 2026-10-11: "1번은 진행하자").
- 이름에 쓰인 예약어(`user`, `order` 같은 스키마 이름)는 `quote_ident` 가 SQL 쪽에서 따옴표를 붙인다. 반면 도구가 JS 에서 직접 만드는 안내 문구(`No schema named …`)는 예약어를 모르고 소문자 이름을 그대로 쓴다 — 표시용 문구일 뿐이라 남겼다.
