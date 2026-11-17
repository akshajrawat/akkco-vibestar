import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentProfile } from "../../../core/flows/contracts";
import type { ViberSessionDetail } from "../../../core/vibers/contracts";
import type { AgentEvent, Run } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { getTaskView, useTaskView, updateTaskView } from "../../lib/taskView";
import { Button } from "../../components/ui/button";
import { Composer, composerContent } from "../chat/Composer";
import { ChatSurface } from "../chat/ChatSurface";
import { AgentTimeline } from "../chat/AgentTimeline";
import { ViberModelPicker } from "./ViberModelPicker";

type SessionDetail = ViberSessionDetail & { runs: Run[]; events: AgentEvent[] };

export const ViberSessionChat = ({
  sessionId,
  profile,
  revision,
}: {
  sessionId: string;
  profile: AgentProfile;
  revision: number;
}) => {
  const id = `viber-session:${sessionId}`;
  const view = useTaskView(id);
  const [data, setData] = useState<SessionDetail>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newThread, setNewThread] = useState(false);
  const [acknowledgeUncertain, setAcknowledgeUncertain] = useState(false);
  const sending = useRef(false);
  const request = useRef({ signature: "", id: "" });

  const load = useCallback(
    () =>
      rpc<SessionDetail>("viber.session.detail", { session_id: sessionId, profile_id: profile.id }),
    [sessionId, profile.id],
  );

  useEffect(() => {
    let active = true;

    void load()
      .then((data) => {
        if (active) {
          setData(data);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      });

    return () => {
      active = false;
    };
  }, [load, revision]);

  const selection = {
    provider:
      view.followupProvider || data?.session.selection.provider || profile.execution.provider,
    model: view.followupModel ?? data?.session.selection.model ?? profile.execution.model,
    effort: view.followupEffort || data?.session.selection.effort || profile.execution.effort,
  };

  const previousTurn = data?.messages.filter((message) => message.role === "user").at(-1);

  const uncertain =
    data?.session.thread?.status === "uncertain" ||
    (previousTurn && ["failed", "cancelled", "interrupted"].includes(previousTurn.status));

  const active = data?.messages.some((message) => message.status === "pending");

  const send = async () => {
    if (sending.current || !data || active || (uncertain && !acknowledgeUncertain)) {
      return;
    }

    const content = composerContent(getTaskView(id));
    if (!content.trim() || content.length > 32000) {
      return;
    }

    sending.current = true;
    setBusy(true);
    setError("");
    try {
      const input = {
        session_id: sessionId,
        profile_id: profile.id,
        content,
        history_ids: [],
        ...(newThread ? { new_thread: true } : {}),
        ...(acknowledgeUncertain ? { acknowledge_uncertain: true } : {}),
        selection,
      };

      const signature = JSON.stringify(input);
      if (request.current.signature !== signature) {
        request.current = { signature, id: crypto.randomUUID() };
      }

      await rpc("viber.session.send", { ...input, request_id: request.current.id });
      updateTaskView(id, { draft: "", draftContext: [] });
      request.current = { signature: "", id: "" };
      setData(await load());
      setNewThread(false);
      setAcknowledgeUncertain(false);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <ChatSurface
        id={id}
        revision={revision}
        empty={!data?.messages.length}
        activity={
          <>
            {data?.workspace && (
              <p className="flow-draft-notice" title={data.workspace.path}>
                Workspace · {data.workspace.repository || "Isolated files"}
                {data.workspace.path && <span> · {data.workspace.path}</span>}
              </p>
            )}
            {active && (
              <p className="flow-draft-notice">
                {profile.name} · Running{" "}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void rpc<SessionDetail>("viber.session.cancel", {
                      session_id: sessionId,
                      profile_id: profile.id,
                    })
                      .then(setData)
                      .catch((reason) => setError(errorMessage(reason)));
                  }}
                >
                  Stop
                </Button>
              </p>
            )}
            {data?.messages
              .filter((message) => message.error)
              .map((message) => (
                <p key={message.id} className="flow-inline-error">
                  {message.error}
                </p>
              ))}
          </>
        }
        conversation={
          data ? (
            <AgentTimeline
              runs={data.runs}
              events={data.events}
              messages={data.messages.map((message) => ({
                ...message,
                purpose: "chat",
                status: `chat_${message.status}`,
              }))}
              compact
              expandResults={false}
            />
          ) : (
            <p className="empty-row">Opening conversation…</p>
          )
        }
        composer={
          <>
            {data &&
              (selection.provider !== data.session.selection.provider ||
                selection.model !== data.session.selection.model) && (
                <p className="flow-draft-notice">
                  The next message starts a fresh provider thread. Previous messages and workspace
                  files remain saved.
                </p>
              )}
            <label className="viber-checkbox">
              <input
                type="checkbox"
                checked={newThread}
                disabled={busy || active}
                onChange={(event) => setNewThread(event.target.checked)}
              />
              Start a new provider thread (saved messages and files are retained)
            </label>
            {uncertain && !active && (
              <label className="viber-checkbox">
                <input
                  type="checkbox"
                  checked={acknowledgeUncertain}
                  onChange={(event) => setAcknowledgeUncertain(event.target.checked)}
                />
                I inspected the previous turn; commands or file changes may already have occurred.
              </label>
            )}
            <Composer
              compact
              id={id}
              label={`Message ${profile.name}`}
              placeholder={`Ask ${profile.name} anything…`}
              sendLabel="Send message"
              onSend={() => void send()}
              context={[
                {
                  label: "Text",
                  input: "Context text",
                  load: async (text) => ({ label: "Attached text", text }),
                },
              ]}
              busy={busy}
              disabled={!data || active || (uncertain && !acknowledgeUncertain)}
              model={
                <ViberModelPicker
                  execution={{ ...profile.execution, ...selection }}
                  change={(execution) =>
                    updateTaskView(id, {
                      followupProvider: execution.provider,
                      followupModel: execution.model,
                      followupEffort: execution.effort,
                    })
                  }
                />
              }
              hint="The provider retains conversation context. Changing provider or model starts a fresh thread."
            />
          </>
        }
      />
    </>
  );
};
