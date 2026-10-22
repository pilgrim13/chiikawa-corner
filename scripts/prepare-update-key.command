#!/bin/zsh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .runtime
trap 'printf "failed\n" > .runtime/update-key.status' ERR
printf "업데이트 배포용 공개키를 준비하고 있어요. 비밀키는 이 Mac의 키체인에만 보관돼요.\n"
/usr/bin/swift -suppress-warnings -module-cache-path /private/tmp/chiikawa-swift-module-cache scripts/release-sign.swift public > .runtime/release-public.pem
/opt/homebrew/bin/node --input-type=module <<'JS'
import fs from 'node:fs';
import { createPublicKey } from 'node:crypto';
const file = 'electron/update-config.json';
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const publicKey = fs.readFileSync('.runtime/release-public.pem', 'utf8');
createPublicKey(publicKey);
if (config.publicKey && config.publicKey !== publicKey) throw new Error('기존 앱에 고정한 공개키와 다릅니다. 변경하지 않았습니다.');
fs.writeFileSync(file, JSON.stringify({ ...config, publicKey }, null, 2) + '\n');
fs.writeFileSync('.runtime/update-key.status', 'ready\n');
console.log('공개키 준비 완료. 이 창은 닫아도 됩니다.');
JS
