import { useCallback, useEffect, useState } from "react";

import type { AgentProfile } from "../../../backend/flows/contracts";
import { isCustomViber } from "../../../backend/flows/templates";
import { rpc, errorMessage } from "../../lib/api";

export const useProfiles = (revision: number) => {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    let active = true;

    void rpc<AgentProfile[]>("profile.list")
      .then((profiles) => {
        if (!active) return;
        setProfiles(profiles.filter(isCustomViber));
        setError("");
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });

    return () => {
      active = false;
    };
  }, [revision, reload]);

  return { profiles, error, refresh };
};
