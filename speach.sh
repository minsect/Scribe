#!/bin/sh
set -eu

: "${SPEACHES_PORT:=${WHISPER_PORT:-8000}}"
: "${SPEACHES_IMAGE:=ghcr.io/speaches-ai/speaches:latest-cuda}"
: "${SPEACHES_GPU_ARGS:=--gpus=all}"
: "${SPEACHES_HF_CACHE:=hf-hub-cache}"

docker run \
  --rm \
  --publish "${SPEACHES_PORT}:8000" \
  --name speaches \
  --volume "${SPEACHES_HF_CACHE}:/home/ubuntu/.cache/huggingface/hub" \
  ${SPEACHES_GPU_ARGS} \
  "${SPEACHES_IMAGE}"
