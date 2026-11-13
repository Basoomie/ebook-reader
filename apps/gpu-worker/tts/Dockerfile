# ttsu TTS image (WP17): Irodori-TTS with CUDA, built on the PC by the worker
# (`main.js build-tts`) and run with `docker run --gpus all`.
#
# Everything is pinned: the Irodori-TTS commit (its uv.lock pins torch 2.10 cu128 and the
# rest), uv, SudachiPy and its dictionary. Model weights are not in the image: they download
# into the mounted cache folder (/cache, HF_HOME) on first use, pinned by revision in the
# runner's spec.
FROM python:3.10-slim-bookworm

ARG IRODORI_REPO=https://github.com/Aratako/Irodori-TTS.git
ARG IRODORI_COMMIT=382205679ebc32295b7d1bfb329327d04c8f4eed

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv==0.13.5

WORKDIR /opt/irodori
RUN git clone "$IRODORI_REPO" . \
  && git checkout --detach "$IRODORI_COMMIT" \
  && rm -rf .git

ENV UV_LINK_MODE=copy \
  UV_COMPILE_BYTECODE=1 \
  UV_PROJECT_ENVIRONMENT=/opt/irodori/.venv \
  UV_CACHE_DIR=/tmp/uv-cache

RUN uv sync --frozen --extra cu128 --no-dev && rm -rf /tmp/uv-cache

RUN uv pip install --python /opt/irodori/.venv/bin/python \
    sudachipy==0.6.10 sudachidict-core==20260428 \
  && rm -rf /tmp/uv-cache

COPY ttsu_tts.py kana.py /opt/ttsu/

ENV HF_HOME=/cache/hf \
  PYTHONUNBUFFERED=1 \
  PYTHONPATH=/opt/irodori:/opt/ttsu \
  IRODORI_COMMIT=$IRODORI_COMMIT

LABEL org.opencontainers.image.title="ttsu-irodori" \
  org.opencontainers.image.source="$IRODORI_REPO" \
  org.opencontainers.image.revision="$IRODORI_COMMIT"

ENTRYPOINT ["/opt/irodori/.venv/bin/python", "/opt/ttsu/ttsu_tts.py"]
