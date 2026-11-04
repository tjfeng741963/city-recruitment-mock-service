"""请求/响应模型。请求与响应分开定义，避免把内部字段漏给客户端。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str
    role: str


class DeviceCreate(BaseModel):
    device_code: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9\-_]*$")
    name: str = Field(default="", max_length=128)


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_code: str
    name: str
    status: str
    agent_version: str
    wecom_state: str = "unknown"
    last_error: str = ""
    last_heartbeat_at: datetime | None


class DeviceCreated(DeviceOut):
    device_token: str


class HeartbeatIn(BaseModel):
    agent_version: str = ""
    capabilities: dict = Field(default_factory=dict)
    # 企业微信侧状态：online / login_required / not_running / hidden / unknown
    wecom_state: str = "unknown"
    queue_size: int = 0
    last_error: str = ""


class HeartbeatOut(BaseModel):
    ok: bool = True
    server_time: datetime


class ChannelCreate(BaseModel):
    device_id: int | None = None
    name: str = Field(min_length=1, max_length=128)
    external_id: str = Field(min_length=1, max_length=128, description="企业微信 open_kfid，wk 开头")
    corp_id: str = Field(default="", max_length=64)


class ChannelOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: int | None
    channel_type: str
    name: str
    external_id: str
    corp_id: str
    status: str
    last_sync_at: datetime | None
    last_error: str | None


class ChannelStatus(BaseModel):
    id: int
    name: str
    external_id: str
    status: str
    cursor_set: bool
    last_sync_at: datetime | None
    last_error: str | None
    auto_reply_ready: bool
    blocked_reason: str | None
