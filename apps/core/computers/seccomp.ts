import profile from "./moby-seccomp.json";

const newUser = 0x10000000;
const newPid = 0x20000000;
const newNet = 0x40000000;
const namespaceMask = 2114060288;

// Chromium creates nested user, PID and network namespaces. Kernel capability checks
// still apply to PID/network cloning and chroot inside those namespaces.
const namespaceClones = profile.syscalls
  .filter((rule) => rule.names.includes("clone") && rule.args?.[0]?.value === namespaceMask)
  .flatMap((rule) =>
    [newUser, newUser | newPid, newUser | newNet, newUser | newPid | newNet, newPid].map(
      (flags) => ({ ...rule, args: [{ ...rule.args![0], valueTwo: flags }] }),
    ),
  );

export const desktopSeccomp = JSON.stringify({
  ...profile,
  syscalls: [
    ...profile.syscalls,
    ...namespaceClones,
    {
      names: ["unshare"],
      action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: newUser, op: "SCMP_CMP_EQ" }],
    },
    { names: ["chroot"], action: "SCMP_ACT_ALLOW" },
  ],
});
