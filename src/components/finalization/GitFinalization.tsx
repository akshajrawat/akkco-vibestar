import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  FileCheck2,
  GitCommitHorizontal,
  GitBranch,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import type { FinalizationService } from "../../../backend/finalization/service";
import type {
  FinalizationView as Finalization,
  GitPreset,
} from "../../../backend/finalization/contracts";
import type { Task, Repository } from "../../lib/types";
import { rpc, errorMessage, duration } from "../../lib/api";
import { containDialogFocus } from "../../lib/keyboard";
import { useDialogFocus } from "../../lib/useDialogFocus";
import { updateTaskView, useTaskView } from "../../lib/taskView";
import { Button } from "../ui/button";
import { ListSkeleton } from "../ui/PageHeader";
import { ConnectLocalRepository } from "../ConnectLocalRepository";

const workflows = [
  { name: "Standard", commit_hooks: "normal", push: "normal" },
  {
    name: "Normal commit + no-verify push",
    commit_hooks: "normal",
    push: "skip",
  },
  { name: "Local only", commit_hooks: "normal", push: "none" },
  {
    name: "No-verify commit + normal push",
    commit_hooks: "skip",
    push: "normal",
  },
  { name: "Skip both optional hooks", commit_hooks: "skip", push: "skip" },
] as const;

