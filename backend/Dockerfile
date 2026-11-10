FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    PIP_TRUSTED_HOST=mirrors.aliyun.com \
    UV_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
    UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/

WORKDIR /app

# No compiler toolchain needed: every dependency ships manylinux wheels
# (asyncpg, cryptography, pydantic-core). Skipping apt avoids the
# deb.debian.org 502 flakiness that stalls builds from this network.

COPY pyproject.toml ./
RUN pip install --no-cache-dir uv && \
    uv pip install --system -r pyproject.toml

COPY app ./app

# /app/data 与 /run/kb 必须先在镜像里存在且属于 appuser：容器以只读根文件
# 系统运行，两者都由命名卷覆盖。Docker 用镜像里的目录内容初始化新卷并保留
# 属主；目录不存在时会被建成 root 属主，appuser 就写不进去 ——
#   /app/data -> instance.json 写失败，启动直接退出
#   /run/kb   -> 服务令牌生成失败，Node 调知识库 401（线上已踩这两个）
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app/data /run/kb && \
    chown -R appuser:appuser /app /run/kb

USER appuser

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz').read()"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
