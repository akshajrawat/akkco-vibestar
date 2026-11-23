# Viber Memory

Open **Private memory** in a Viber chat to add, correct, or forget facts. The panel shows the source of automatically learned facts and which providers received each fact. A fact can apply to a repository, a topic, or both. Facts without a scope stay in the panel until you assign one. Existing facts start with their original text and no recall scope.

In **Settings → General → Viber Memory**, enable the features you want:

- **Automatic saving** checks completed turns for lasting preferences, stable project facts, and decisions you explicitly stated. Codex can suggest a fact during a new native thread when its CLI supports the `save_memory` action. For Antigravity and turns without a native suggestion, you can configure a local Ollama chat model to propose one. Review any conflicting facts in the panel before they can be recalled again.
- **Recall** searches the Viber’s local index. Allow sharing with **Codex** or **Antigravity** individually. When an allowed provider receives a turn, Vibestar can include up to three relevant fact texts as reference context. A provider thread usually receives each version once.

For local search and optional extraction, run Ollama in the environment that runs the Vibestar core. On Windows this is the selected WSL distribution. Install the named model in Ollama, disable cloud features, and restart Ollama. Enter the installed model’s name or name and tag in Settings. Use an embedding model for recall and a chat model for suggestions. Vibestar verifies local-only mode and reaches Ollama on `127.0.0.1:11434`. It skips the memory operation when Ollama is unavailable or exceeds its deadline. [Ollama local setup](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features)

Corrections and model changes rebuild the relevant search entries in the background. Forgetting a fact stops future recall, even if its index update is still running. Changes to sharing permissions apply to future requests. Start a fresh provider thread to leave behind text already sent. `/clear` resets conversation context and keeps saved memory. Vibestar keeps replies in chat and omits provider payloads from diagnostics and conversation handoffs when they could expose recalled text.
