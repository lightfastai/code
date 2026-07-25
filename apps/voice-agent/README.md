# T3 Study Voice Agent

This read-only sidecar joins short-lived LiveKit rooms created by the authenticated T3 server. It
uses Deepgram's Australian STT/TTS endpoints, Groq for the spoken response, and the same immutable
`T3_STUDY_LIBRARY` used by the desktop and iPad clients.

No provider secret is sent to a client. The selected book IDs arrive as LiveKit participant
metadata, and the agent searches only derived local text while preserving PDF page, EPUB spine, or
Markdown heading anchors. Every interaction is also written locally as an append-only,
SHA-256-chained trace under `$T3_STUDY_LIBRARY/loop/traces` so the same run can be replayed by the
offline eval CLI.

The teaching behavior is a replaceable artifact. Set `T3_STUDY_SKILL_PATH` to a versioned
`SKILL.md`; its content hash, name, version, model envelope, tool calls, interruptions, and messages
are captured in each trace. The built-in instructions are only the zero-configuration baseline.

During a voice explanation the agent can call `replace_study_scene` to send a validated semantic
snapshot over the `t3.study.scene.v1` LiveKit data topic. The web composer renders it as a live
Three.js panel: the agent can replace or clear the objects while you independently orbit, pan, and
zoom. No generated JavaScript crosses this boundary, and every scene update is recorded in the
interaction trace.

For the existing local credentials from the earlier latency demo:

```bash
cd apps/voice-agent
T3_STUDY_LIBRARY="$HOME/.t3/study-library" \
T3_VOICE_ENV_FILE=/absolute/path/to/can-2/.env \
uv run python agent.py dev
```

Or run the container with the same environment file:

```bash
docker build -t t3-study-voice apps/voice-agent
docker run --rm \
  --env-file /absolute/path/to/can-2/.env \
  -e T3_STUDY_LIBRARY=/library \
  -v "$HOME/.t3/study-library:/library" \
  t3-study-voice
```

Inspect and grade traces from the main CLI:

```bash
t3 study trace list
t3 study trace verify study-ROOM_ID
t3 study eval run /absolute/path/to/dataset.json --bindings /path/to/trace-bindings.json
t3 study eval compare /path/to/baseline-report.json /path/to/candidate-report.json
```

`evals/grounded-voice.example.json` is a small starting dataset. Copy the adjacent bindings example
and replace its run ID before invoking `study eval run`. Use separate baseline and candidate binding
files against the exact same dataset; the report records a dataset content hash and comparisons
reject mismatched dataset or grader versions.
