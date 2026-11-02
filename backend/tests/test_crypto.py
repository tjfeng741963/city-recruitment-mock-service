"""企业微信回调加解密测试。

覆盖：往返、Unicode/emoji/长文本、签名篡改、corp_id 不匹配、非法 base64、
非法 payload 结构、encoding_aes_key 长度、回调 XML 解析与 XXE 拒绝。

另外做两类「跨实现」验证（都是纯本地、不联网）：
1. 黄金向量：由 Node/OpenSSL 按同一协议算出的固定密文，写死在下面做回归；
2. 动态交叉验证：临时目录里生成 Node 脚本，双向（Node 加密 → Python 解密、
   Python 加密 → Node 解密）比对。Node 不可用时自动 skip。
"""

from __future__ import annotations

import base64
import json
import shutil
import struct
import subprocess

import pytest

from app.channels.wecom_kf.crypto import (
    WeComCrypto,
    _aes_cbc_encrypt,  # 仅测试用来构造畸形载荷
    _pkcs7_pad,
    parse_callback_xml,
)
from app.channels.wecom_kf.errors import WeComApiError

TOKEN = "QDG6eK"
AES_KEY = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"  # 43 位，解码后 32 字节
CORP_ID = "ww1234567890abcdef"
TIMESTAMP = "1700000000"
NONCE = "abcdefghijk"

NODE = shutil.which("node")


@pytest.fixture()
def crypto() -> WeComCrypto:
    return WeComCrypto(TOKEN, AES_KEY, CORP_ID)


# --------------------------------------------------------------------------- #
# 1 & 2. 往返、Unicode/emoji、长文本
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "msg",
    [
        "",
        "a",
        "hello wecom",
        "x" * 15,           # 让 padding 边界刚好卡在 32 前后
        "x" * 16,
        "x" * 31,
        "x" * 32,
        "x" * 33,
        "中文消息 · 带标点，和换行\n第二行",
        "emoji 测试 🎉🚀👨‍👩‍👧‍👦 混合 ascii + 中文",
        "长文本：" + "企业微信回调加解密需要正确处理补位。" * 80,  # > 1000 字
    ],
)
def test_encrypt_decrypt_roundtrip(crypto: WeComCrypto, msg: str) -> None:
    encrypt_b64, msg_signature = crypto.encrypt(msg, TIMESTAMP, NONCE)
    assert msg_signature == crypto.signature(TIMESTAMP, NONCE, encrypt_b64)
    assert crypto.decrypt(encrypt_b64, msg_signature, TIMESTAMP, NONCE) == msg


def test_long_text_is_really_long(crypto: WeComCrypto) -> None:
    msg = "长文本校验：" + "企业微信" * 600  # 2400+ 字
    assert len(msg) > 1000
    encrypt_b64, sig = crypto.encrypt(msg, TIMESTAMP, NONCE)
    # 明文长度 16+4+msg+corpid 之后按 32 补位，密文一定是 32 的倍数
    assert len(base64.b64decode(encrypt_b64)) % 32 == 0
    assert crypto.decrypt(encrypt_b64, sig, TIMESTAMP, NONCE) == msg


def test_signature_formula(crypto: WeComCrypto) -> None:
    import hashlib

    encrypt_b64 = "Zm9vYmFy"
    expected = hashlib.sha1(
        "".join(sorted([TOKEN, TIMESTAMP, NONCE, encrypt_b64])).encode()
    ).hexdigest()
    assert crypto.signature(TIMESTAMP, NONCE, encrypt_b64) == expected
    assert len(crypto.signature(TIMESTAMP, NONCE, encrypt_b64)) == 40


# --------------------------------------------------------------------------- #
# 3. 签名被篡改
# --------------------------------------------------------------------------- #
def test_tampered_signature_rejected(crypto: WeComCrypto) -> None:
    encrypt_b64, sig = crypto.encrypt("hello", TIMESTAMP, NONCE)
    bad = ("0" if sig[0] != "0" else "1") + sig[1:]
    with pytest.raises(WeComApiError, match="Invalid WeCom callback signature"):
        crypto.decrypt(encrypt_b64, bad, TIMESTAMP, NONCE)


