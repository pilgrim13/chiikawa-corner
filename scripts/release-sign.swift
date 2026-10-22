#!/usr/bin/swift
// The private signing key is read directly from this Mac's Keychain. Never export it.
import Foundation
import Security
import CryptoKit

private let signingService = "com.corner.chiikawa.release-signing"
private let signingAccount = "ed25519-v1"

private enum SignerError: Error, CustomStringConvertible {
    case usage
    case keychain(String, OSStatus)
    case invalidKey
    case invalidPayload

    var description: String {
        switch self {
        case .usage:
            return "사용법: release-sign.swift public | release-sign.swift sign <payload-file>"
        case let .keychain(operation, status):
            let detail = SecCopyErrorMessageString(status, nil) as String? ?? "알 수 없는 Keychain 오류"
            return "Keychain \(operation) 실패 (\(status)): \(detail). 기존 항목을 변경하지 않았어."
        case .invalidKey:
            return "기존 Keychain 서명키 형식이 올바르지 않아. 키를 교체하거나 새로 만들지 않았어."
        case .invalidPayload:
            return "서명할 payload는 1 MiB 이하의 일반 파일이어야 해."
        }
    }
}

private func itemAttributes() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: signingService,
        kSecAttrAccount as String: signingAccount,
        kSecAttrSynchronizable as String: false,
    ]
}

private func readKey() throws -> Curve25519.Signing.PrivateKey? {
    // A missing item can be reported even while the default keychain is locked.
    // Check its state first so we never generate a replacement in that situation.
    var keychain: SecKeychain?
    let defaultStatus = SecKeychainCopyDefault(&keychain)
    guard defaultStatus == errSecSuccess, let keychain else { throw SignerError.keychain("기본 저장소 확인", defaultStatus) }
    var keychainStatus: SecKeychainStatus = 0
    let stateStatus = SecKeychainGetStatus(keychain, &keychainStatus)
    guard stateStatus == errSecSuccess else { throw SignerError.keychain("잠금 상태 확인", stateStatus) }
    guard (keychainStatus & UInt32(kSecUnlockStateStatus)) != 0 else { throw SignerError.keychain("잠금 상태 확인", errSecInteractionNotAllowed) }
    var query = itemAttributes()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    // The file-based macOS Keychain uses this API rather than authentication-UI query keys.
    // A locked keychain or denied access is an error, never a missing-key signal.
    let interactionStatus = SecKeychainSetUserInteractionAllowed(false)
    guard interactionStatus == errSecSuccess else { throw SignerError.keychain("비대화형 접근 설정", interactionStatus) }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess else { throw SignerError.keychain("조회", status) }
    guard var raw = result as? Data, raw.count == 32 else { throw SignerError.invalidKey }
    defer { raw.resetBytes(in: raw.startIndex..<raw.endIndex) }
    do { return try Curve25519.Signing.PrivateKey(rawRepresentation: raw) }
    catch { throw SignerError.invalidKey }
}

private func signingKey() throws -> Curve25519.Signing.PrivateKey {
    if let key = try readKey() { return key }

    // Reached only after the exact service/account lookup returned errSecItemNotFound.
    let key = Curve25519.Signing.PrivateKey()
    var item = itemAttributes()
    item[kSecAttrLabel as String] = "Chiikawa Corner release signing (Ed25519)"
    item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    item[kSecValueData as String] = key.rawRepresentation
    let status = SecItemAdd(item as CFDictionary, nil)
    if status == errSecDuplicateItem {
        // Another publisher might have created the item between our read and add.
        guard let existing = try readKey() else { throw SignerError.keychain("동시 생성 후 조회", errSecItemNotFound) }
        return existing
    }
    guard status == errSecSuccess else { throw SignerError.keychain("생성", status) }
    return key
}

private func publicPEM(_ key: Curve25519.Signing.PublicKey) -> String {
    // RFC 8410 SubjectPublicKeyInfo: Ed25519 OID 1.3.101.112 and a 32-byte bit string.
    let prefix: [UInt8] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]
    let encoded = (Data(prefix) + key.rawRepresentation).base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
    return "-----BEGIN PUBLIC KEY-----\n\(encoded)\n-----END PUBLIC KEY-----\n"
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let output: String
    if arguments == ["public"] {
        output = publicPEM(try signingKey().publicKey)
    } else if arguments.count == 2 && arguments[0] == "sign" {
        let url = URL(fileURLWithPath: arguments[1])
        let metadata = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard metadata.isRegularFile == true, let size = metadata.fileSize, size <= 1_048_576 else { throw SignerError.invalidPayload }
        let payload = try Data(contentsOf: url)
        guard payload.count <= 1_048_576 else { throw SignerError.invalidPayload }
        output = try signingKey().signature(for: payload).base64EncodedString() + "\n"
    } else {
        throw SignerError.usage
    }
    FileHandle.standardOutput.write(Data(output.utf8))
} catch {
    FileHandle.standardError.write(Data("release-sign: \(error)\n".utf8))
    exit(1)
}
