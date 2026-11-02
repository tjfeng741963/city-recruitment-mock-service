"""企业微信回调消息加解密。

协议要点（企业微信「回调消息加解密」方案，与微信公众平台一致）：

- ``AESKey = base64.b64decode(encoding_aes_key + "=")`` → 32 字节，AES-256
- ``IV = AESKey[:16]``
- 明文结构：``random(16) + msg_len(4 字节大端 uint32) + msg(utf-8) + corp_id(utf-8)``
- 补位用 PKCS#7，但 block_size 是 **32** 而不是 16
- 密文整体再做基地 64
- 签名：``sha1("".join(sorted([token, timestamp, nonce, encrypt])))`` 的十六进制小写

AES 优先走 ``cryptography``（OpenSSL 后端）；该库缺失时退回内置的纯 Python 实现，
保证在最小依赖环境下也能跑。两条路径由 ``tests/test_crypto.py`` 的
Node/OpenSSL 交叉验证共同兜底。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import os
import struct
import xml.etree.ElementTree as ET

from .errors import WeComApiError

try:  # pragma: no cover - 取决于运行环境是否装了 cryptography
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    def _native_cipher(key: bytes, iv: bytes) -> Cipher:
        return Cipher(algorithms.AES(key), modes.CBC(iv))

except ImportError:  # pragma: no cover
    _native_cipher = None  # type: ignore[assignment]

__all__ = ["WeComCrypto", "parse_callback_xml"]


# --------------------------------------------------------------------------- #
# AES-256 内核（纯 Python，仅标准库）
# --------------------------------------------------------------------------- #
_AES_BLOCK = 16
_AES_ROUNDS = 14  # AES-256


def _xtime(a: int) -> int:
    """GF(2^8) 上乘 2。"""
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def _gmul(a: int, b: int) -> int:
    """GF(2^8) 乘法，模不可约多项式 x^8+x^4+x^3+x+1 (0x11B)。"""
    product = 0
    for _ in range(8):
        if b & 1:
            product ^= a
        b >>= 1
        a = _xtime(a)
    return product


def _build_tables() -> tuple[list[int], list[int], dict[int, list[int]]]:
    """构造 S 盒、逆 S 盒与常用乘法表（导入时算一次）。"""
    # 用本原元 3 的指数/对数表求 GF(2^8) 乘法逆元
    exp = [0] * 512
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x = _gmul(x, 3)
    exp[255:510] = exp[0:255]

    def inv(a: int) -> int:
        return 0 if a == 0 else exp[255 - log[a]]

    def rotl8(v: int, shift: int) -> int:
        return ((v << shift) | (v >> (8 - shift))) & 0xFF

    sbox = [0] * 256
    for i in range(256):
        b = inv(i)
        sbox[i] = b ^ rotl8(b, 1) ^ rotl8(b, 2) ^ rotl8(b, 3) ^ rotl8(b, 4) ^ 0x63

    inv_sbox = [0] * 256
    for i, v in enumerate(sbox):
        inv_sbox[v] = i

    muls = {n: [_gmul(i, n) for i in range(256)] for n in (2, 3, 9, 11, 13, 14)}
    return sbox, inv_sbox, muls


_SBOX, _INV_SBOX, _MUL = _build_tables()
_M2, _M3, _M9, _M11, _M13, _M14 = (_MUL[n] for n in (2, 3, 9, 11, 13, 14))


def _expand_key(key: bytes) -> list[list[int]]:
    """AES 密钥扩展，返回 Nr+1 组轮密钥，每组 16 字节。"""
    nk = len(key) // 4
    if len(key) != 32:
        raise ValueError("AES-256 expects a 32-byte key")
    words = [list(key[4 * i : 4 * i + 4]) for i in range(nk)]

    rcon = 0x01
    for i in range(nk, 4 * (_AES_ROUNDS + 1)):
        temp = list(words[i - 1])
        if i % nk == 0:
            temp = temp[1:] + temp[:1]          # RotWord
            temp = [_SBOX[b] for b in temp]     # SubWord
            temp[0] ^= rcon
            rcon = _xtime(rcon)
        elif nk > 6 and i % nk == 4:
            temp = [_SBOX[b] for b in temp]     # AES-256 额外的 SubWord
        words.append([words[i - nk][j] ^ temp[j] for j in range(4)])

    return [sum(words[4 * r : 4 * r + 4], []) for r in range(_AES_ROUNDS + 1)]


def _add_round_key(state: list[int], round_key: list[int]) -> None:
    for i in range(_AES_BLOCK):
        state[i] ^= round_key[i]


def _shift_rows(state: list[int]) -> list[int]:
    # state[r + 4c]：第 r 行左移 r 位
    out = [0] * _AES_BLOCK
    for r in range(4):
        for c in range(4):
            out[r + 4 * c] = state[r + 4 * ((c + r) % 4)]
    return out


def _inv_shift_rows(state: list[int]) -> list[int]:
    out = [0] * _AES_BLOCK
    for r in range(4):
        for c in range(4):
            out[r + 4 * c] = state[r + 4 * ((c - r) % 4)]
    return out


def _mix_columns(state: list[int]) -> list[int]:
    out = [0] * _AES_BLOCK
    for c in range(4):
        i = 4 * c
        a0, a1, a2, a3 = state[i], state[i + 1], state[i + 2], state[i + 3]
        out[i] = _M2[a0] ^ _M3[a1] ^ a2 ^ a3
        out[i + 1] = a0 ^ _M2[a1] ^ _M3[a2] ^ a3
        out[i + 2] = a0 ^ a1 ^ _M2[a2] ^ _M3[a3]
        out[i + 3] = _M3[a0] ^ a1 ^ a2 ^ _M2[a3]
    return out


def _inv_mix_columns(state: list[int]) -> list[int]:
    out = [0] * _AES_BLOCK
    for c in range(4):
        i = 4 * c
        a0, a1, a2, a3 = state[i], state[i + 1], state[i + 2], state[i + 3]
        out[i] = _M14[a0] ^ _M11[a1] ^ _M13[a2] ^ _M9[a3]
        out[i + 1] = _M9[a0] ^ _M14[a1] ^ _M11[a2] ^ _M13[a3]
        out[i + 2] = _M13[a0] ^ _M9[a1] ^ _M14[a2] ^ _M11[a3]
        out[i + 3] = _M11[a0] ^ _M13[a1] ^ _M9[a2] ^ _M14[a3]
    return out


def _encrypt_block(block: bytes, round_keys: list[list[int]]) -> bytes:
    state = list(block)
    _add_round_key(state, round_keys[0])
    for rnd in range(1, _AES_ROUNDS):
        state = _shift_rows([_SBOX[b] for b in state])
        state = _mix_columns(state)
        _add_round_key(state, round_keys[rnd])
    state = _shift_rows([_SBOX[b] for b in state])
    _add_round_key(state, round_keys[_AES_ROUNDS])
    return bytes(state)


def _decrypt_block(block: bytes, round_keys: list[list[int]]) -> bytes:
    state = list(block)
    _add_round_key(state, round_keys[_AES_ROUNDS])
    for rnd in range(_AES_ROUNDS - 1, 0, -1):
        state = _inv_shift_rows(state)
        state = [_INV_SBOX[b] for b in state]
        _add_round_key(state, round_keys[rnd])
        state = _inv_mix_columns(state)
    state = _inv_shift_rows(state)
    state = [_INV_SBOX[b] for b in state]
    _add_round_key(state, round_keys[0])
    return bytes(state)


def _aes_cbc_encrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    if len(data) % _AES_BLOCK:
        raise ValueError("data length must be a multiple of 16")
    if _native_cipher is not None:
        encryptor = _native_cipher(key, iv).encryptor()
        return encryptor.update(data) + encryptor.finalize()
    round_keys = _expand_key(key)
    out = bytearray()
    prev = iv
    for offset in range(0, len(data), _AES_BLOCK):
        block = bytes(x ^ y for x, y in zip(data[offset : offset + _AES_BLOCK], prev))
        prev = _encrypt_block(block, round_keys)
        out += prev
    return bytes(out)


def _aes_cbc_decrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    if not data or len(data) % _AES_BLOCK:
        raise ValueError("ciphertext length must be a non-zero multiple of 16")
    if _native_cipher is not None:
        decryptor = _native_cipher(key, iv).decryptor()
        return decryptor.update(data) + decryptor.finalize()
    round_keys = _expand_key(key)
    out = bytearray()
    prev = iv
    for offset in range(0, len(data), _AES_BLOCK):
        block = data[offset : offset + _AES_BLOCK]
        plain = _decrypt_block(block, round_keys)
        out += bytes(x ^ y for x, y in zip(plain, prev))
        prev = block
    return bytes(out)


# --------------------------------------------------------------------------- #
# 协议层
# --------------------------------------------------------------------------- #
_PAD_BLOCK = 32
_RANDOM_LEN = 16
_KEY_LEN = 32
_ENCODING_AES_KEY_LEN = 43


def _pkcs7_pad(data: bytes) -> bytes:
    """PKCS#7 补位，block_size = 32。"""
    pad = _PAD_BLOCK - len(data) % _PAD_BLOCK
    return data + bytes([pad]) * pad