@pytest.mark.parametrize(
    ("timestamp", "nonce"),
    [("1700000001", NONCE), (TIMESTAMP, "zzzzzzzzzzz")],
)
def test_signature_bound_to_timestamp_and_nonce(
    crypto: WeComCrypto, timestamp: str, nonce: str
) -> None:
    encrypt_b64, sig = crypto.encrypt("hello", TIMESTAMP, NONCE)
    with pytest.raises(WeComApiError, match="Invalid WeCom callback signature"):
        crypto.decrypt(encrypt_b64, sig, timestamp, nonce)


def test_tampered_ciphertext_rejected(crypto: WeComCrypto) -> None:
    encrypt_b64, _ = crypto.encrypt("hello", TIMESTAMP, NONCE)
    raw = bytearray(base64.b64decode(encrypt_b64))
    raw[0] ^= 0xFF
    tampered = base64.b64encode(bytes(raw)).decode()
    sig = crypto.signature(TIMESTAMP, NONCE, tampered)
    with pytest.raises(WeComApiError):
        crypto.decrypt(tampered, sig, TIMESTAMP, NONCE)


def test_empty_signature_rejected(crypto: WeComCrypto) -> None:
    encrypt_b64, _ = crypto.encrypt("hello", TIMESTAMP, NONCE)
    with pytest.raises(WeComApiError, match="Invalid WeCom callback signature"):
        crypto.decrypt(encrypt_b64, "", TIMESTAMP, NONCE)


@pytest.mark.parametrize("sig", ["中文签名", "x" * 40, "0" * 41])
def test_non_ascii_or_wrong_length_signature_rejected(crypto: WeComCrypto, sig: str) -> None:
    """常量时间比较遇到非 ASCII / 长度不符也只能抛 WeComApiError，不能裸 TypeError。"""
    encrypt_b64, _ = crypto.encrypt("hello", TIMESTAMP, NONCE)
    with pytest.raises(WeComApiError, match="Invalid WeCom callback signature"):
        crypto.decrypt(encrypt_b64, sig, TIMESTAMP, NONCE)


# --------------------------------------------------------------------------- #
# 4. corp_id 不匹配
# --------------------------------------------------------------------------- #
def test_corp_id_mismatch_rejected(crypto: WeComCrypto) -> None:
    # 用同一套 token/key、但企业 ID 不同的实例加密，签名合法、ReceiveId 不合法
    other = WeComCrypto(TOKEN, AES_KEY, "ww_other_corp_0001")
    encrypt_b64, sig = other.encrypt("hello", TIMESTAMP, NONCE)
    with pytest.raises(WeComApiError, match="Callback enterprise mismatch"):
        crypto.decrypt(encrypt_b64, sig, TIMESTAMP, NONCE)


# --------------------------------------------------------------------------- #
# 5. 非法 base64 与畸形载荷
# --------------------------------------------------------------------------- #
def test_invalid_base64_rejected(crypto: WeComCrypto) -> None:
    payload = "!!!not-base64@@@"  # 字符集非法
    sig = crypto.signature(TIMESTAMP, NONCE, payload)  # 签名先过关，才能走到解码
    with pytest.raises(WeComApiError):
        crypto.decrypt(payload, sig, TIMESTAMP, NONCE)


def test_wrong_length_ciphertext_rejected(crypto: WeComCrypto) -> None:
    payload = base64.b64encode(b"0123456789").decode()  # 10 字节，非 16 的倍数
    sig = crypto.signature(TIMESTAMP, NONCE, payload)
    with pytest.raises(WeComApiError):
        crypto.decrypt(payload, sig, TIMESTAMP, NONCE)


def test_empty_ciphertext_rejected(crypto: WeComCrypto) -> None:
    sig = crypto.signature(TIMESTAMP, NONCE, "")
    with pytest.raises(WeComApiError):
        crypto.decrypt("", sig, TIMESTAMP, NONCE)


def _seal(crypto: WeComCrypto, plain: bytes, *, pad: bool = True) -> tuple[str, str]:
    """把自定义明文封成 (base64 密文, 合法签名)，用于构造畸形载荷。"""
    key = base64.b64decode(AES_KEY + "=")
    body = _pkcs7_pad(plain) if pad else plain
    encrypt_b64 = base64.b64encode(_aes_cbc_encrypt(key, key[:16], body)).decode()
    return encrypt_b64, crypto.signature(TIMESTAMP, NONCE, encrypt_b64)


