export const workflows = [
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
