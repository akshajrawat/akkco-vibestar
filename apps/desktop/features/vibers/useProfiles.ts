import { useCallback, useEffect, useState } from "react";

import type { AgentProfile, ViberNavigation } from "../../../core/vibers/contracts";
import { rpc, errorMessage } from "../../lib/api";

export const useProfiles = (revision: number) => {
  const [{ profiles, previews, created_at_by_profile }, setNavigation] = useState<ViberNavigation>({
    profiles: [],
    previews: [],
  });

  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    let active = true;

    void rpc<ViberNavigation | AgentProfile[]>("profile.list", { include_previews: true })
      .then((navigation) => {
        if (!active) {
          return;
        }

        setNavigation(
          Array.isArray(navigation) ? { profiles: navigation, previews: [] } : navigation,
        );

        setError("");
      })
      .catch((reason) => {
        if (active) {
          setError(errorMessage(reason));
        }
      });

    return () => {
      active = false;
    };
  }, [revision, reload]);

  return { profiles, previews, createdAtByProfile: created_at_by_profile, error, refresh };
};