def test_padding_error_rejected(crypto: WeComCrypto) -> None:
    # 64 字节且末字节为 0x00：长度合法但补位非法
    payload, sig = _seal(crypto, bytes(64), pad=False)
    with pytest.raises(WeComApiError, match="padding"):
        crypto.decrypt(payload, sig, TIMESTAMP, NONCE)


def test_msg_len_out_of_range_rejected(crypto: WeComCrypto) -> None:
    plain = b"\x00" * 16 + struct.pack(">I", 4096) + b"hi" + CORP_ID.encode()
    payload, sig = _seal(crypto, plain)
    with pytest.raises(WeComApiError):
        crypto.decrypt(payload, sig, TIMESTAMP, NONCE)


def test_too_short_payload_rejected(crypto: WeComCrypto) -> None:
    payload, sig = _seal(crypto, b"\x00" * 10)  # 连 random+len 都不够
    with pytest.raises(WeComApiError):
        crypto.decrypt(payload, sig, TIMESTAMP, NONCE)


# --------------------------------------------------------------------------- #
# 6. encoding_aes_key 校验
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "bad_key",
    [
        "",
        "tooshort",
        AES_KEY[:-1],                    # 42 位
        AES_KEY + "A",                   # 44 位
        "!" * 43,                        # 长度对但非 base64 字符
        "abcdefghijklmnopqrstuvwxyz0123456789ABCDEF",  # 42 位
    ],
)
def test_invalid_encoding_aes_key_length(bad_key: str) -> None:
    with pytest.raises(ValueError):
        WeComCrypto(TOKEN, bad_key, CORP_ID)


def test_valid_encoding_aes_key_ok(crypto: WeComCrypto) -> None:
    assert crypto.corp_id == CORP_ID


# --------------------------------------------------------------------------- #
# 7. 回调 XML
# --------------------------------------------------------------------------- #
XML_OK = (
    "<xml>"
    "<ToUserName><![CDATA[ww1234567890abcdef]]></ToUserName>"
    "<FromUserName><![CDATA[zhangsan]]></FromUserName>"
    "<CreateTime>1700000000</CreateTime>"
    "<MsgType><![CDATA[text]]></MsgType>"
    "<Content><![CDATA[你好 <b>世界</b> & 测试]]></Content>"
    "<MsgId>1234567890123456</MsgId>"
    "<AgentID>1000002</AgentID>"
    "</xml>"
)


def test_parse_callback_xml_text() -> None:
    parsed = parse_callback_xml(XML_OK)
    assert parsed["ToUserName"] == "ww1234567890abcdef"
    assert parsed["FromUserName"] == "zhangsan"
    assert parsed["CreateTime"] == "1700000000"
    assert parsed["MsgType"] == "text"
    assert parsed["Content"] == "你好 <b>世界</b> & 测试"
    assert parsed["MsgId"] == "1234567890123456"
    assert parsed["AgentID"] == "1000002"


def test_parse_callback_xml_accepts_bytes() -> None:
    assert parse_callback_xml(XML_OK.encode("utf-8"))["MsgType"] == "text"


def test_parse_callback_xml_encrypted_event() -> None:
    raw = (
        "<xml><ToUserName><![CDATA[ww1234567890abcdef]]></ToUserName>"
        "<Encrypt><![CDATA[abc+/def==]]></Encrypt>"
        "<AgentID><![CDATA[1000002]]></AgentID></xml>"
    )
    parsed = parse_callback_xml(raw)
    assert parsed["Encrypt"] == "abc+/def=="
    assert parsed["AgentID"] == "1000002"


@pytest.mark.parametrize(
    "raw",
    [
        # 外部实体（典型 XXE）
        '<?xml version="1.0"?><!DOCTYPE xml [<!ENTITY xxe SYSTEM "file:///c:/windows/win.ini">]>'
        "<xml><Content>&xxe;</Content></xml>",
        # 内部实体膨胀（billion laughs）
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">'
        '<!ENTITY lol2 "&lol;&lol;&lol;">]><xml><Content>&lol2;</Content></xml>',
        # 无实体声明的 DOCTYPE 也一律拒绝
        '<!DOCTYPE xml><xml><Content>hi</Content></xml>',
        # 大小写/空白变体
        '<!doctype xml SYSTEM "http://evil/x.dtd"><xml><Content>hi</Content></xml>',
        # ENTITY 单独出现
        '<!ENTITY foo "bar"><xml><Content>hi</Content></xml>',
    ],
)
def test_parse_callback_xml_rejects_dtd(raw: str) -> None:
    with pytest.raises(WeComApiError, match="XML with DTD is not allowed"):
        parse_callback_xml(raw)


