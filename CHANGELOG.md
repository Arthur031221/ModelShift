# Changelog

## Unreleased

- `registry --help` now exits successfully after printing help.

## 0.1.0 (2026-09-30)

First release.

- `scan`: finds model identifiers in Python, TypeScript, JavaScript, Go, Ruby, Java, Kotlin, C#, YAML, TOML, JSON, env, Markdown and text files, honours `.gitignore`, and reports retired, retiring, deprecated, eligible, active or unknown status with the replacement and source URL. Exit code 1 when anything retires inside the window.
- `check`: the same scan tuned for CI, with GitHub Actions annotations and a composite action (`action.yml`).
- `replay`: runs a JSONL prompt set on two models and reports JSON validity, output length, refusals, tool call shape, latency, cost and similarity, then writes `modelshift-report.html`. Prompts can be sampled from local Claude Code and Codex session logs with secrets redacted and a confirmation step.
- `fix`: rewrites retiring identifiers to the provider's replacement, removes `temperature`, `top_p` and `top_k` near models that reject them, flags step-by-step prompt text, prints a unified diff, applies with `--write`, opens a pull request with `--pr`.
- `registry`: list, show, validate and refresh the bundled lifecycle registry. A weekly GitHub Action re-fetches the provider pages and opens a pull request.
- Providers: OpenAI compatible endpoints (OpenAI, OpenRouter, Ollama, LM Studio, llama-server, vLLM), Anthropic Messages API, Google Gemini API, plus Ollama's native API for `--no-think`.
- Registry seeded on 2026-09-29 from the OpenAI, Anthropic, Gemini and Bedrock lifecycle pages, 202 entries.
