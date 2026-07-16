FROM python:3.12-slim

RUN pip install --no-cache-dir uv
WORKDIR /app
COPY pyproject.toml ./
RUN uv sync --no-dev
COPY agent.py study_library.py study_scene.py study_skill.py trace_store.py ./

ENV PATH="/app/.venv/bin:$PATH"
CMD ["python", "agent.py", "start"]