def test_parse_callback_xml_rejects_dtd_in_bytes() -> None:
    raw = b'<!DOCTYPE xml [<!ENTITY x SYSTEM "file:///etc/passwd">]><xml><Content>&x;</Content></xml>'
    with pytest.raises(WeComApiError, match="XML with DTD is not allowed"):
        parse_callback_xml(raw)


@pytest.mark.parametrize("raw", ["", "not xml at all", "<xml><a></xml>"])
def test_parse_callback_xml_invalid_rejected(raw: str) -> None:
    with pytest.raises(WeComApiError):
        parse_callback_xml(raw)


# --------------------------------------------------------------------------- #
# 跨实现验证 A：Node 生成的黄金向量（写死，无需 Node 也能回归）
# --------------------------------------------------------------------------- #
# 由 Node v22 crypto 模块（aes-256-cbc + 自实现 32 字节 PKCS#7）生成：
#   token=QDG6eK  aes_key=AES_KEY  corpid=ww1234567890abcdef
#   timestamp=1700000000  nonce=abcdefghijk
#   random 前缀固定为 000102030405060708090a0b0c0d0e0f
GOLDEN_VECTORS = [
    (
        "hello wecom",
        "IG+0eOkLdhYW9kHtuT3HY3QsUuC5EgYrXLsu3i251V1MJ8MbmBriSKXhClLHnAtvi8A3T6KZ9oOC8tR68TzXqg==",
        "4635cf441586ecab9ccb76bc3adf99062bacbf30",
    ),
    (
        "你好，企业微信 <hello> 🎉 客服消息 #42",
        "IG+0eOkLdhYW9kHtuT3HY++6yedNx+YufKqm6hg3ruodUe4ltjQz1uxdWHyYRy1s7At02bXa20Bs9phjoCQ2UtL"
        "5sQkqzqUOgdPFciYd3lFVKg5zPL1K2TAtOIWOBJJb",
        "4c3c6fd773045937904c81ab12a27da3ae8263a5",
    ),
]


@pytest.mark.parametrize(("plaintext", "encrypt_b64", "msg_signature"), GOLDEN_VECTORS)
def test_golden_vector_from_node(
    crypto: WeComCrypto, plaintext: str, encrypt_b64: str, msg_signature: str
) -> None:
    # 签名算法一致（sha1 + 排序拼接）
    assert crypto.signature(TIMESTAMP, NONCE, encrypt_b64) == msg_signature
    # OpenSSL 加密的密文，Python 能解出原文
    assert crypto.decrypt(encrypt_b64, msg_signature, TIMESTAMP, NONCE) == plaintext


