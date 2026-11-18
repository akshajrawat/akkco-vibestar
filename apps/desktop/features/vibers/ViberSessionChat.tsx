import { useCallback, useEffect, useRef, useState } from "react";

import type { AgentProfile } from "../../../core/vibers/contracts";
import type { ViberSessionDetail } from "../../../core/vibers/contracts";
import type { AgentEvent, Run } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { getTaskView, useTaskView, updateTaskView } from "../../lib/taskView";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/Select";
import { Composer, composerContent } from "../chat/Composer";
import { ChatSurface } from "../chat/ChatSurface";
import { AgentTimeline } from "../chat/AgentTimeline";
import { RunError } from "../chat/RunError";
import { ViberModelPicker } from "./ViberModelPicker";
import { ViberRecoveryDialog } from "./ViberRecoveryDialog";
import { useProviders } from "../../hooks/useWorkspace";
import { configurationError } from "../../../core/execution/providers/contracts";

type SessionDetail = ViberSessionDetail & { runs: Run[]; events: AgentEvent[] };

export const ViberSessionChat = (props: {
  sessionId: string;
  profile: AgentProfile;
  revision: number;
}) => <SessionChat key={props.sessionId} {...props} />;

const SessionChat = ({
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
  const { providers } = useProviders(profile.id);
  const [data, setData] = useState<SessionDetail>();
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [newThread, setNewThread] = useState(false);
  const [recovery, setRecovery] = useState<string>();
  const sending = useRef(false);
  const cancelling = useRef(false);
  const requested = useRef({ sequence: 0 });

  const refresh = useCallback(async () => {
    const sequence = ++requested.current.sequence;

    const next = await rpc<SessionDetail>("viber.session.detail", {
      session_id: sessionId,
      profile_id: profile.id,
    });

    if (sequence === requested.current.sequence) {
      setData(next);
    }
  }, [sessionId, profile.id]);

  useEffect(() => {
    let alive = true;
    const pending = requested.current;

    void refresh().catch((reason) => {
      if (alive) {
        setError({ message: errorMessage(reason) });
      }
    });

    return () => {
      alive = false;
      pending.sequence++;
    };
  }, [refresh, revision]);

  const selection = {
    provider:
      view.followupProvider || data?.session.selection.provider || profile.execution.provider,
    model: view.followupModel ?? data?.session.selection.model ?? profile.execution.model,
    effort: view.followupEffort || data?.session.selection.effort || profile.execution.effort,
  };

  const previousTurn = data?.messages.filter((message) => message.role === "user").at(-1);

  const uncertain =
    data?.recovery_required ??
    (data?.session.thread?.status === "uncertain" ||
      !!(previousTurn && ["failed", "cancelled", "interrupted"].includes(previousTurn.status)));

  const active = data?.messages.some((message) => message.status === "pending");
  const provider = providers.find((provider) => provider.provider === selection.provider);

  const invalid = provider
    ? !selection.model && !provider.models.some((model) => model.isDefault)
      ? "Choose a model before sending a message."
      : configurationError(provider, { ...profile.execution, ...selection })
    : null;

  const visibleError =
    error && (!error.requestId || !data?.messages.some((message) => message.id === error.requestId))
      ? error.message
      : "";

  const send = async (content = composerContent(getTaskView(id)), acknowledged = false) => {
    if (
      sending.current ||
      !data ||
      active ||
      invalid ||
      !content.trim() ||
      content.length > 32000
    ) {
      return;
    }

    if (uncertain && !acknowledged) {
      setRecovery(content);
      return;
    }

    sending.current = true;
    setBusy(true);
    setError(undefined);
    let requestId: string | undefined;
    try {
      if (content.trim() === "/clear") {
        await rpc("viber.session.send", {
          session_id: sessionId,
          profile_id: profile.id,
          request_id: crypto.randomUUID(),
          content: "/clear",
          history_ids: [],
          selection,
        });

        updateTaskView(id, { draft: "", draftContext: [] });
        await refresh();
        return;
      }

      const inputFor = (reset: boolean, acknowledge: boolean) => ({
        session_id: sessionId,
        profile_id: profile.id,
        content,
        history_ids: [],
        ...(reset ? { new_thread: true } : {}),
        ...(acknowledge ? { acknowledge_uncertain: true } : {}),
        selection,
      });

      const previous = getTaskView(id).messageRequest;

      const saved = data.messages.some(
        (message) => message.id === previous?.id && message.status !== "pending",
      )
        ? null
        : previous;

      // A lost-response resend retains the original flags even after a remount.
      const input =
        [
          inputFor(false, false),
          inputFor(false, true),
          inputFor(true, false),
          inputFor(true, true),
        ].find(
          (input) =>
            (!acknowledged || input.acknowledge_uncertain) &&
            JSON.stringify(input) === saved?.signature,
        ) || inputFor(newThread, acknowledged);

      const signature = JSON.stringify(input);
      let request = saved;
      if (request?.signature !== signature) {
        request = { signature, id: crypto.randomUUID() };
        updateTaskView(id, { messageRequest: request });
      }

      requestId = request.id;
      await rpc("viber.session.send", { ...input, request_id: request.id });

      updateTaskView(id, {
        ...(composerContent(getTaskView(id)) === content ? { draft: "", draftContext: [] } : {}),
        messageRequest: null,
      });

      setNewThread(newThread && !input.new_thread);
      await refresh();
    } catch (reason) {
      setError({ message: errorMessage(reason), requestId });
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const stop = async () => {
    if (cancelling.current) {
      return;
    }

    cancelling.current = true;
    setStopping(true);
    try {
      await rpc("viber.session.cancel", { session_id: sessionId, profile_id: profile.id });
      await refresh();
    } catch (reason) {
      setError({ message: errorMessage(reason) });
    } finally {
      cancelling.current = false;
      setStopping(false);
    }
  };

  const timeline = data ? (
    <AgentTimeline
      runs={data.runs}
      events={data.events}
      messages={data.messages.map((message) => ({
        ...message,
        purpose: "chat",
        status: `chat_${message.status}`,
      }))}
      compact
      standalone
      expandResults={false}
    />
  ) : (
    <p className="empty-row">Opening conversation…</p>
  );

  return (
    <>
      <ChatSurface
        id={id}
        revision={revision}
        empty={!data?.messages.length}
        activity={
          <div className="viber-session-bar">
            <span title={data?.workspace?.path}>
              Workspace · {data?.workspace?.repository || "Isolated files"}
            </span>
            {newThread && <span>AI context will reset on your next message.</span>}
            <Select
              label="Conversation menu"
              value=""
              selectedLabel="•••"
              disabled={!data || busy || active}
              options={[
                { value: "clear", label: "Clear context now (/clear)" },
                { value: "reset", label: newThread ? "Keep AI context" : "Reset AI context" },
              ]}
              onChange={(value) => {
                if (value === "clear") {
                  void send("/clear");
                } else if (value === "reset") {
                  setNewThread((v) => !v);
                }
              }}
            />
          </div>
        }
        conversation={
          <>
            {timeline}
            {data?.messages
              .filter(
                (message) =>
                  message.error && !data.runs.some((run) => run.id === message.run_id && run.error),
              )
              .map((message) => (
                <RunError key={message.id} error={message.error!} conversation />
              ))}
            {(visibleError || invalid) && (
              <RunError error={visibleError || invalid!} conversation />
            )}
            {(active || busy) && !data?.runs.some((run) => run.status === "running") && (
              <p className="working-shimmer" role="status">
                Working…
              </p>
            )}
          </>
        }
        actions={
          !active && !busy && !invalid && previousTurn && previousTurn.status !== "pending" ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void send(previousTurn.status === "completed" ? "Continue" : previousTurn.content)
              }
            >
              {previousTurn.status === "completed" ? "Continue" : "Retry"}
            </Button>
          ) : null
        }
        composer={
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
            busy={busy || active || stopping}
            disabled={!data || !!invalid}
            stop={active ? () => void stop() : undefined}
            model={
              <ViberModelPicker
                profileId={profile.id}
                execution={{ ...profile.execution, ...selection }}
                disabled={busy || active}
                change={(execution) =>
                  updateTaskView(id, {
                    followupProvider: execution.provider,
                    followupModel: execution.model,
                    followupEffort: execution.effort,
                  })
                }
              />
            }
            hint="Message your Viber."
          />
        }
      />
      {recovery !== undefined && (
        <ViberRecoveryDialog
          sessionId={sessionId}
          profileId={profile.id}
          activity={timeline}
          cancel={() => setRecovery(undefined)}
          confirm={() => {
            setRecovery(undefined);
            void send(recovery, true);
          }}
        />
      )}
    </>
  );
};
