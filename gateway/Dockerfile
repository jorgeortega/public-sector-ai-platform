# The permit desk's LLM gateway: the pinned LiteLLM proxy (non-root image)
# with its production config. Runs as a Cloudflare Container (worker.ts),
# which passes the secrets in as environment variables. LiteLLM's admin UI
# still serves at /ui (DISABLE_ADMIN_UI didn't turn it off in v1.106.6,
# checked locally 2026-11-13); the Worker's route allowlist keeps it
# unreachable.
FROM ghcr.io/berriai/litellm-non_root:v1.106.6
COPY config.yaml /app/config.yaml
CMD ["--config", "/app/config.yaml", "--port", "4000"]
