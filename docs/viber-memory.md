# Viber Memory

Turn on **Enable Memory** in **Settings → General** to learn from chats and recall relevant facts. Vibestar checks model suggestions against what you said and saves accepted facts locally. Codex can suggest facts through its `save_memory` action when supported. Antigravity and Codex turns without a native suggestion can use a local Ollama model.

With memory enabled, Vibestar searches locally and can send up to three relevant facts as reference text to the provider handling the turn. A provider thread usually receives each version once. Existing installations keep their global memory setting.

Run Ollama in the environment that runs the Vibestar core. On Windows this is the selected WSL distribution. Install `nomic-embed-text` for recall and `qwen2.5:1.5b` for local suggestions. Disable Ollama cloud features and restart Ollama. If you previously set a custom model, Vibestar uses that model. Vibestar verifies local-only mode and connects on `127.0.0.1:11434`. It skips the memory operation when Ollama is unavailable or exceeds its deadline. [Ollama local setup](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)

Conflicting facts stay out of recall until the Viber learns an explicit correction in chat. Corrections and model changes rebuild the relevant search entries in the background. Turning off memory stops new recall in future requests. Start a fresh provider thread to leave behind text already sent. `/clear` resets conversation context and keeps saved memory. Vibestar keeps replies in chat and omits provider payloads from diagnostics and conversation handoffs when they could expose recalled text.
