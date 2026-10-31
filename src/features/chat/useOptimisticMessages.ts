import { useState } from "react";

import type { Message } from "../../lib/types";

/** Server rows always win, including when an event echo precedes the RPC response. */
export const useOptimisticMessages = (owner: string, persisted: Message[]) => {
  const [local, setLocal] = useState<{ owner: string; messages: Message[] }>({
    owner,
    messages: [],
  });

  const ids = new Set(persisted.map((message) => message.id));

  const pending =
    local.owner === owner ? local.messages.filter((message) => !ids.has(message.id)) : [];

  if (local.owner !== owner || pending.length !== local.messages.length)
    setLocal({ owner, messages: pending });

  return {
    messages: [...persisted, ...pending],
    upsert: (message: Message) =>
      setLocal((current) => ({
        owner,
        messages: [
          ...(current.owner === owner ? current.messages : []).filter(
            (row) => row.id !== message.id,
          ),
          message,
        ],
      })),
    remove: (id: string) =>
      setLocal((current) =>
        current.owner === owner
          ? { owner, messages: current.messages.filter((message) => message.id !== id) }
          : current,
      ),
  };
};
