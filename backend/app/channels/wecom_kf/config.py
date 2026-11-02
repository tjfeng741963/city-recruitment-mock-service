"""企微客服的凭证配置（环境变量，不进数据库不复述到日志）。"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class WeComSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_WECOM_", env_file=".env", extra="ignore")

    enabled: bool = False
    corp_id: str = ""
    app_secret: str = Field(default="", repr=False)
    callback_token: str = Field(default="", repr=False)
    encoding_aes_key: str = Field(default="", repr=False)
    open_kfid: str = ""
    device_code: str = "pc-office-01"

    @property
    def missing(self) -> list[str]:
        required = {
            "APP_WECOM_CORP_ID": self.corp_id,
            "APP_WECOM_APP_SECRET": self.app_secret,
            "APP_WECOM_CALLBACK_TOKEN": self.callback_token,
            "APP_WECOM_ENCODING_AES_KEY": self.encoding_aes_key,
            "APP_WECOM_OPEN_KFID": self.open_kfid,
        }
        return [name for name, value in required.items() if not value.strip()]

    @property
    def configured(self) -> bool:
        return self.enabled and not self.missing


@lru_cache
def get_wecom_settings() -> WeComSettings:
    return WeComSettings()


def reset_wecom_settings_cache() -> None:
    """测试里改了环境变量后调用。"""
    get_wecom_settings.cache_clear()
