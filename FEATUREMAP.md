```mermaid
sequenceDiagram
    actor User
    participant Chat as Viber chat
    participant Codex as Codex thread
    participant AGY as Antigravity thread

    participant Provider as Turn provider
    Note over Chat: History scrolls beneath the fading black header
    User->>Chat: Send avatar-colored message to Codex
    Chat->>Codex: Start thread with message
    Codex-->>Chat: Reply and tool activity
    Note over Chat: Tool activity shows only messages with text
    User->>Chat: Switch to Antigravity and send
    Chat->>AGY: Start thread with saved chat context and new message
    AGY-->>Chat: Reply
    User->>Chat: Switch back to Codex and send
    Chat->>Codex: Resume thread with Antigravity exchange and new message
    Codex-->>Chat: Reply
    User->>Chat: Choose another Codex model and send
    Chat->>Codex: Resume the same thread with the new model
    Codex-->>Chat: Reply
    User->>Chat: Change reasoning effort and send
    Chat->>Codex: Resume the thread with the new effort
    User->>Chat: Stop response
    Chat->>Provider: Cancel the active turn
    Chat-->>User: Show Continue where you left off
    opt User selects another provider for the stopped turn
        alt Target is Codex
            opt Saved Codex target exists
                Chat->>Codex: Resume the saved target
            end
            alt Saved target is confirmed
                Chat->>Codex: Append unseen redacted history without a turn
            else Saved target is absent or confirmed missing
                Chat->>Codex: Start a fresh target and append redacted history without a turn
            end
            Codex-->>Chat: Confirm the prepared thread
        else Target is Antigravity
            Chat-->>User: Context-only preload is unavailable. Keep the original provider selected
        end
    end
    User->>Chat: Continue where you left off
    opt Previous turn may have changed files or run commands
        Chat-->>User: Show activity and request acknowledgment
        User->>Chat: Acknowledge the possible effects
    end
    alt Provider confirms the saved thread
        Chat->>Provider: Send only Continue where you left off to the saved or prepared thread
        Provider-->>Chat: Reply
    else No usable saved thread or explicit rejection before dispatch
        alt Original provider
            Chat->>Provider: Start a fresh thread with Viber instructions and the exact interrupted request
            Note over Provider: Inspect workspace files and partial edits before continuing
        else Prepared Codex thread is missing
            Chat->>Codex: Start a fresh thread and append redacted reference history
            Chat->>Codex: Send only Continue where you left off
        end
        Provider-->>Chat: Reply
    else Resume outcome is uncertain
        Chat-->>User: Show the failure for inspection
    end
    User->>Chat: Send /clear
    alt Viber has an active turn
        Chat-->>User: Wait for the turn to finish
    else Viber is idle
        Chat-->>User: Confirm reset and keep the saved transcript and files
        User->>Chat: Send another message
        Chat->>Codex: Start a fresh thread
    end
```

```mermaid
flowchart LR
    Viber["Completed Viber turn"] --> Suggest["Model suggests a lasting fact"]
    Settings["General Settings · Enable Memory"] --> Learn["Automatic saving"]
    Settings --> Recall["Recall"]
    Permissions["Provider Settings · Share recalled memories"] --> Recall
    Learn --> Suggest --> Evidence["Validate user evidence"]
    Evidence --> Storage["Local SQLite · Viber and repository/topic scope"]
    Evidence -- "Correction to the repository's indentation default" --> Replace["Replace the previous fact"] --> Storage
    Storage --> Ollama["Local Ollama search"]
    Recall --> Ollama --> Share["Up to 3 fact texts · Provider turn input"]
    Share --> Accept["Provider accepts turn input"] --> Record["Record facts in thread context"]
```

```mermaid
sequenceDiagram
    actor Human as Human Operator
    participant Title as TitleBar
    participant Panel as Viber Computer Panel
    participant Core as Core Computer Service
    participant Term as Isolated Terminal (xterm/PTY)
    participant Browser as Local Browser View (Human Takeover)
    participant Docker as Viber Runtime (Docker / Workspace)

    Human->>Title: Click Monitor icon
    Title->>Panel: Open selected Viber Computer panel
    Panel->>Core: computer.status (profile_id)
    Core-->>Panel: Return status (stopped / ready / running / error)
    Human->>Panel: Click Start
    Panel->>Core: computer.control (action: start)
    Core->>Docker: Ensure isolated container & home volume
    Docker-->>Core: Running
    Core-->>Panel: computer.changed (status: ready)
    opt Interactive Terminal
        Human->>Panel: Open shell or Provider Login
        Panel->>Core: computer.terminal.open
        Core->>Term: Spawn PTY in Viber workspace
        Term-->>Human: Interactive shell with bounded stream redaction
    end
    opt Human Sign-In & Local Service Takeover
        Human->>Panel: Select Browser tab
        Human->>Browser: Enter local service URL (http://127.0.0.1:3000)
        Note over Browser: Enforce local-only destination; agent browsing disabled
        Browser-->>Human: Interactive local web app view & sign-in takeover
    end
    Human->>Panel: Click Stop
    Panel->>Core: computer.control (action: stop)
    Core->>Docker: Stop container & close terminal
    Core-->>Panel: computer.changed (status: stopped)
```
