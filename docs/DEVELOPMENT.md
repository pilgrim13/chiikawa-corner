# 치이카와 모퉁이 · 개발 안내

[친구용 소개와 다운로드](../README.md)로 돌아가기.

이 문서는 구현·개발 명령과 버전별 검증 기록을 보관한다. 공개 배포 파일과 버전은 [GitHub Releases](https://github.com/pilgrim13/chiikawa-corner/releases)를 기준으로 확인한다. 아래 모든 명령의 작업 폴더는 저장소 루트다.

친구 캐릭터가 Mac·Windows 바탕화면 구석에서 산책하고, 브라우저 탭 안의 정원에서도 말풍선으로 대화하는 작은 앱.

## 설치 흐름

친구용 설치파일은 같은 [GitHub 릴리스](https://github.com/pilgrim13/chiikawa-corner/releases/latest)에 Mac DMG와 Windows EXE를 함께 올린다. 개발 Mac의 `release/` 경로는 다른 컴퓨터에서 직접 열 수 없다. 초기 0.1.0에서 사용한 임시 중계의 `/downloads/` 경로는 신규 다운로드 안내에 사용하지 않는다.

1. Mac은 [DMG](https://github.com/pilgrim13/chiikawa-corner/releases/latest/download/Chiikawa-Corner-mac.dmg)를 열고 **Chiikawa Corner** 앱을 Applications로 끌어 놓는다. Windows는 [EXE](https://github.com/pilgrim13/chiikawa-corner/releases/latest/download/Chiikawa-Corner-windows.exe)를 실행해 사용자 계정에 설치한다.
2. **치이카와 모퉁이**를 실행하고 닉네임·캐릭터를 고른다.
3. **우리 방 만들기 → 친구 초대** 또는 브라우저의 **링크 초대**를 누른다. 친구에게 복사된 초대장·링크를 전달한다.
4. 친구는 링크를 열거나 **초대받았어요**에 8자리 코드·초대장을 입력해 바로 입장한다. 방장 승인 과정은 없다. 입장 잠금·8인 정원 검사는 그대로 적용된다.
5. 설치 앱의 **창 접고 바탕화면에서 만나기**를 누르면 캐릭터만 남는다. 캐릭터 클릭, Mac 메뉴바/Windows 트레이 아이콘, Mac `⌘⇧Space`/Windows `Ctrl+Shift+Space`로 대화창을 다시 연다. 브라우저에서는 탭 안 정원 또는 지원 브라우저의 작은 채팅창을 사용한다.

친구가 없어도 **먼저 혼자 둘러보기**로 캐릭터와 말풍선을 체험할 수 있다. 체험 친구는 실제 접속자가 아니며 화면에 명시된다. 별도 Node.js·터미널 설치가 필요 없는 앱이다.

Mac 배포는 **macOS 13 이상, Apple Silicon·Intel 실행 파일을 함께 담은 통합 프로토타입**이다. 실제 실행 검증은 Apple Silicon에서 했다. 개발자 ID 인증서가 없어 Apple 공증은 하지 않았다. 앱 무결성용 ad-hoc 서명과 Apple이 확인한 배포 서명은 다르다. 다른 Mac에서 처음 실행할 때 차단된다면 해당 파일을 확인한 뒤 macOS **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 사용한다. 시스템 보안 전체를 끄는 방식은 사용하지 않는다.

## 현재 구현

- 치이카와·하치와레·우사기·모몽가·쿠리만쥬·시사·랏코·후루혼야: 같은 그림체의 투명 PNG, 캐릭터 중복 선택 가능
- 최대 8인 임시방, 8자리 초대코드로 즉시 입장, 초대장으로 서버 주소 자동 연결
- 방장 추방 시 초대코드 자동 변경·입장 잠금·초대코드 수동 변경·방장 넘기기
- 200자 채팅, 최근 100개 기록, 전송 확인·중복 제거, 한국어 IME 입력
- 투명하고 포커스를 뺏지 않는 바탕화면 창, 화면 하단 배회, 최대 3개의 최근 말풍선
- 캐릭터 크기·숨김·조용히 모드·모니터 선택, 메뉴바·단축키
- 잠깐 끊긴 연결 복구, 오프라인 나가기 후 복귀 시 퇴장 정리
- 방장 연결 끊김 60초 뒤 자동 위임, 활동 중인 방의 오프라인 멤버 5분 뒤 정리
- 전원이 오프라인인 방은 10분 뒤 삭제. 영속 저장이 켜진 서버는 재시작해도 방 코드·방장·최근 채팅·재접속 정보 유지
- 마지막 채팅 뒤 10분이 지나면 캐릭터가 잠들고 경과 분을 표시. 산책·깡충·손 흔들기·빙글 돌기·빼꼼·통통 등 동작
- 브라우저에서 같은 방을 쓰는 탭 안 정원, 방 코드를 담은 초대 링크, 지원 브라우저의 Document Picture-in-Picture 작은 채팅창. 작은 창은 원래 탭이 열려 있어야 한다

## 프로토타입 연결 범위

기본 중계 주소는 `electron/config.json`에 있다. 초기 0.1.0은 개발 Mac의 전용 서버를 Cloudflare Quick Tunnel로 연결했다. 0.3.0은 Tailscale Funnel의 `https://junnyeonglee-macmini.taile9e6e.ts.net/chiikawa/`를 웹판·신규 앱의 고정 주소로 사용한다. Funnel은 `/chiikawa`만 전용 서버로 연결하며 다른 경로는 변경하지 않는다. 기존 0.2.1 클라이언트용 Cloudflare 주소도 같은 서버로 연결한다. 현재도 채팅 서버를 운영하는 Mac이 켜져 있어야 인터넷 방이 작동하며, GitHub에 설치파일을 게시하는 것만으로 채팅 서버가 상시 운영되지는 않는다. 배포 전 실제 설정 파일과 접속 상태를 확인한다.

브라우저와 Mac·Windows 앱은 기본적으로 위의 같은 서버를 사용하므로 8자리 코드만으로 서로의 방에 들어갈 수 있다. 직접 저장한 서버 설정은 우선 적용되므로 다른 서버를 설정한 사용자는 초대장으로 주소를 맞춰야 한다. 현재 서버는 코드가 유효하고 입장이 가능한 방에 즉시 멤버를 추가한다. 구버전 설치 앱이 기다리는 `join:approved` 이벤트도 ACK보다 먼저 전송하므로, 예전 화면에 승인 안내가 남아 있어도 방장 조작 없이 입장한다. API 상세는 `shared/CONTRACT.md`를 참고한다.

이 Mac mini에서는 `~/Library/LaunchAgents/com.corner.chiikawa-relay.plist`가 로그인 시 전용 서버를 자동 시작하고, 종료되면 다시 실행한다. `launchctl print gui/$(id -u)/com.corner.chiikawa-relay`와 공개 `/chiikawa/health`로 실제 상태를 확인한다. 웹 파일은 같은 저장소의 `dist/`에서 제공된다. 운영 중 웹 변경에는 `npm run deploy:web`을 사용한다. 별도 경로에서 타입 검사·빌드를 끝내고 정적 자산을 복사한 다음 HTML을 마지막에 교체하므로, 웹 화면 교체 때문에 서버를 재시작하지 않는다. Mac이 꺼져 있거나 로그인 전이면 공개 주소도 응답하지 않을 수 있다. Cloudflare Quick Tunnel 주소는 구버전 호환용 임시 주소라 새 설치에는 사용하지 않는다.

신규 단독 서버는 `.runtime/rooms-v1.json`에 방·멤버·초대 코드·최근 채팅·재전송 확인을 매 변경마다 원자적으로 기록한다. 세션 토큰 원문은 서버 파일에 저장하지 않고 해시만 저장한다. 권한은 0600이며 Git에서 제외한다. 재시작 뒤 접속 중이던 사람들은 각 앱·브라우저가 보관한 토큰으로 같은 방에 자동 복귀한다. 전원 오프라인 상태가 10분을 넘으면 방은 삭제된다. 저장 실패 시 서버는 채팅을 더 받지 않고 `/health`에서 503을 반환한다. 라이브 방의 업데이트는 먼저 격리 환경에서 `node scripts/verify-room-restart.mjs`를 통과시킨 뒤 적용한다. **최초 전환 예외:** 구 메모리 전용 서버가 이미 가진 방은 저장 파일이 없어 새 서버로 자동 이전되지 않는다. 현재 방이 비기 전에는 운영 서버를 재시작하지 않는다.

`연결 설정`에서 새 서버 주소를 적용할 수 있으며, 새 주소가 포함된 전체 초대장을 붙여넣어도 자동 변경된다. 연결 실패 때 체험 모드는 계속 사용할 수 있다. 로컬 서버만 시험하려면 `CORNER_SERVER_URL=http://127.0.0.1:47831 npm start`로 실행한다. 해당 포트가 비어 있으면 앱이 내장 서버를 시작한다.

## 개발

```sh
npm ci
npm run server
# 별도 터미널
npm run dev
# 설치형 앱으로 실행
npm run build
npm start
```

```sh
npm run typecheck
npm test
node scripts/verify-room-restart.mjs # 격리 서버+Chrome으로 재시작 뒤 실제 방 복귀 확인
node scripts/verify-electron.mjs
npm run package:mac
npm run package:win # Windows x64에서 실행
```

패키징 후 `CORNER_EXECUTABLE="실제 .app/Contents/MacOS/Chiikawa Corner" node scripts/verify-electron.mjs`로 설치파일의 네이티브 동작을 확인할 수 있다. `TEST_SERVER_URL`로 시험할 서버를 고른다. 개발 서버가 켜진 상태에서 `scripts/verify-browser.mjs`, `scripts/verify-edge-cases.mjs`, `scripts/verify-ime.mjs`로 Chrome 두 사용자·재접속·한글 입력 검증도 재실행할 수 있다. `node scripts/verify-web.mjs`는 공개 웹에서 초대 링크·코드로 즉시 입장·양방향 채팅·새로고침 복귀를 확인한다. 390px 검사는 모바일 **화면 크기**의 데스크톱 Chrome 에뮬레이션이며 실제 휴대전화 테스트는 아니다. 즉시 입장 변경 후에는 방장 화면 조작 없이 입장하는지, 구버전 이벤트 수신으로 입장하는지, 잠금·정원 제한이 유지되는지도 확인한다.

`server/index.mjs`는 독립 배포 가능하다. `HOST`, `PORT`, `ALLOWED_ORIGINS`, `CORNER_STATE_PATH`로 네트워크·저장 경로를 지정한다. 기본은 127.0.0.1:47831 및 프로젝트 `.runtime/rooms-v1.json`이며 외부 웹 미리보기 Origin은 명시적으로 허용한다. `createRoomServer()`를 직접 호출하는 테스트·Electron의 임시 로컬 중계는 `stateFile` 옵션이 없으면 저장하지 않아 운영 방과 충돌하지 않는다. 서버는 인증정보나 채팅 본문을 로그에 기록하지 않는다. 세션 토큰은 본인 응답에만 포함되며 방장 권한을 모든 요청에서 검사한다. 계정 없는 프로토타입이라 사람 단위의 영구 차단은 제공하지 않는다.

구조: `electron/` 네이티브 창·브리지, `src/` 화면·배회·채팅, `server/` 중계, `shared/` 계약, `public/characters/` 캐릭터 그림. 중계 서버는 전용 포트·설정을 사용한다.

## 업데이트 배포 도구

앱의 업데이트 화면은 다운로드와 적용을 분리한다. 사용자가 **업데이트 확인 → 업데이트 다운로드 → 재시작하고 적용**을 선택한다. 0.1.0에는 이 기능이 없으므로 DMG로 한 번 교체해야 한다.

`scripts/release-sign.swift`는 현재 Mac의 Keychain 서비스 `com.corner.chiikawa.release-signing`, 계정 `ed25519-v1`만 조회한다. 잠금·접근 거부·형식 오류에서는 종료하고, 해당 항목이 없다는 조회 결과일 때만 Ed25519 개인키를 생성해 Keychain에 보관한다. 개인키는 파일·로그·명령 인자로 내보내지 않는다. Windows 빌드에도 동일한 배포 공개키를 앱에 고정하고, 설치파일 해시를 이 Mac에서 서명한다.

```sh
# 공개키만 출력한다. Keychain이 잠겨 있으면 먼저 이 Mac에서 잠금을 해제한다.
swift scripts/release-sign.swift public

# 서명·버전·universal 구성과 ZIP 내부 앱까지 검사한 뒤 로컬 피드를 준비한다.
node scripts/publish-update.mjs \
  --app "release/mac-universal/Chiikawa Corner.app" \
  --zip "release/Chiikawa-Corner-0.3.0-universal.zip" \
  --version 0.3.0 \
  --url "https://github.com/pilgrim13/chiikawa-corner/releases/download/v0.3.0/Chiikawa-Corner-0.3.0-universal.zip" \
  --notes "업데이트 내용"

# Windows CI가 실제 설치·업데이트를 통과한 EXE를 내려받은 뒤 같은 키로 서명한다.
node scripts/publish-windows-update.mjs \
  --exe ".runtime/windows-artifact/Chiikawa-Corner-0.3.0-windows-x64-Setup.exe" \
  --version 0.3.0 \
  --url "https://github.com/pilgrim13/chiikawa-corner/releases/download/v0.3.0/Chiikawa-Corner-0.3.0-windows-x64-Setup.exe" \
  --notes "업데이트 내용"
```

위 명령은 **업로드하지 않고** `release-feed/latest.json`·`win-latest.json`과 검증된 ZIP·EXE를 준비한다. 실제 릴리스 버전과 앱 버전이 같아야 한다. 파일 최대 크기는 1 GiB, 설명은 6,000자다. 같은 버전의 다른 내용이나 이전 버전으로 피드를 덮어쓰지 않는다.

서명한 manifest의 ZIP·EXE URL은 `releases/download/v0.3.0/...`처럼 **릴리스 버전과 파일명이 고정된 주소**를 사용한다. `releases/latest/download/...` 주소를 설치파일 URL에 넣으면 다음 릴리스 뒤 이전 manifest가 다른 파일을 받아 해시 검증에 실패할 수 있다. Windows는 `Chiikawa-Corner-0.3.0-windows-x64-Setup.exe`를 올리고, 그 파일의 동일한 복사본을 README 다운로드 버튼용 `Chiikawa-Corner-windows.exe` 이름으로 함께 올린다. Mac의 버튼용 이름은 `Chiikawa-Corner-mac.dmg`다. 별칭과 원본의 SHA-256이 같아야 한다.

GitHub 릴리스는 초안으로 만들고 검증된 Mac DMG·버전별 ZIP·`latest.json`, Windows 버전별 EXE·동일한 EXE 별칭·`win-latest.json`을 모두 업로드한 뒤 정식 최신 릴리스로 공개한다. 그러면 앱의 두 피드 주소와 README 다운로드 버튼이 같은 완성된 릴리스를 가리킨다. Windows EXE는 해당 커밋의 CI에서 실제 설치·업데이트 검증을 통과한 artifact를 사용한다. 공개 후 두 피드의 서명을 앱에 고정한 공개키로 확인하고, manifest의 고정 URL에서 받은 파일의 크기·SHA-256 및 두 다운로드 별칭을 다시 확인한다.

피드의 `payload`는 원본 JSON 바이트의 Base64이고, `signature`는 그 바이트의 Ed25519 서명이다. 내용은 앱 ID·버전·플랫폼·아키텍처·다운로드 URL·크기·SHA-256·릴리스 설명을 포함한다. 앱에 넣은 공개키와 실제 배포 키, 피드 URL이 일치해야 한다. Windows는 별도 PowerShell 프로세스가 기존 앱 종료 후 NSIS를 조용히 설치하고 새 앱 시작 확인을 남긴다.

앱 실행 시 사용하는 공개 설정만 저장소에 넣는다. Keychain 개인키, 배포 자격증명, 실제 사용자 채팅이나 테스트 세션은 커밋하지 않는다. `docs/preview.png`는 격리된 테스트 방의 가상 친구 네 명을 촬영한 화면이다.

```sh
node --test scripts/publish-update.test.mjs
npm test
node scripts/verify-update-ui.mjs
```

위 도구의 존재와 통과한 개별 검증은 공개 서버에서의 다운로드·재시작·배포 완료와 별개다. 릴리스마다 설치파일·피드 서명·실제 업데이트 결과를 다시 확인한다.

## 0.4.0 준비 — 2026-10-23

0.3.1의 코드 입장 변경을 포함해 새 영속 중계, 8종 캐릭터의 새 그림·수면 그림, 10분 무채팅 수면·경과 분 라벨, 브라우저·작은 창·바탕화면의 여러 동작을 합쳤다. `npm test` 57/57, 타입 검사, 격리 Chrome 두 명의 서버 재시작 후 방 코드·대화·새 채팅 복귀, 구버전 서버의 방장 수락·대화·새로고침 호환성을 확인했다. 수면·기상과 메시지 100개 뒤의 마지막 채팅 시각도 확인했다.

운영 방 수가 0개인 것을 직전에 확인하고 서버를 저장형 코드로 재시작했다. 공개 주소에서 코드 즉시 입장·양방향 채팅·새로고침 복귀를 통과했고 테스트 방은 퇴장 후 정리됐다. 저장 파일 `.runtime/rooms-v1.json`은 권한 0600이며 검증 뒤 방 수 0개였다. 웹 UI는 별도 빌드·HTML 마지막 교체로 반영했고, 새 수면 그림이 공개 URL에서 HTTP 200으로 제공되는 것을 확인했다. Mac·Windows 앱의 공개 릴리스와 서명된 업데이트 피드는 별도로 준비·검증해야 한다.

Mac 0.4.0 universal DMG·ZIP을 빌드했고 앱의 ad-hoc 서명, arm64·x86_64 포함, 버전 표기와 DMG 실제 마운트·Applications 링크를 검사했다. 패키징한 앱의 바탕화면 캐릭터·말풍선·창 접기·복귀도 확인했다. 격리된 설치본 0.2.0 → 0.4.0을 실제 업데이트 버튼으로 실행해 서명된 **로컬 시험 피드** 다운로드·검증, 앱 교체·재시작, 프로필·기존 방·채팅 복귀를 통과했다. [Windows 0.4.0 CI](https://github.com/pilgrim13/chiikawa-corner/actions/runs/39918910616)에서도 x64 NSIS 설치본 빌드, 구버전 설치→버튼 업데이트, 새 앱 실행을 통과했다.

실제 공개 피드는 기존 배포 키가 든 Mac mini 로그인 Keychain이 잠겨 아직 만들지 못했다. 키가 읽힐 때 Mac·Windows 파일을 같은 GitHub 릴리스에 올리고 두 업데이트 피드를 서명·검증해야 한다. 그 전까지 GitHub 최신 다운로드와 앱 안의 업데이트는 0.3.0이다.

## 0.3.1 준비 — 2026-10-23

코드만으로 브라우저·앱이 즉시 입장하는 서버·웹 UI를 구현했다. 구버전 앱의 `join:approved` 이벤트를 유지하고, 추방 때 초대 코드를 자동 변경한다. 타입 검사·자동 테스트 47개, 격리 서버의 브라우저 초대·즉시 입장·채팅·새로고침 검증을 통과했다. Mac universal 앱 0.3.1 DMG·ZIP을 빌드하고 ad-hoc 서명과 arm64/x86_64 구성을 확인했다.

현재 공개 서버에는 사용 중인 방이 있으므로 프로세스를 재시작하지 않았다. 공개 웹의 정적 파일은 안정 버전 0.3.0으로 복원했다. Keychain 로그인 키체인이 잠겨 서명 피드를 만들 수 없으므로 앱 업데이트와 GitHub 최신 릴리스도 아직 0.3.0이다. 방이 비고 서명키를 사용할 수 있을 때 서버 적용, 공개 웹 E2E, Mac·Windows 서명 피드와 설치본 배포, 실제 업데이트 검증이 남았다.

## 0.3.0 검증 — 2026-10-22

아래는 즉시 입장으로 바꾸기 전 승인 방식의 검증 기록이다. 현재 사용 흐름은 위의 코드로 즉시 입장을 따른다.

Mac mini에서 8종 캐릭터·혼합 버전 방 입장·재접속 순서 검사, updater의 서명·해시·실패 복구를 포함한 자동 테스트 **47개**와 타입 검사를 통과했다. 1000×780 및 680×560 UI에서 8종 선택과 채팅 입력 영역을 확인했다. 공개 웹판의 두 사용자 방 생성·초대·방장 승인·새 캐릭터·채팅·새로고침 복귀와 Chrome Document Picture-in-Picture의 작은 창 채팅·복귀를 확인했다. Mac universal 앱의 ad-hoc 코드 서명·arm64/x86_64 구성도 확인했다.

실제 공개 **0.2.1 DMG 설치본 → 0.3.0**을 격리된 앱 복사본으로 업데이트해 새 프로세스 시작, 설정·기존 방·채팅 복원을 확인했다. [Windows 실기 CI](https://github.com/pilgrim13/chiikawa-corner/actions/runs/39755564732)에서는 x64 NSIS 설치본 0.2.9 → 0.3.0 버튼 업데이트, 새 앱 시작, 방·채팅·프로필 복원, 일반 기능 smoke를 통과했다. Windows 빌드의 배포 서명키는 GitHub Actions로 보내지 않았다.

최종 Mac DMG를 실제 마운트해 0.3.0 앱과 `/Applications` 드래그 링크를 확인했다. 이미지 체크섬, 앱 ad-hoc 서명, arm64·x86_64 구성을 검증했다. 패키징한 0.3.0 앱으로 고정 HTTPS 중계의 방 생성·투명 바탕화면 캐릭터·말풍선·창 접기/복귀·퇴장까지 실행했다. 같은 중계의 공개 브라우저판도 슬래시 없는 주소 자동 이동, 두 사용자 초대·승인·양방향 채팅·새로고침 복귀를 확인했다.

구버전과 신버전은 같은 방에 참여할 수 있다. 0.2.1 이하 앱에 없는 새 캐릭터는 서버가 기본 치이카와 모습으로 보내고, 0.3.0 앱에는 원래 캐릭터를 보낸다. 서버는 메모리 기반이므로 새 서버 코드 적용 시 이미 열린 방은 보존할 수 없고, 이용 중인 방이 없을 때 재시작한다.

## 0.2.1 검증 — 2026-10-22

Mac mini Apple Silicon에서 타입 검사와 자동 테스트 **39개**를 통과했다. 서명·파일 변조 차단, 네트워크 오류 후 재시도, 중복 업데이트 차단, 실제 native swap과 새 앱 실행 실패 시 원본 복구를 검사했다.

`scripts/verify-update-native.mjs`로 격리된 **패키징 앱 0.2.0 → 0.2.1**을 업데이트 버튼으로 다운로드·교체·재시작했다. 새 프로세스와 버전, 로컬 UI 시작 확인, 닉네임·캐릭터·localStorage 보존, 기존 방·채팅 재접속을 통과했다. 테스트용 서명 피드는 로컬 HTTP로 격리했으며 실제 배포 피드는 GitHub의 HTTPS와 앱에 고정된 공개키를 사용한다.

최종 0.2.1 DMG의 체크섬과 앱 전체 코드 서명, x86_64·arm64 포함 여부도 확인했다. Intel Mac과 다른 사용자의 MacBook 실물 실행은 별도 확인 대상이다.

## 0.1.0 검증 기록과 남은 확인

2026-10-22 Apple Silicon Mac에서 타입 검사, 서버 Socket.IO 통합 테스트 10개, 브라우저 두 사용자 전체 흐름과 IME·오프라인 퇴장, 실제 Electron 투명창·말풍선·숨김/복귀를 검증했다. 패키징된 앱에서 내장 서버 자동 시작 및 공개 HTTPS 중계를 통한 방 생성·채팅도 통과했다.

0.1.0 통합 DMG(약 219 MiB)의 체크섬 검증, 앱의 ad-hoc 서명 무결성, x86_64·arm64 포함 확인을 통과했다. DMG를 실제로 마운트하고 앱을 프로젝트 안에 복사한 다음, 그 복사본에서 공개 중계 접속·방 생성·투명 캐릭터·말풍선·창 숨김/복귀·퇴장을 다시 통과했다. 추가 Computer Use 화면 확인은 검사 도구의 접근성·화면 기록 권한 대기로 수행하지 않았으며, 앱 사용 자체에 해당 권한은 필요하지 않다.

패키징 도구의 한글 NFC/NFD Helper 이름 불일치를 피하기 위해 내부 제품명은 `Chiikawa Corner`, 표시명과 UI는 `치이카와 모퉁이`로 분리했다. 이 설정은 Helper 프로세스 탐색에 영향을 주므로 단순히 한글 productName으로 되돌리지 않는다.

다음 단계는 Apple Developer ID 서명·공증, Windows 코드 서명, 실제 친구의 별도 기기 테스트다. Intel Mac·전체 화면 앱·다중 모니터 실물 테스트는 아직 완료하지 않았다.

캐릭터 그림은 built-in imagegen으로 한 스타일 기준으로 생성했다. 정면 전신·초콜릿색 균일 윤곽선·평면 파스텔·분홍 볼·투명 배경·그림자 없음으로 맞추고, 치이카와 이미지를 나머지 캐릭터의 스타일 참고로 사용했다.
