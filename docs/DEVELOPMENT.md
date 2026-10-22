# 치이카와 모퉁이 · 개발 안내

[친구용 소개와 다운로드](../README.md)로 돌아가기.

이 문서는 구현·개발 명령과 **0.1.0에서 확인한 검증 기록**을 보관한다. 이후 릴리스의 배포 완료나 다른 기기에서의 실행 검증을 뜻하지 않는다. 공개 배포 파일과 버전은 [GitHub Releases](https://github.com/pilgrim13/chiikawa-corner/releases)를 기준으로 확인한다. 아래 모든 명령의 작업 폴더는 저장소 루트다.

친구 캐릭터가 Mac 바탕화면 아래에서 산책하고, 말풍선으로 대화하는 작은 앱.

## 설치 흐름

친구용 설치파일은 [최신 Mac DMG](https://github.com/pilgrim13/chiikawa-corner/releases/latest/download/Chiikawa-Corner-mac.dmg)에서 배포한다. 개발 Mac의 `release/` 경로는 다른 컴퓨터에서 직접 열 수 없다. 초기 0.1.0에서 사용한 임시 중계의 `/downloads/` 경로는 신규 다운로드 안내에 사용하지 않는다.

1. 내려받은 DMG를 열고 **Chiikawa Corner** 앱을 Applications로 끌어 놓는다.
2. **치이카와 모퉁이**를 실행하고 닉네임·캐릭터를 고른다.
3. **우리 방 만들기 → 친구 초대**를 누른다. 친구에게 앱과 복사된 초대장을 전달한다.
4. 친구는 **초대받았어요**에 초대장 전체를 붙여넣고, 방장은 **들어와!**를 누른다.
5. **창 접고 바탕화면에서 만나기**를 누르면 캐릭터만 남는다. 캐릭터 클릭, 메뉴바 아이콘, `⌘⇧Space`로 대화창을 다시 연다.

친구가 없어도 **먼저 혼자 둘러보기**로 세 캐릭터와 말풍선을 체험할 수 있다. 체험 친구는 실제 접속자가 아니며 화면에 명시된다. 별도 Node.js·터미널 설치가 필요 없는 앱이다.

이번 배포는 **macOS 13 이상, Apple Silicon·Intel 실행 파일을 함께 담은 통합 Mac 프로토타입**이다. 실제 실행 검증은 Apple Silicon에서 했다. 개발자 ID 인증서가 없어 Apple 공증은 하지 않았다. 앱 무결성용 ad-hoc 서명과 Apple이 확인한 배포 서명은 다르다. 다른 Mac에서 처음 실행할 때 차단된다면 해당 파일을 확인한 뒤 macOS **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 사용한다. 시스템 보안 전체를 끄는 방식은 사용하지 않는다.

## 현재 구현

- 치이카와·하치와레·우사기: 같은 그림체의 투명 PNG, 캐릭터 중복 선택 가능
- 최대 8인 임시방, 8자리 초대코드, 초대장으로 서버 주소 자동 연결
- 방장 승인·거절·추방·입장 잠금·초대코드 변경·방장 넘기기
- 200자 채팅, 최근 100개 기록, 전송 확인·중복 제거, 한국어 IME 입력
- 투명하고 포커스를 뺏지 않는 바탕화면 창, 화면 하단 배회, 최대 3개의 최근 말풍선
- 캐릭터 크기·숨김·조용히 모드·모니터 선택, 메뉴바·단축키
- 잠깐 끊긴 연결 복구, 오프라인 나가기 후 복귀 시 퇴장 정리
- 방장 연결 끊김 60초 뒤 자동 위임, 활동 중인 방의 오프라인 멤버 5분 뒤 정리
- 전원이 오프라인인 방은 10분 뒤 삭제. 서버 재시작 시 방·채팅은 삭제

## 프로토타입 연결 범위

기본 중계 주소는 `electron/config.json`에 있다. 초기 0.1.0은 개발 Mac의 전용 서버를 Cloudflare Quick Tunnel로 연결했다. 현재도 채팅 서버를 운영하는 Mac과 중계 프로세스가 켜져 있어야 인터넷 방이 작동하며, GitHub에 설치파일을 게시하는 것만으로 채팅 서버가 상시 운영되지는 않는다. 배포 전 실제 설정 파일과 접속 상태를 확인한다.

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
node scripts/verify-electron.mjs
npm run package:mac
```

패키징 후 `CORNER_EXECUTABLE="실제 .app/Contents/MacOS/Chiikawa Corner" node scripts/verify-electron.mjs`로 설치파일의 네이티브 동작을 확인할 수 있다. `TEST_SERVER_URL`로 시험할 서버를 고른다. 개발 서버가 켜진 상태에서 `scripts/verify-browser.mjs`, `scripts/verify-edge-cases.mjs`, `scripts/verify-ime.mjs`로 Chrome 두 사용자·재접속·한글 입력 검증도 재실행할 수 있다.

`server/index.mjs`는 독립 배포 가능하다. `HOST`, `PORT`, `ALLOWED_ORIGINS`로 네트워크 설정을 지정한다. 기본은 127.0.0.1:47831이며 외부 웹 미리보기 Origin은 명시적으로 허용한다. 서버는 인증정보나 채팅 본문을 로그에 기록하지 않는다. 세션 토큰은 본인 응답에만 포함되며 방장 권한을 모든 요청에서 검사한다. 계정 없는 프로토타입이라 사람 단위의 영구 차단은 제공하지 않는다.

구조: `electron/` 네이티브 창·브리지, `src/` 화면·배회·채팅, `server/` 중계, `shared/` 계약, `public/characters/` 캐릭터 그림. 중계 서버는 전용 포트·설정을 사용한다.

## 업데이트 배포 도구

앱의 업데이트 화면은 다운로드와 적용을 분리한다. 사용자가 **업데이트 확인 → 업데이트 다운로드 → 재시작하고 적용**을 선택한다. 0.1.0에는 이 기능이 없으므로 DMG로 한 번 교체해야 한다.

`scripts/release-sign.swift`는 현재 Mac의 Keychain 서비스 `com.corner.chiikawa.release-signing`, 계정 `ed25519-v1`만 조회한다. 잠금·접근 거부·형식 오류에서는 종료하고, 해당 항목이 없다는 조회 결과일 때만 Ed25519 개인키를 생성해 Keychain에 보관한다. 개인키는 파일·로그·명령 인자로 내보내지 않는다.

```sh
# 공개키만 출력한다. Keychain이 잠겨 있으면 먼저 이 Mac에서 잠금을 해제한다.
swift scripts/release-sign.swift public

# 서명·버전·universal 구성과 ZIP 내부 앱까지 검사한 뒤 로컬 피드를 준비한다.
node scripts/publish-update.mjs \
  --app "release/mac-universal/Chiikawa Corner.app" \
  --zip "release/Chiikawa-Corner-0.2.1-universal.zip" \
  --version 0.2.1 \
  --url "https://github.com/pilgrim13/chiikawa-corner/releases/download/v0.2.1/Chiikawa-Corner-0.2.1-universal.zip" \
  --notes "업데이트 내용"
```

위 명령은 **업로드하지 않고** `release-feed/latest.json`과 ZIP을 준비한다. 실제 릴리스 버전과 앱의 `CFBundleShortVersionString`이 같아야 한다. ZIP 최대 크기는 1 GiB, 설명은 6,000자다. 같은 버전의 다른 내용이나 이전 버전으로 `latest.json`을 덮어쓰지 않는다.

`latest.json`의 `payload`는 원본 JSON 바이트의 Base64이고, `signature`는 그 바이트의 Ed25519 서명이다. 내용은 앱 ID·버전·플랫폼·universal 아키텍처·다운로드 URL·크기·SHA-256·릴리스 설명을 포함한다. 앱에 넣은 공개키와 실제 배포 키, 피드 URL이 일치해야 한다.

앱 실행 시 사용하는 공개 설정만 저장소에 넣는다. Keychain 개인키, 배포 자격증명, 실제 사용자 채팅이나 테스트 세션은 커밋하지 않는다. `docs/preview.png`는 가상 친구 세 명의 체험 화면이다.

```sh
node --test scripts/publish-update.test.mjs
npm test
node scripts/verify-update-ui.mjs
```

위 도구의 존재와 통과한 개별 검증은 공개 서버에서의 다운로드·재시작·배포 완료와 별개다. 릴리스마다 설치파일·피드 서명·실제 업데이트 결과를 다시 확인한다.

## 0.1.0 검증 기록과 남은 확인

2026-10-22 Apple Silicon Mac에서 타입 검사, 서버 Socket.IO 통합 테스트 10개, 브라우저 두 사용자 전체 흐름과 IME·오프라인 퇴장, 실제 Electron 투명창·말풍선·숨김/복귀를 검증했다. 패키징된 앱에서 내장 서버 자동 시작 및 공개 HTTPS 중계를 통한 방 생성·채팅도 통과했다.

최종 통합 DMG(약 219 MiB)의 체크섬 검증, 앱의 ad-hoc 서명 무결성, x86_64·arm64 포함 확인을 통과했다. DMG를 실제로 마운트하고 앱을 프로젝트 안에 복사한 다음, 그 복사본에서 공개 중계 접속·방 생성·투명 캐릭터·말풍선·창 숨김/복귀·퇴장을 다시 통과했다. 추가 Computer Use 화면 확인은 검사 도구의 접근성·화면 기록 권한 대기로 수행하지 않았으며, 앱 사용 자체에 해당 권한은 필요하지 않다.

패키징 도구의 한글 NFC/NFD Helper 이름 불일치를 피하기 위해 내부 제품명은 `Chiikawa Corner`, 표시명과 UI는 `치이카와 모퉁이`로 분리했다. 이 설정은 Helper 프로세스 탐색에 영향을 주므로 단순히 한글 productName으로 되돌리지 않는다.

다음 단계는 상시 중계 주소 마련, Apple Developer ID 서명·공증, 실제 친구의 별도 Mac 현장 테스트다. Intel Mac·Windows·전체 화면 앱·다중 모니터 실물 테스트는 아직 완료하지 않았다. Windows 포팅 가능한 Electron 구조와 빌드 설정은 유지했다.

캐릭터 그림은 built-in imagegen으로 한 스타일 기준으로 생성했다. 정면 전신·초콜릿색 균일 윤곽선·평면 파스텔·분홍 볼·투명 배경·그림자 없음으로 맞추고, 치이카와 이미지를 나머지 두 캐릭터의 스타일 참고로 사용했다.
