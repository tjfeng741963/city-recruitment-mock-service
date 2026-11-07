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

# /app/data 必须先在镜像里存在且属于 appuser：容器以只读根文件系统运行，
# data 由命名卷覆盖。Docker 用镜像里的目录内容初始化新卷并保留属主；
# 目录不存在时会被建成 root 属主，appuser 写 instance.json 就会 EACCES。
RUN useradd -m -u 1000 appuser && \
    mkdir -p /app/data && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz').read()"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
