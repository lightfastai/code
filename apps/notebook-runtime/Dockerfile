FROM python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7 AS runtime

COPY --from=ghcr.io/astral-sh/uv:0.11.26@sha256:3d868e555f8f1dbc324afa005066cd11e1053fc4743b9808ca8025283e65efa5 /uv /uvx /bin/

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONHASHSEED=random \
    NOTEBOOK_WORKSPACE_ROOT=/workspace

RUN groupadd --gid 10001 runtime \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin runtime \
    && groupadd --gid 10002 runtime-control \
    && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin runtime-control \
    && install -d -o runtime -g runtime -m 0755 /app \
    && install -d -o runtime -g runtime -m 0700 /workspace

WORKDIR /app
COPY --chown=runtime:runtime pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project \
    && uv cache clean \
    && find /app/.venv -type d -name __pycache__ -prune -exec rm -rf '{}' +

COPY --chown=runtime:runtime runtime.py ./

USER 10001:10001

CMD ["python", "-m", "runtime"]
