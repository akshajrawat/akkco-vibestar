import { useCallback, useEffect, useState } from "react";

import type { AgentProfile } from "../../../backend/flows/contracts";
import type { ViberInstance } from "../../../backend/rpc/flows";
import { rpc, errorMessage } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { ProfileEditor } from "./ProfileEditor";
import { ViberFace } from "./FlowCanvas";

export const ProfileLibrary = ({
  chat,
  openInstance,
  revision = 0,
}: {
  chat?: (profileId: string) => void;
  openInstance?: (taskId: string, nodeId: string) => void;
  revision?: number;
}) => {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [instances, setInstances] = useState<ViberInstance[]>([]);
  const [edit, setEdit] = useState<AgentProfile>();
  const [error, setError] = useState("");
  const showInstances = !!openInstance;

  const load = useCallback(() => {
    void Promise.allSettled([
      rpc<AgentProfile[]>("profile.list"),
      showInstances ? rpc<ViberInstance[]>("viber.instances") : Promise.resolve([]),
    ]).then(([profiles, instances]) => {
      if (profiles.status === "fulfilled") setProfiles(profiles.value);
      if (instances.status === "fulfilled") setInstances(instances.value);
      const failed = [profiles, instances].find((result) => result.status === "rejected");
      setError(failed?.status === "rejected" ? errorMessage(failed.reason) : "");
    });
  }, [showInstances]);

  useEffect(load, [load, revision]);
  return (
    <section className="settings-section">
      <h2>{chat ? "Your Vibers" : "Viber profiles"}</h2>
      <p className="subtle">
        Reusable instructions, model, access and output settings. Editing a profile affects future
        runs; started attempts keep their captured configuration.
      </p>
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      {!profiles.length && (
        <p>No available profiles. Check saved-record diagnostics if profiles need recovery.</p>
      )}
      {profiles.map((profile) => (
        <article className="viber-library-member" key={profile.id}>
          <div className="viber-profile-select">
            <ViberFace />
            <span>
              <strong>{profile.name}</strong>
              <br />
              <small>
                {profile.execution.provider} · {profile.execution.model || "CLI default"} ·{" "}
                {profile.execution.access} · revision {profile.revision}
              </small>
            </span>
            {chat && (
              <Button size="sm" onClick={() => chat(profile.id)}>
                Chat with {profile.name}
              </Button>
            )}
            <Button size="sm" onClick={() => setEdit(profile)}>
              Edit {profile.name}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setEdit({
                  ...profile,
                  id: crypto.randomUUID(),
                  revision: 0,
                  name: `${profile.name.slice(0, 90)} copy`,
                })
              }
            >
              Duplicate
            </Button>
          </div>
          {openInstance && (
            <div className="viber-library-instances">
              {instances
                .filter((instance) => instance.profile_id === profile.id)
                .map((instance) => (
                  <Button
                    key={`${instance.task_id}:${instance.node_id}`}
                    variant="ghost"
                    size="sm"
                    onClick={() => openInstance(instance.task_id, instance.node_id)}
                  >
                    {instance.name} · {instance.goal.slice(0, 120)}
                    {instance.archived ? " · archived" : ""}
                  </Button>
                ))}
            </div>
          )}
        </article>
      ))}
      <Button
        disabled={!profiles.length}
        onClick={() =>
          setEdit({ ...profiles[0], id: crypto.randomUUID(), revision: 0, name: "New Viber" })
        }
      >
        New Viber profile
      </Button>
      {edit && <ProfileEditor profile={edit} close={() => setEdit(undefined)} saved={load} />}
    </section>
  );
};
