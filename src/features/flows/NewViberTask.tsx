import { useEffect, useRef, useState } from "react";

import { flowTemplates, builtInProfiles, type TemplateId } from "../../../backend/flows/templates";
import type { AgentProfile } from "../../../backend/flows/contracts";
import type { Repository, Task } from "../../lib/types";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { containDialogFocus } from "../../lib/keyboard";
import { ProfileEditor } from "./ProfileEditor";

export const NewViberTask = ({
  repositories,
  initialRepositoryId = "",
  initialProfileId,
  close,
  created,
  issueTask,
}: {
  repositories: Repository[];
  initialRepositoryId?: string;
  initialProfileId?: string;
  close: () => void;
  created: (id: string) => void;
  issueTask: () => void;
}) => {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profile, setProfile] = useState<string>(initialProfileId || builtInProfiles.implementer);
  const [goal, setGoal] = useState("");
  const [repository, setRepository] = useState(initialRepositoryId);
  const [template, setTemplate] = useState<"solo" | TemplateId>("solo");
  const [edit, setEdit] = useState<AgentProfile>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef({ digest: "", id: "" });
  const focus = useDialogFocus(true);

  const load = () =>
    void rpc<AgentProfile[]>("profile.list")
      .then(setProfiles)
      .catch((e) => setError(errorMessage(e)));

  useEffect(load, []);

  return (
    <div className="modal-backdrop">
      <section
        ref={focus}
        className="modal new-viber-task"
        role="dialog"
        aria-modal="true"
        aria-label="New Viber task"
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
          containDialogFocus(event);
        }}
      >
        <div className="modal-heading">
          <h2>What are we building?</h2>
          <Button onClick={close}>Close</Button>
        </div>
        <p className="subtle">Give a Viber a goal, or put a team on a flow.</p>
        <Button variant="ghost" size="sm" onClick={issueTask}>
          Start from a GitHub issue
        </Button>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");

            const payload = {
              goal,
              repository_id: repository || null,
              profile_id: profile,
              ...(template === "solo" ? {} : { template }),
            };

            const digest = JSON.stringify(payload);
            if (request.current.digest !== digest)
              request.current = { digest, id: crypto.randomUUID() };
            try {
              const task = await rpc<Task>("task.createGeneral", {
                ...payload,
                request_id: request.current.id,
              });

              created(task.id);
              close();
            } catch (reason) {
              setError(errorMessage(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Goal
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={4}
              required
              maxLength={32000}
              placeholder="Describe what you want to do…"
            />
          </label>
          <label>
            Workspace
            <select
              aria-label="Workspace"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
            >
              <option value="">Managed workspace · no repository</option>
              {repositories
                .filter((repo) => repo.connected !== false)
                .map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.owner}/{repo.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Start with
            <select
              aria-label="Start with"
              value={template}
              onChange={(event) => setTemplate(event.target.value as typeof template)}
            >
              <option value="solo">Solo Viber</option>
              {flowTemplates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {template === "solo" && (
            <div className="viber-profile-select">
              <label>
                Viber profile
                <select
                  aria-label="Viber profile"
                  value={profile}
                  onChange={(event) => setProfile(event.target.value)}
                >
                  {profiles.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.execution.provider} · {item.execution.access}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                type="button"
                onClick={() => setEdit(profiles.find((item) => item.id === profile))}
              >
                Edit profile
              </Button>
            </div>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <p className="subtle">Creation saves a draft. Start execution when you’re ready.</p>
          <Button
            type="submit"
            disabled={busy || !profiles.length || !goal.trim()}
            variant="default"
          >
            Create workspace
          </Button>
        </form>
      </section>
      {edit && <ProfileEditor profile={edit} close={() => setEdit(undefined)} saved={load} />}
    </div>
  );
};
