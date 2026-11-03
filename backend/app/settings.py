"""运行配置：所有环境变量从 APP_ 前缀读入，代码里不再直接碰 os.environ。"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env", extra="ignore")

    env: str = "dev"
    host: str = "127.0.0.1"
    port: int = 8090

    # 本地默认 SQLite；生产改成 postgresql+asyncpg://user:pass@host/db
    database_url: str = "sqlite+aiosqlite:///./data/app.db"
    sql_echo: bool = False

    jwt_secret: str = "dev-only-secret-change-in-production"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 480

    # 首次启动自动创建的管理员（仅在用户表为空时生效）
    seed_admin_username: str = "local-admin"
    seed_admin_password: str = "local-demo-only"

    # 默认租户：单租户阶段所有 kb_* 表的 tenant_id 都指向它。
    # 接第二个客户后这里只是租户 1 的元数据，不影响其他租户。
    default_tenant_name: str = "默认租户"
    default_tenant_slug: str = "default"

    # LLM：OpenAI 兼容中转站。换供应商只改这三个值，代码不动。
    # 没配置时自动降级到模板回复，不会阻塞客户消息。
    llm_base_url: str = "http://127.0.0.1:1/v1"
    llm_api_key: str = "unset"
    llm_model: str = "doubao-pro-32k"
    llm_timeout: float = 30.0

    # 服务间调用令牌：Node 侧自动回复链路没有用户身份，
    # 带 X-Service-Token 直连 /api/v1/kb/*。留空表示关闭这条路径。
    kb_service_token: str = ""

    # 后台任务：生产默认都开。测试里 lifespan 不会跑（ASGITransport），不影响用例。
    outbox_worker: bool = True
    outbox_interval: float = 5.0
    sync_worker: bool = True
    sync_interval: float = 15.0


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
