import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FinalizationView as Finalization,
  GitPreset,
} from "../../../backend/finalization/contracts";
import type { FinalizationService } from "../../../backend/finalization/service";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { errorMessage, rpc } from "../../lib/api";
import { updateTaskView, useTaskView } from "../../lib/taskView";
import type { Repository, Task } from "../../lib/types";
import { workflows } from "./presets";
export type GitFinalizationProps = {
  task: Task;
  repository?: Repository;
  revision: number;
  close: () => void;
  complete: () => Promise<unknown>;
};
/** Owns task-local finalization drafts, ordered loading and operation progress across wizard panels. */
export const useGitFinalization = ({ task, repository, revision }: GitFinalizationProps) => {
  const dialog = useDialogFocus();
  const taskView = useTaskView(task.id);
  const step = taskView.gitStep;
  const setStep = (gitStep: number) => updateTaskView(task.id, { gitStep });
  const [connectingFork, setConnectingFork] = useState(false);
  const initialized = useRef(false);
  const loadSequence = useRef(0);
  const executingRef = useRef(false);
  const detailLoaded = useRef("");
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<FinalizationService["inspect"]>>>();
  const [selection, setSelection] = useState<string[]>([]);
  const [fileSearch, setFileSearch] = useState("");
  const [preset, setPreset] = useState<GitPreset>({
    ...workflows[0],
    remote: repository?.origin_remote || "origin",
    branch: task.branch_name,
  });
  const [record, setRecord] = useState<Finalization>();
  const [detail, setDetail] = useState<{
    events: ReturnType<FinalizationService["store"]["events"]>;
    diff: string;
    diff_truncated: boolean;
    diff_error?: string;
    events_older?: boolean;
  }>();
  const [message, setMessage] = useState(taskView.gitMessageDraft);
  const [replaceStaged, setReplaceStaged] = useState(false);
  const [confirmMessage, setConfirmMessage] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [busy, setBusy] = useState("");
  const [executing, setExecuting] = useState(false);
  const [operationStarted, setOperationStarted] = useState("");
  const [, tick] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [beforeEvent, setBeforeEvent] = useState<number>();
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const value = await rpc<Awaited<ReturnType<FinalizationService["inspect"]>>>("git.inspect", {
      id: task.id,
    });
    if (sequence !== loadSequence.current) return;
    setSnapshot(value);
    if (!initialized.current) {
      initialized.current = true;
      const saved = value.history[0];
      setRecord(saved);
      setSelection(
        saved?.paths ||
          value.files
            .filter((file) => !file.excluded && (file.reviewed || file.committed))
            .map((file) => file.path),
      );
      setPreset(saved?.preset || value.preset);
      setMessage((current) => saved?.message ?? current);
    } else
      setRecord((current) => {
        if (!current) return undefined;
        const saved = value.history.find((item) => item.id === current.id);
        return saved && saved.updated_at >= current.updated_at ? saved : current;
      });
  }, [task.id]);
  useEffect(() => {
    if (!executingRef.current) void load().catch((error) => setError(errorMessage(error)));
  }, [load, revision]);
  const operationId = record?.id;
  const operationStatus = record?.status;
  useEffect(() => {
    setBeforeEvent(undefined);
    detailLoaded.current = "";
  }, [operationId]);
  useEffect(() => {
    if (!executing) return;
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [executing]);
  useEffect(() => {
    if (!operationId) {
      setDetail(undefined);
      return;
    }
    let active = true;
    const method = detailLoaded.current === operationId ? "git.output" : "git.detail";
    void rpc<
      Partial<NonNullable<typeof detail>> & {
        record?: Finalization;
        active?: boolean;
      }
    >(method, {
      id: task.id,
      operation_id: operationId,
      ...(beforeEvent ? { before: beforeEvent } : {}),
    })
      .then((value) => {
        if (!active) return;
        if (method === "git.detail") detailLoaded.current = operationId;
        setDetail((current) => ({
          events: value.events || [],
          events_older: value.events_older,
          diff: value.diff ?? current?.diff ?? "",
          diff_truncated: value.diff_truncated ?? current?.diff_truncated ?? false,
          diff_error: value.diff_error ?? current?.diff_error,
        }));
        if (value.record)
          setRecord((current) =>
            current?.id === value.record!.id && value.record!.updated_at >= current.updated_at
              ? value.record
              : current,
          );
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [operationId, operationStatus, task.id, revision, beforeEvent]);
  const invalidate = () => {
    setRecord(undefined);
    setDetail(undefined);
    setConfirmMessage(false);
    setConfirmPush(false);
    setNotice("Selection changed. Prepare and review the new staged preview.");
  };
  const updateMessage = (value: string) => {
    setMessage(value);
    updateTaskView(task.id, { gitMessageDraft: value });
    setConfirmMessage(false);
  };
  const perform = async (label: string, action: () => Promise<Finalization>) => {
    setBusy(label);
    setExecuting(true);
    executingRef.current = true;
    setOperationStarted(new Date().toISOString());
    setError("");
    setNotice("");
    try {
      const value = await action();
      setExecuting(false);
      executingRef.current = false;
      setRecord(value);
      setConfirmPush(false);
      setBusy("Refreshing saved Git state…");
      await load();
      return value;
    } catch (error) {
      setExecuting(false);
      executingRef.current = false;
      setError(errorMessage(error));
      await load().catch(() => {});
    } finally {
      setExecuting(false);
      executingRef.current = false;
      setBusy("");
    }
  };
  const call = (method: string, extra: Record<string, unknown> = {}) =>
    rpc<Finalization>(`git.${method}`, {
      id: task.id,
      operation_id: record!.id,
      ...extra,
    });
  const locked = !!busy || !!snapshot?.active;
  const filteredFiles =
    snapshot?.files.filter((file) =>
      `${file.path} ${file.old_path || ""}`.toLowerCase().includes(fileSearch.toLowerCase()),
    ) || [];
  const committed = !!record?.head;
  const destinationDirty =
    !!record && (preset.remote !== record.preset.remote || preset.branch !== record.preset.branch);
  const unresolved = snapshot?.history.some(
    (item) =>
      ["pushing", "uncertain", "committing"].includes(item.status) ||
      (item.status === "interrupted" && !!item.head),
  );
  const stagedSelection = snapshot?.files.some(
    (file) => file.staged && selection.includes(file.path),
  );
  const stale =
    record &&
    snapshot &&
    snapshot.fingerprint !== (record.committed_source_hash || record.source_hash);
  const commit = () =>
    perform(
      preset.push === "none"
        ? "Creating local commit…"
        : "Creating commit and checking destination…",
      async () => {
        const value = await call("commit", {
          message,
          skip_hooks: preset.commit_hooks === "skip",
          confirmed: true,
        });
        if (preset.push === "none") return value;
        return rpc<Finalization>("git.prepare", {
          id: task.id,
          operation_id: value.id,
          destination: { remote: preset.remote, branch: preset.branch },
        });
      },
    );

  return {
    connectingFork,
    setConnectingFork,
    load,
    dialog,
    locked,
    error,
    notice,
    taskView,
    snapshot,
    setError,
    step,
    record,
    setStep,
    selection,
    fileSearch,
    setFileSearch,
    filteredFiles,
    invalidate,
    setSelection,
    stagedSelection,
    replaceStaged,
    setReplaceStaged,
    unresolved,
    perform,
    stale,
    call,
    detail,
    preset,
    committed,
    setPreset,
    setConfirmPush,
    setBusy,
    setNotice,
    message,
    updateMessage,
    confirmMessage,
    setConfirmMessage,
    busy,
    commit,
    confirmPush,
    destinationDirty,
    executing,
    operationStarted,
    setBeforeEvent,
    beforeEvent,
    setRecord,
    setMessage,
    confirmRemoval,
    setConfirmRemoval,
    setDetail,
  };
};
export type FinalizationController = ReturnType<typeof useGitFinalization>;
