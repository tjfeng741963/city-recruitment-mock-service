"""企微 API 错误类型。

sender / client / sync 共用，避免循环 import。
`uncertain=True` 表示网络层结果不明（超时、连接中断），调用方不得盲目重投。
"""

from __future__ import annotations


class WeComApiError(Exception):
    def __init__(self, message: str, code: int | None = None, uncertain: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.uncertain = uncertain

    def __str__(self) -> str:  # pragma: no cover - 便于日志
        if self.code is not None:
            return f"{self.args[0]} (errcode={self.code})"
        return str(self.args[0])


# 常见 errcode → 中文说明，日志和接口错误都用它
ERROR_MESSAGES: dict[int, str] = {
    40001: "Secret 无效或未授权微信客服（应用需配置为「可调用接口的应用」）",
    40013: "corp_id 无效",
    40014: "access_token 无效",
    42001: "access_token 已过期",
    45009: "接口调用频率超限",
    60020: "服务器 IP 不在企业可信 IP 列表",
    95014: "接待人员未激活企业微信",
}


def describe(code: int | None) -> str:
    if code is None:
        return "未知错误"
    return ERROR_MESSAGES.get(code, f"企微错误码 {code}")
