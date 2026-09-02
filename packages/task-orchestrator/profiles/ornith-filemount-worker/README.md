# Ornith file-mount worker profile

This is the headless counterpart to the interactive ornith-filemount profile.
It uses dsh-headless, dsh-file-mount, and dsh-small-model-guard, configures the
Ollama ornith-1.5:9b route, and exits after one task.

Install this profile under DSH_HOME/profiles/ornith-filemount-worker and export the
non-secret Ollama compatibility key expected by the OpenAI adapter:

    export OLLAMA_API_KEY=ollama

Run it from the dispatcher in the pinned task workspace:

    dsh --profile ornith-filemount-worker "task prompt"

The dsh-small-model-guard dependency currently uses the local development link
used by this workstation. Replace that link with the published or local plugin
location on another machine before running pnpm install.
