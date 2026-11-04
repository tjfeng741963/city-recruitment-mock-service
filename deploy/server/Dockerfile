# 城市招聘后端（FastAPI）生产镜像
#
# 构建上下文必须是「仓库根目录」，不是 deploy/server：
#   docker build -f deploy/server/Dockerfile -t city-recruitment-backend .
# compose 里已按此配置：context: ../..  dockerfile: deploy/server/Dockerfile
#
# 依赖用 uv + uv.lock 锁定安装，镜像内不跑 uv sync 的解析流程（--frozen）。

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

# 国内服务器可改成阿里云镜像，见 deploy/server/.env.example 的注释：
#   --build-arg PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
#   --build-arg UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG UV_DEFAULT_INDEX=https://pypi.org/simple
ENV UV_DEFAULT_INDEX=${UV_DEFAULT_INDEX}

WORKDIR /app

# 只装 uv 本身，不装项目依赖（依赖交给 uv sync 按 lock 装）
RUN pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" "uv==0.5.14"

# 先拷依赖清单再拷源码：源码变了不会让依赖层失效
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/app ./app

# 运行时数据目录（instance.json 等），挂卷后由 appuser 写入
RUN useradd --create-home --uid 1000 appuser \
    && mkdir -p /app/data \
    && chown -R appuser:appuser /app

USER appuser

ENV PATH="/app/.venv/bin:${PATH}" \
    VIRTUAL_ENV="/app/.venv"

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/healthz').read()"

# --no-sync：依赖已在构建期装好，启动时不再联网校验
CMD ["uv", "run", "--frozen", "--no-dev", "--no-sync", \
     "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
