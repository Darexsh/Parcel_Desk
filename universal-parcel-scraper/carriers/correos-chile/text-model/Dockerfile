FROM debian:trixie-slim AS model
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 3 https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf -o /model.gguf \
    && echo '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e  /model.gguf' | sha256sum -c - \
    && curl -fsSL --retry 3 https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/LICENSE -o /MODEL-LICENSE
FROM ghcr.io/ggml-org/llama.cpp@sha256:1fa7f8f0ca663fdcf3203dc125a7e0b5c9e49c9ed054b049599666cd7e300eb0
COPY --from=model /model.gguf /models/correos-chile.gguf
COPY --from=model /MODEL-LICENSE /usr/share/licenses/correos-chile-text-model/LICENSE
EXPOSE 8080
CMD ["--model", "/models/correos-chile.gguf", "--host", "0.0.0.0", "--port", "8080", "--threads", "2", "--threads-batch", "2", "--ctx-size", "1024", "--parallel", "1", "--n-predict", "32", "--no-warmup", "--no-webui", "--metrics", "--log-disable"]