# --------------------------------------------------------------------------- #
# 跨实现验证 B：临时 Node 脚本双向比对（Node 不可用则 skip）
# --------------------------------------------------------------------------- #
NODE_SCRIPT = r"""
// 企业微信回调加解密 · Node(OpenSSL) 参考实现，仅用于交叉验证。
// argv[2] = 输入 JSON 文件路径；结果以 JSON 写到 stdout。
const crypto = require('crypto');
const fs = require('fs');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { token, aes_key, corp_id, timestamp, nonce, random_hex, plaintext, ciphertext } = input;

const key = Buffer.from(aes_key + '=', 'base64');
if (key.length !== 32) throw new Error('bad aes key length: ' + key.length);
const iv = key.subarray(0, 16);

function pad(buf, block) {
  const amount = block - (buf.length % block);
  return Buffer.concat([buf, Buffer.alloc(amount, amount)]);
}

function unpad(buf, block) {
  if (buf.length % block !== 0) throw new Error('bad ciphertext length');
  const p = buf[buf.length - 1];
  if (p < 1 || p > block) throw new Error('bad padding');
  for (let i = 0; i < p; i++) {
    if (buf[buf.length - 1 - i] !== p) throw new Error('bad padding content');
  }
  return buf.subarray(0, buf.length - p);
}

function sign(t, ts, n, e) {
  return crypto.createHash('sha1').update([t, ts, n, e].sort().join('')).digest('hex');
}

function encrypt(msgText) {
  const msg = Buffer.from(msgText, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msg.length, 0);
  const body = pad(Buffer.concat([
    Buffer.from(random_hex, 'hex'),
    lenBuf,
    msg,
    Buffer.from(corp_id, 'utf8'),
  ]), 32);
  const enc = crypto.createCipheriv('aes-256-cbc', key, iv);
  enc.setAutoPadding(false);
  return Buffer.concat([enc.update(body), enc.final()]).toString('base64');
}

function decrypt(b64) {
  const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
  dec.setAutoPadding(false);
  const raw = unpad(Buffer.concat([dec.update(Buffer.from(b64, 'base64')), dec.final()]), 32);
  const mlen = raw.readUInt32BE(16);
  return {
    msg: raw.subarray(20, 20 + mlen).toString('utf8'),
    receive_id: raw.subarray(20 + mlen).toString('utf8'),
  };
}

const out = {};
if (typeof plaintext === 'string') {
  out.encrypt_b64 = encrypt(plaintext);
  out.msg_signature = sign(token, timestamp, nonce, out.encrypt_b64);
}
if (typeof ciphertext === 'string') {
  out.decrypted = decrypt(ciphertext);
}
process.stdout.write(JSON.stringify(out));
"""

needs_node = pytest.mark.skipif(NODE is None, reason="node 不可用，跳过动态交叉验证")


def _run_node(tmp_path, payload: dict) -> dict:
    script = tmp_path / "wecom_crypto_ref.js"
    if not script.exists():
        script.write_text(NODE_SCRIPT, encoding="utf-8")
    arg = tmp_path / "payload.json"
    arg.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    proc = subprocess.run(  # noqa: S603 - 本地固定命令，无用户输入拼接
        [NODE, str(script), str(arg)],
        capture_output=True,
        timeout=120,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    return json.loads(proc.stdout.decode("utf-8"))


def _node_payload(**overrides) -> dict:
    payload = {
        "token": TOKEN,
        "aes_key": AES_KEY,
        "corp_id": CORP_ID,
        "timestamp": TIMESTAMP,
        "nonce": NONCE,
        "random_hex": "000102030405060708090a0b0c0d0e0f",
    }
    payload.update(overrides)
    return payload


@needs_node
@pytest.mark.parametrize(
    "msg",
    [
        "hello wecom",
        "中文 + emoji 🎉",
        "长文本 " + "企业微信回调" * 200,
    ],
)
def test_node_encrypt_python_decrypt(tmp_path, crypto: WeComCrypto, msg: str) -> None:
    result = _run_node(tmp_path, _node_payload(plaintext=msg))
    encrypt_b64 = result["encrypt_b64"]
    sig = result["msg_signature"]

    assert sig == crypto.signature(TIMESTAMP, NONCE, encrypt_b64)
    assert crypto.decrypt(encrypt_b64, sig, TIMESTAMP, NONCE) == msg


@needs_node
@pytest.mark.parametrize(
    "msg",
    [
        "hello wecom",
        "中文 + emoji 🎉",
        "长文本 " + "企业微信回调" * 200,
    ],
)
def test_python_encrypt_node_decrypt(tmp_path, crypto: WeComCrypto, msg: str) -> None:
    encrypt_b64, sig = crypto.encrypt(msg, TIMESTAMP, NONCE)
    result = _run_node(tmp_path, _node_payload(ciphertext=encrypt_b64))
    assert result["decrypted"]["msg"] == msg
    assert result["decrypted"]["receive_id"] == CORP_ID


@needs_node
def test_node_reference_consistent_with_golden(tmp_path) -> None:
    """固定 random 前缀时，Node 输出必须与写死的黄金向量逐字节一致。"""
    for plaintext, encrypt_b64, msg_signature in GOLDEN_VECTORS:
        result = _run_node(tmp_path, _node_payload(plaintext=plaintext))
        assert result["encrypt_b64"] == encrypt_b64
        assert result["msg_signature"] == msg_signature