export const GitFinalization = ({
  task,
  repository,
  revision,
  close,
  complete,
}: {
  task: Task;
  repository?: Repository;
  revision: number;
  close: () => void;
  complete: () => Promise<unknown>;
}) => {
  const dialog = useDialogFocus();
  const taskView = useTaskView(task.id);
  const step = taskView.gitStep;
  const setStep = (gitStep: number) => updateTaskView(task.id, { gitStep });
  const [connectingFork, setConnectingFork] = useState(false);
  const initialized = useRef(false);
  const loadSequence = useRef(0);
  const executingRef = useRef(false);
  const detailLoaded = useRef("");
  const [snapshot, setSnapshot] =
    useState<Awaited<ReturnType<FinalizationService["inspect"]>>>();
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
    const value = await rpc<
      Awaited<ReturnType<FinalizationService["inspect"]>>
    >("git.inspect", { id: task.id });
    if (sequence !== loadSequence.current) return;
    setSnapshot(value);
    if (!initialized.current) {
      initialized.current = true;
      const saved = value.history[0];
      setRecord(saved);
      setSelection(
        saved?.paths ||
          value.files
            .filter(
              (file) => !file.excluded && (file.reviewed || file.committed),
            )
            .map((file) => file.path),
      );
      setPreset(saved?.preset || value.preset);
      setMessage((current) => saved?.message ?? current);
    } else
      setRecord((current) => {
        if (!current) return undefined;
        const saved = value.history.find((item) => item.id === current.id);
        return saved && saved.updated_at >= current.updated_at
          ? saved
          : current;
      });
  }, [task.id]);
  useEffect(() => {
    if (!executingRef.current)
      void load().catch((error) => setError(errorMessage(error)));
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
    const method =
      detailLoaded.current === operationId ? "git.output" : "git.detail";
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
          diff_truncated:
            value.diff_truncated ?? current?.diff_truncated ?? false,
          diff_error: value.diff_error ?? current?.diff_error,
        }));
        if (value.record)
          setRecord((current) =>
            current?.id === value.record!.id &&
            value.record!.updated_at >= current.updated_at
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
  const perform = async (
    label: string,
    action: () => Promise<Finalization>,
  ) => {
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
      `${file.path} ${file.old_path || ""}`
        .toLowerCase()
        .includes(fileSearch.toLowerCase()),
    ) || [];
  const committed = !!record?.head;
  const destinationDirty =
    !!record &&
    (preset.remote !== record.preset.remote ||
      preset.branch !== record.preset.branch);
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
    snapshot.fingerprint !==
      (record.committed_source_hash || record.source_hash);
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
  if (connectingFork && repository)
    return (
      <ConnectLocalRepository
        initialPath={repository.path}
        distro={repository.distro || "Linux"}
        close={() => setConnectingFork(false)}
        connected={async () => {
          setConnectingFork(false);
          await load();
        }}
      />
    );
  return (
    <div className="modal-backdrop">
      <section
        className="modal git-finalization"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-finalization-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !locked) close();
          containDialogFocus(event);
        }}
      >
        <header className="git-finalization-header">
          <div>
            <span className="eyebrow">
              <GitBranch size={14} /> TASK DELIVERY
            </span>
            <h2 id="git-finalization-title">Git Finalization</h2>
            <p>
              Select reviewed files, keep your exact message and confirm the
              destination.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close Git Finalization"
            disabled={locked}
            onClick={close}
          >
            <X size={18} />
          </Button>
        </header>
        <details className="git-workspace-details">
          <summary>Workspace identity</summary>
          <dl className="repository-facts">
            <dt>Source checkout</dt>
            <dd>
              <code>{repository?.path || "Unavailable"}</code>
            </dd>
            <dt>Task worktree</dt>
            <dd>
              <code>{task.worktree_path}</code>
            </dd>
            <dt>Task branch</dt>
            <dd>
              <code>{task.branch_name}</code>
            </dd>
            <dt>Pinned base</dt>
            <dd>
              <code>{task.base_commit_sha}</code>
            </dd>
          </dl>
        </details>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {taskView.persistenceError && (
          <p className="error-box" role="alert">
            {taskView.persistenceError}
          </p>
        )}
        {!snapshot ? (
          <>
            <ListSkeleton label="Loading changed files and Git history" />
            {error && (
              <Button
                onClick={() =>
                  void load().catch((error) => setError(errorMessage(error)))
                }
              >
                Retry loading files
              </Button>
            )}
          </>
        ) : (
          <>
            <div className="git-finalization-grid">
              <nav className="git-journey" aria-label="Git Finalization steps">
                {["Files", "Commit", "Publish", "Confirm"].map(
                  (label, index) => (
                    <Button
                      key={label}
                      variant={step === index ? "secondary" : "ghost"}
                      aria-current={step === index ? "step" : undefined}
                      disabled={locked || (index > 0 && !record)}
                      onClick={() => setStep(index)}
                    >
                      {index + 1}. {label}
                    </Button>
                  ),
                )}
              </nav>
              <section className="git-files-panel" hidden={step !== 0}>
                <h3>
                  <FileCheck2 size={17} /> Changed files{" "}
                  <span className="badge">
                    {
                      selection.filter((path) =>
                        snapshot.files.some((file) => file.path === path),
                      ).length
                    }{" "}
                    selected
                  </span>
                </h3>
                <p className="muted">
                  Selections stage into a separate review index. Your task's
                  existing staged changes stay intact until you confirm a
                  commit.
                </p>
                <label>
                  <span className="sr-only">Search changed files</span>
                  <input
                    type="search"
                    value={fileSearch}
                    placeholder="Search changed files…"
                    onChange={(event) => setFileSearch(event.target.value)}
                  />
                </label>
                <ul className="git-file-list">
                  {filteredFiles.map((file) => (
                    <li
                      key={file.path}
                      className={file.excluded ? "excluded" : undefined}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={selection.includes(file.path)}
                          disabled={locked || !!file.excluded || file.committed}
                          onChange={(event) => {
                            invalidate();
                            setSelection(
                              event.target.checked
                                ? [...selection, file.path]
                                : selection.filter(
                                    (path) => path !== file.path,
                                  ),
                            );
                          }}
                        />
                        <span>
                          <code>
                            {file.old_path ? `${file.old_path} → ` : ""}
                            {file.path}
                          </code>
                          <small>
                            {file.status} ·{" "}
                            {file.committed
                              ? "Already committed · included"
                              : file.untracked
                                ? "New file"
                                : file.staged
                                  ? "Existing staged changes"
                                  : "Working change"}{" "}
                            ·{" "}
                            {file.size < 1024
                              ? `${file.size} B`
                              : `${(file.size / 1024).toFixed(1)} KB`}{" "}
                            · +{file.insertions} / −{file.deletions}
                            {file.binary ? " · Binary" : ""}
                          </small>
                        </span>
                      </label>
                      {file.excluded && (
                        <small className="error-text">{file.excluded}</small>
                      )}
                    </li>
                  ))}
                </ul>
                {fileSearch && !filteredFiles.length && (
                  <p className="muted">
                    No matching files. Your selection is preserved.
                  </p>
                )}
                {!snapshot.files.length && (
                  <p className="muted">
                    No changed files. Saved operation history remains available
                    below.
                  </p>
                )}
                {!!snapshot.ignored.length && (
                  <details>
                    <summary>
                      Ignored files ({snapshot.ignored.length}
                      {snapshot.ignored.length === 200 ? "+" : ""})
                    </summary>
                    <p className="muted">Ignored files cannot be selected.</p>
                    <ul>
                      {snapshot.ignored.map((path) => (
                        <li key={path}>
                          <code>{path}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
                {stagedSelection && (
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={replaceStaged}
                      disabled={locked}
                      onChange={(event) =>
                        setReplaceStaged(event.target.checked)
                      }
                    />
                    Use complete selected files instead of their existing staged
                    hunks. Preserve other staged files.
                  </label>
                )}
                <Button
                  variant="secondary"
                  disabled={
                    locked ||
                    !!unresolved ||
                    !selection.length ||
                    (!!stagedSelection && !replaceStaged)
                  }
                  onClick={() =>
                    void perform("Preparing selected files…", () =>
                      rpc("git.preview", {
                        id: task.id,
                        request_id: crypto.randomUUID(),
                        expected_hash: snapshot.fingerprint,
                        paths: selection.filter((path) =>
                          snapshot.files.some((file) => file.path === path),
                        ),
                        replace_selected_staged: replaceStaged,
                        preset,
                      }),
                    )
                  }
                >
                  Prepare staged preview
                </Button>
                {record && (
                  <div className="git-selection-review">
                    <h4>
                      <ShieldCheck size={16} /> Selection review
                    </h4>
                    <p>
                      {record.review
                        ? `${record.review_source === "pipeline" ? "Full final review" : "Independent selection review"}: ${record.review.approval.replaceAll("_", " ")}`
                        : "This selection needs a fresh independent review. Subsets do not inherit approval for the full patch."}
                    </p>
                    {record.review && <p>{record.review.summary}</p>}
                    {record.verification_gap && (
                      <p className="error-box">{record.verification_gap}</p>
                    )}
                    {stale && (
                      <p className="error-text">
                        Task contents or index changed. Prepare a new preview
                        before continuing.
                      </p>
                    )}
                    <div className="actions">
                      {["draft", "reviewed"].includes(record.status) && (
                        <Button
                          disabled={locked || stale}
                          onClick={() =>
                            void perform(
                              "Antigravity is reviewing this selection…",
                              () => call("review"),
                            )
                          }
                        >
                          Review selection with Antigravity
                        </Button>
                      )}
                      {record.status === "reviewed" && (
                        <Button
                          variant="default"
                          disabled={
                            locked ||
                            stale ||
                            record.review?.approval !== "approved" ||
                            !!record.verification_gap
                          }
                          onClick={() =>
                            void perform("Saving manual approval…", () =>
                              call("approve", { confirmed: true }),
                            )
                          }
                        >
                          Approve selected files
                        </Button>
                      )}
                    </div>
                    <details>
                      <summary>Staged diff</summary>
                      {detail ? (
                        <>
                          {detail.diff_error ? (
                            <p className="error" role="status">
                              Staged preview unavailable: {detail.diff_error}
                            </p>
                          ) : (
                            <pre className="git-staged-diff">
                              {detail.diff || "No tree changes."}
                            </pre>
                          )}
                          {detail.diff_truncated && (
                            <p>
                              Preview truncated. Open Changes to inspect
                              individual files.
                            </p>
                          )}
                        </>
                      ) : (
                        <ListSkeleton label="Loading staged diff" />
                      )}
                    </details>
                  </div>
                )}
                <Button
                  variant="default"
                  disabled={
                    locked ||
                    !record ||
                    ![
                      "approved",
                      "committed",
                      "prepared",
                      "published",
                      "not_published",
                    ].includes(record.status)
                  }
                  onClick={() => setStep(1)}
                >
                  Continue to commit
                </Button>
              </section>
              <section className="git-commit-panel" hidden={step === 0}>
                <h3>
                  <GitCommitHorizontal size={17} />{" "}
                  {step === 1 ? "Commit" : step === 2 ? "Publish" : "Confirm"}
                </h3>
                <div hidden={step !== 2}>
                  <p>
                    Destination repository:{" "}
                    <strong>
                      {repository?.origin_url
                        ?.replace(/^https:\/\/github.com\//, "")
                        .replace(/\.git$/, "") ||
                        "Contribution fork not connected"}
                    </strong>
                  </p>
                  {!repository?.origin_url && (
                    <div className="notice">
                      <p>
                        Connect your fork to publish. You can still keep a local
                        commit.
                      </p>
                      <Button
                        disabled={!repository || locked}
                        onClick={() => setConnectingFork(true)}
                      >
                        Connect Fork
                      </Button>
                    </div>
                  )}
                  <details>
                    <summary>Saved task presets</summary>
                    <label>
                      Workflow preset
                      <select
                        aria-label="Git workflow preset"
                        value={
                          workflows.some((item) => item.name === preset.name)
                            ? preset.name
                            : "Custom safe preset"
                        }
                        disabled={locked || committed}
                        onChange={(event) => {
                          const value = workflows.find(
                            (item) => item.name === event.target.value,
                          );
                          if (value) setPreset({ ...preset, ...value });
                        }}
                      >
                        {workflows.map((item) => (
                          <option key={item.name}>{item.name}</option>
                        ))}
                        <option>Custom safe preset</option>
                      </select>
                    </label>
                  </details>
                  <div className="git-hook-options">
                    <label>
                      Publication
                      <select
                        aria-label="Git push mode"
                        value={preset.push}
                        disabled={locked || record?.status === "published"}
                        onChange={(event) =>
                          setPreset({
                            ...preset,
                            name: "Custom safe preset",
                            push: event.target.value as GitPreset["push"],
                          })
                        }
                      >
                        <option value="none">Keep local</option>
                        <option value="normal">Normal push</option>
                        <option value="skip">
                          Skip optional pre-push hooks
                        </option>
                      </select>
                    </label>
                  </div>
                  <p className="muted">
                    --no-verify skips optional Git checks. Workspace
                    authorization, selected-file review, ancestry and remote SHA
                    guards always apply. Normal hooks run in the read-only
                    sandbox; hooks that rewrite messages must be resolved
                    explicitly.
                  </p>
                  {snapshot.hook_configuration === "/dev/null" && (
                    <p className="warning-box">
                      Repository/worktree configuration disables optional hooks.
                      Mandatory verification and publication checks still apply.
                    </p>
                  )}
                  <div className="form-grid" hidden={!repository?.origin_url}>
                    <label>
                      Target remote
                      <input
                        aria-label="Git target remote"
                        value={preset.remote}
                        disabled={
                          locked ||
                          (!!record && !committed) ||
                          (!!record &&
                            ![
                              "committed",
                              "prepared",
                              "not_published",
                            ].includes(record.status))
                        }
                        onChange={(event) => {
                          setPreset({ ...preset, remote: event.target.value });
                          setConfirmPush(false);
                        }}
                      />
                    </label>
                    <label>
                      Target branch
                      <input
                        aria-label="Git target branch"
                        value={preset.branch}
                        disabled={
                          locked ||
                          (!!record && !committed) ||
                          (!!record &&
                            ![
                              "committed",
                              "prepared",
                              "not_published",
                            ].includes(record.status))
                        }
                        onChange={(event) => {
                          setPreset({ ...preset, branch: event.target.value });
                          setConfirmPush(false);
                        }}
                      />
                    </label>
                  </div>
                  <Button
                    size="sm"
                    disabled={locked}
                    onClick={async () => {
                      setBusy("Saving preset…");
                      setError("");
                      try {
                        await rpc("git.preset", { id: task.id, preset });
                        setNotice("Saved this task's typed workflow preset.");
                      } catch (error) {
                        setError(errorMessage(error));
                      } finally {
                        setBusy("");
                      }
                    }}
                  >
                    Save task preset
                  </Button>
                  <Button
                    variant="default"
                    disabled={
                      locked ||
                      (!repository?.origin_url && preset.push !== "none")
                    }
                    onClick={() => setStep(3)}
                  >
                    Review operation
                  </Button>
                </div>
                <div hidden={step !== 1}>
                  <label>
                    Exact commit message
                    <textarea
                      aria-label="Exact Git commit message"
                      rows={6}
                      value={message}
                      disabled={locked || committed}
                      onChange={(event) => {
                        updateMessage(event.target.value);
                      }}
                      placeholder="Type your own commit message…"
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={locked || committed}
                    onClick={() => {
                      updateMessage(task.issue.body || task.issue.title || "");
                    }}
                  >
                    Use original issue text
                  </Button>
                  <details>
                    <summary>Exact proposed message</summary>
                    <pre className="git-exact-message">
                      {message || "No message entered."}
                    </pre>
                  </details>
                  <details>
                    <summary>Advanced commit options</summary>
                    <label className="inline-check">
                      <input
                        type="checkbox"
                        checked={preset.commit_hooks === "skip"}
                        disabled={locked || committed}
                        onChange={(event) =>
                          setPreset({
                            ...preset,
                            name: "Custom safe preset",
                            commit_hooks: event.target.checked
                              ? "skip"
                              : "normal",
                          })
                        }
                      />
                      Skip optional commit hooks
                    </label>
                  </details>
                  <Button
                    variant="default"
                    disabled={locked || !message.length}
                    onClick={() => setStep(2)}
                  >
                    Continue to publish
                  </Button>
                </div>
                <div hidden={step !== 3}>
                  <p>
                    {committed ? "Publish" : "Commit"}{" "}
                    {record?.paths.length || selection.length} reviewed files
                    {preset.push === "none"
                      ? " locally"
                      : ` and push to ${repository?.origin_url?.replace(/^https:\/\/github.com\//, "").replace(/\.git$/, "") || "your contribution fork"}:${preset.branch}`}
                    .
                  </p>
                  <details>
                    <summary>Exact commit message</summary>
                    <pre className="git-exact-message">{message}</pre>
                  </details>
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={confirmMessage}
                      disabled={locked || committed}
                      onChange={(event) =>
                        setConfirmMessage(event.target.checked)
                      }
                    />
                    I confirm this exact message and the approved selected
                    files.
                  </label>
                  <Button
                    variant="default"
                    busy={!!busy && busy.startsWith("Creating")}
                    disabled={
                      locked ||
                      stale ||
                      record?.status !== "approved" ||
                      !message.length ||
                      !confirmMessage
                    }
                    onClick={() => void commit()}
                  >
                    {preset.push === "none"
                      ? "Confirm local commit"
                      : "Commit and prepare push"}
                  </Button>
                  {record?.head && (
                    <p className="git-commit-success">
                      <CheckCircle2 size={16} />
                      <span>
                        Local commit <code>{record.head}</code>
                      </span>
                    </p>
                  )}
                  <section className="git-publish-panel">
                    <h3>
                      <Upload size={17} /> Publish
                    </h3>
                    {record?.destination ? (
                      <>
                        <dl className="repository-facts">
                          <dt>Repository</dt>
                          <dd>{record.destination.repository}</dd>
                          <dt>Upstream</dt>
                          <dd>{record.destination.upstream}</dd>
                          <dt>Remote</dt>
                          <dd>{record.destination.remote}</dd>
                          <dt>Branch</dt>
                          <dd>
                            <code>{record.destination.branch}</code>
                          </dd>
                          <dt>GitHub destination</dt>
                          <dd>
                            <code>{record.destination.url}</code>
                          </dd>
                          <dt>Account</dt>
                          <dd>{record.destination.viewer}</dd>
                          <dt>Expected remote SHA</dt>
                          <dd>
                            <code>
                              {/^0+$/.test(record.destination.expected_remote)
                                ? "New branch · must still be absent"
                                : record.destination.expected_remote}
                            </code>
                          </dd>
                        </dl>
                        {record.status === "prepared" && (
                          <>
                            <label className="inline-check">
                              <input
                                type="checkbox"
                                checked={confirmPush}
                                disabled={locked || destinationDirty}
                                onChange={(event) =>
                                  setConfirmPush(event.target.checked)
                                }
                              />
                              Publish this exact commit to the repository and
                              branch shown above.
                            </label>
                            <Button
                              variant="default"
                              disabled={
                                locked ||
                                stale ||
                                destinationDirty ||
                                !confirmPush ||
                                preset.push === "none"
                              }
                              onClick={() =>
                                void perform(
                                  "Publishing with mandatory host checks…",
                                  () =>
                                    call("publish", {
                                      skip_hooks: preset.push === "skip",
                                      confirmed: true,
                                    }),
                                )
                              }
                            >
                              Confirm push
                            </Button>
                          </>
                        )}
                        {record.status === "published" && (
                          <p className="git-commit-success">
                            <CheckCircle2 size={16} />
                            Push verified against the remote branch.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="muted">
                        {repository?.origin_url
                          ? `Configured contribution repository: ${repository.origin_url}. Check the live destination after committing.`
                          : "Connect a contribution fork in Repositories to enable publication. Local commits remain available."}
                      </p>
                    )}
                    {record &&
                      (["committed", "not_published"].includes(record.status) ||
                        (record.status === "prepared" && destinationDirty)) && (
                        <Button
                          disabled={locked || stale}
                          onClick={() =>
                            void perform(
                              "Checking remote identity, permission and SHA…",
                              () =>
                                call("prepare", {
                                  destination: {
                                    remote: preset.remote,
                                    branch: preset.branch,
                                  },
                                }),
                            )
                          }
                        >
                          Check destination for push
                        </Button>
                      )}
                    {record &&
                      [
                        "uncertain",
                        "pushing",
                        "committing",
                        "interrupted",
                      ].includes(record.status) && (
                        <>
                          <p className="error-text">
                            Reconcile the saved operation before retrying.
                          </p>
                          <Button
                            disabled={locked}
                            onClick={() =>
                              void perform("Reconciling saved Git state…", () =>
                                call("reconcile"),
                              )
                            }
                          >
                            Reconcile state
                          </Button>
                          {record.status === "interrupted" && record.head && (
                            <Button
                              disabled={locked}
                              onClick={() =>
                                void perform(
                                  "Resuming the saved local commit…",
                                  () =>
                                    call("resumeCommit", { confirmed: true }),
                                )
                              }
                            >
                              Confirm resume local commit
                            </Button>
                          )}
                        </>
                      )}
                    {record?.error && (
                      <p className="error-box">{errorMessage(record.error)}</p>
                    )}
                  </section>
                </div>
              </section>
            </div>
            <section
              className="git-operation-panel"
              aria-label="Git operation output"
            >
              <header>
                <h3>Operation output</h3>
                {busy && (
                  <span role="status">
                    {busy}
                    {executing && operationStarted
                      ? ` · ${duration(operationStarted)}`
                      : ""}
                  </span>
                )}
                {(executing || (!busy && snapshot.active)) && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      void rpc("git.cancel", { id: task.id }).catch((error) =>
                        setError(errorMessage(error)),
                      )
                    }
                  >
                    Cancel Git operation
                  </Button>
                )}
              </header>
              <details className="git-operation-log">
                <summary>Saved operation log and recovery</summary>
                {detail?.events.length ? (
                  <>
                    <ol>
                      {detail.events
                        .filter(
                          (event) =>
                            !event.phase.startsWith("git ") &&
                            !/(?:stdout|stderr)$/.test(event.phase),
                        )
                        .map((event) => (
                          <li key={event.id}>
                            <strong>{event.phase}</strong>
                            {event.exit_code !== null && (
                              <small> · exit {event.exit_code}</small>
                            )}
                          </li>
                        ))}
                    </ol>
                    <details>
                      <summary>Exact redacted stdout / stderr</summary>
                      <div className="actions">
                        <Button
                          size="sm"
                          disabled={!detail.events_older}
                          onClick={() => setBeforeEvent(detail.events[0]?.id)}
                        >
                          Earlier output
                        </Button>
                        <Button
                          size="sm"
                          disabled={!beforeEvent}
                          onClick={() => setBeforeEvent(undefined)}
                        >
                          Latest output
                        </Button>
                        <small>
                          Up to 200 saved events per page. Oversized events show
                          an explicit truncation marker.
                        </small>
                      </div>
                      <pre>
                        {detail.events
                          .map(
                            (event) =>
                              `${event.timestamp} ${event.phase}${event.exit_code === null ? "" : ` [exit ${event.exit_code}]`}\n${event.output}`,
                          )
                          .join("\n")}
                      </pre>
                    </details>
                  </>
                ) : (
                  <p className="muted">
                    Real Git output and exit codes appear here when an operation
                    runs.
                  </p>
                )}
                {!!snapshot.history.length && (
                  <label>
                    Saved operation history
                    <select
                      aria-label="Saved Git operation history"
                      value={record?.id || ""}
                      disabled={locked}
                      onChange={(event) => {
                        const item = snapshot.history.find(
                          (item) => item.id === event.target.value,
                        );
                        setRecord(item);
                        if (item) {
                          setSelection(item.paths);
                          setMessage(item.message || "");
                          setPreset(item.preset);
                        }
                        setConfirmPush(false);
                        setConfirmMessage(false);
                      }}
                    >
                      <option value="">New selection</option>
                      {snapshot.history.map((item) => (
                        <option key={item.id} value={item.id}>
                          {new Date(item.created_at).toLocaleString()} ·{" "}
                          {(item.id === record?.id
                            ? record.status
                            : item.status
                          ).replaceAll("_", " ")}{" "}
                          · {item.paths.length} paths
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {record && (
                  <details className="git-remove-preview">
                    <summary>Remove this review preview</summary>
                    <p className="muted">
                      This removes the isolated review worktree and its saved
                      operation history. Your task branch and local commit are
                      retained.
                    </p>
                    <label className="inline-check">
                      <input
                        type="checkbox"
                        checked={confirmRemoval}
                        disabled={locked || !!unresolved}
                        onChange={(event) =>
                          setConfirmRemoval(event.target.checked)
                        }
                      />
                      Remove this owned preview and its saved history.
                    </label>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={locked || !!unresolved || !confirmRemoval}
                      onClick={async () => {
                        setBusy("Removing owned review preview…");
                        setError("");
                        try {
                          await rpc("git.remove", {
                            id: task.id,
                            operation_id: record.id,
                            confirmed: true,
                          });
                          setRecord(undefined);
                          setDetail(undefined);
                          setConfirmRemoval(false);
                          await load();
                          setNotice(
                            "Review preview removed. The task branch and local commit are retained.",
                          );
                        } catch (error) {
                          setError(errorMessage(error));
                        } finally {
                          setBusy("");
                        }
                      }}
                    >
                      Remove review preview and history
                    </Button>
                  </details>
                )}
              </details>
            </section>
          </>
        )}
        <footer className="git-finalization-footer">
          <small>
            Task branch <code>{task.branch_name}</code>
          </small>
          <div className="actions">
            {task.status === "ready_for_review" && !record?.head && (
              <Button
                disabled={locked}
                onClick={async () => {
                  setBusy("Marking task complete…");
                  try {
                    await complete();
                    close();
                  } catch (error) {
                    setError(errorMessage(error));
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Mark task complete
              </Button>
            )}
            <Button variant="secondary" disabled={locked} onClick={close}>
              Keep local and close
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
};