def _pkcs7_unpad(data: bytes) -> bytes:
    if not data or len(data) % _PAD_BLOCK:
        raise WeComApiError("Invalid WeCom callback padding")
    pad = data[-1]
    if not 1 <= pad <= _PAD_BLOCK:
        raise WeComApiError("Invalid WeCom callback padding")
    if data[-pad:] != bytes([pad]) * pad:
        raise WeComApiError("Invalid WeCom callback padding")
    return data[:-pad]


class WeComCrypto:
    """企业微信回调加解密器。

    参数取自「企业微信后台 → 接收消息服务器配置」：
    ``token`` / ``encoding_aes_key`` / ``corp_id``（即 ReceiveId）。
    """

    def __init__(self, token: str, encoding_aes_key: str, corp_id: str) -> None:
        if len(encoding_aes_key) != _ENCODING_AES_KEY_LEN:
            raise ValueError(
                f"encoding_aes_key must be {_ENCODING_AES_KEY_LEN} characters, "
                f"got {len(encoding_aes_key)}"
            )
        try:
            key = base64.b64decode(encoding_aes_key + "=")
        except (binascii.Error, ValueError) as exc:
            raise ValueError("encoding_aes_key is not valid base64") from exc
        if len(key) != _KEY_LEN:
            raise ValueError("encoding_aes_key must decode to 32 bytes")

        self.token = token
        self.corp_id = corp_id
        self._key = key
        self._iv = key[:_AES_BLOCK]

    # -- 签名 ------------------------------------------------------------- #
    def signature(self, timestamp: str, nonce: str, encrypt: str) -> str:
        """dev_msg_signature / msg_signature：排序拼接后取 sha1 小写 hex。"""
        raw = "".join(sorted([self.token, timestamp, nonce, encrypt]))
        return hashlib.sha1(raw.encode("utf-8")).hexdigest()

    def _verify_signature(
        self, msg_signature: str, timestamp: str, nonce: str, encrypt: str
    ) -> None:
        expected = self.signature(timestamp, nonce, encrypt)
        provided = (msg_signature or "").lower()
        # 常量时间比较，避免时序侧信道；按字节比较以免非 ASCII 输入直接抛 TypeError
        if not hmac.compare_digest(expected.encode("utf-8"), provided.encode("utf-8", "ignore")):
            raise WeComApiError("Invalid WeCom callback signature")

    # -- 解密 ------------------------------------------------------------- #
    def decrypt(
        self, encrypt: str, msg_signature: str, timestamp: str, nonce: str
    ) -> str:
        """验签 → 解密 → 校验 corp_id，返回明文消息体。"""
        self._verify_signature(msg_signature, timestamp, nonce, encrypt)

        try:
            ciphertext = base64.b64decode(encrypt, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise WeComApiError("Invalid encrypted payload encoding") from exc
        if not ciphertext or len(ciphertext) % _AES_BLOCK:
            raise WeComApiError("Invalid encrypted payload length")

        try:
            padded = _aes_cbc_decrypt(self._key, self._iv, ciphertext)
        except ValueError as exc:  # 理论上已被上面的长度检查挡住
            raise WeComApiError("Failed to decrypt WeCom callback") from exc

        plain = _pkcs7_unpad(padded)

        if len(plain) < _RANDOM_LEN + 4:
            raise WeComApiError("Malformed WeCom callback payload")
        (msg_len,) = struct.unpack(">I", plain[_RANDOM_LEN : _RANDOM_LEN + 4])
        body_start = _RANDOM_LEN + 4
        body_end = body_start + msg_len
        if body_end > len(plain):
            raise WeComApiError("Malformed WeCom callback payload")

        try:
            msg = plain[body_start:body_end].decode("utf-8")
            receive_id = plain[body_end:].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WeComApiError("Malformed WeCom callback payload") from exc

        if receive_id != self.corp_id:
            raise WeComApiError("Callback enterprise mismatch")
        return msg

    # -- 加密 ------------------------------------------------------------- #
    def encrypt(self, msg: str, timestamp: str, nonce: str) -> tuple[str, str]:
        """返回 ``(encrypt_b64, msg_signature)``，供测试与本地模拟使用。"""
        msg_bytes = msg.encode("utf-8")
        plain = (
            os.urandom(_RANDOM_LEN)
            + struct.pack(">I", len(msg_bytes))
            + msg_bytes
            + self.corp_id.encode("utf-8")
        )
        ciphertext = _aes_cbc_encrypt(self._key, self._iv, _pkcs7_pad(plain))
        encrypt_b64 = base64.b64encode(ciphertext).decode("ascii")
        return encrypt_b64, self.signature(timestamp, nonce, encrypt_b64)


# --------------------------------------------------------------------------- #
# 回调 XML
# --------------------------------------------------------------------------- #
_FORBIDDEN_MARKUP = (b"<!doctype", b"<!entity")


def parse_callback_xml(raw: str | bytes) -> dict[str, str]:
    """把企微回调 XML 拍平成 ``tag -> text``。

    拒绝任何 DOCTYPE / ENTITY 声明（防 XXE / billion laughs）。
    """
    if isinstance(raw, bytes):
        data = raw
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WeComApiError("Invalid WeCom callback XML encoding") from exc
    else:
        text = raw
        data = raw.encode("utf-8", errors="ignore")

    lowered = data.lower()
    for marker in _FORBIDDEN_MARKUP:
        if marker in lowered:
            raise WeComApiError("XML with DTD is not allowed")

    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        raise WeComApiError("Invalid WeCom callback XML") from exc

    result: dict[str, str] = {}
    for elem in root.iter():
        if elem is root:
            continue
        tag = elem.tag.rsplit("}", 1)[-1] if isinstance(elem.tag, str) else ""
        if not tag:
            continue
        result[tag] = elem.text or ""
    return result
