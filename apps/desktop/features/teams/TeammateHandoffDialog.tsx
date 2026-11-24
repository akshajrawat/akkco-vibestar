import { useEffect, useState } from "react";
import { ArrowRight, X, AlertCircle } from "lucide-react";

import type { AgentProfile } from "../../../core/vibers/contracts";
import type { ViberTeam } from "../../../core/vibers/teams-contracts";
import { Button } from "../../components/ui/button";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { rpc, errorMessage } from "../../lib/api";
import { ViberFace } from "../vibers/ViberFace";

interface TeammateHandoffDialogProps {
  sourceProfile: AgentProfile;
  sourceSessionId: string;
  profiles: AgentProfile[];
  close: () => void;
  onHandoffComplete?: (targetProfile: AgentProfile) => void;
}

export const TeammateHandoffDialog = ({
  sourceProfile,
  sourceSessionId,
  profiles,
  close,
  onHandoffComplete,
}: TeammateHandoffDialogProps) => {
  const [teams, setTeams] = useState<ViberTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [targetProfileId, setTargetProfileId] = useState<string>("");
  const [contextSnapshot, setContextSnapshot] = useState<string>("");
  const [instruction, setInstruction] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  useEffect(() => {
    let active = true;

    void rpc<ViberTeam[]>("viber.team.list")
      .then((allTeams) => {
        if (!active) {
          return;
        }

        const memberTeams = allTeams.filter((t) => t.members.includes(sourceProfile.id));
        setTeams(memberTeams);

        if (memberTeams.length > 0) {
          const firstTeam = memberTeams[0];
          setSelectedTeamId(firstTeam.id);
          const firstTeammateId = firstTeam.members.find((id) => id !== sourceProfile.id);
          if (firstTeammateId) {
            setTargetProfileId(firstTeammateId);
          }
        }

        setLoading(false);
      })
      .catch((err) => {
        if (active) {
          setError(errorMessage(err));
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [sourceProfile.id]);

  useEffect(() => {
    if (!selectedTeamId || !targetProfileId) {
      return;
    }

    let active = true;
    setPreparing(true);
    setError("");

    void rpc<{ default_context_snapshot: string }>("viber.team.prepareHandoff", {
      team_id: selectedTeamId,
      source_session_id: sourceSessionId,
      source_profile_id: sourceProfile.id,
      target_profile_id: targetProfileId,
    })
      .then((prep) => {
        if (active) {
          setContextSnapshot(prep.default_context_snapshot);
          setPreparing(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(errorMessage(err));
          setPreparing(false);
        }
      });

    return () => {
      active = false;
    };
  }, [selectedTeamId, targetProfileId, sourceSessionId, sourceProfile.id]);

  const currentTeam = teams.find((t) => t.id === selectedTeamId);

  const availableTeammates = currentTeam
    ? currentTeam.members
        .filter((id) => id !== sourceProfile.id)
        .map((id) => profileMap.get(id))
        .filter((p): p is AgentProfile => Boolean(p))
    : [];

  const handleTeamChange = (teamId: string) => {
    setSelectedTeamId(teamId);
    const team = teams.find((t) => t.id === teamId);
    const firstTeammate = team?.members.find((id) => id !== sourceProfile.id);
    if (firstTeammate) {
      setTargetProfileId(firstTeammate);
    }
  };

  const handleApproveAndHandoff = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedTeamId || !targetProfileId) {
      setError("Select a team and target teammate.");
      return;
    }

    if (!contextSnapshot.trim()) {
      setError("Context snapshot is required.");
      return;
    }

    if (!instruction.trim()) {
      setError("Please provide a handoff task or instruction for the teammate.");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const requestId = crypto.randomUUID();

      await rpc("viber.team.handoff", {
        request_id: requestId,
        team_id: selectedTeamId,
        source_session_id: sourceSessionId,
        source_profile_id: sourceProfile.id,
        target_profile_id: targetProfileId,
        context_snapshot: contextSnapshot.trim(),
        instruction: instruction.trim(),
      });

      const target = profileMap.get(targetProfileId);
      close();
      if (target && onHandoffComplete) {
        onHandoffComplete(target);
      }
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  const targetProfile = profileMap.get(targetProfileId);

  return (
    <WorkspaceOverlay
      label="Handoff to teammate"
      className="teammate-handoff-dialog-overlay"
      onClose={close}
    >
      <div className="flex flex-col h-full max-h-[90vh] w-[660px] max-w-[95vw] bg-surface-primary text-foreground rounded-lg overflow-hidden">
        <header className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2">
            <ArrowRight size={18} className="text-accent" aria-hidden="true" />
            <h2 className="text-[15px] font-semibold">Handoff to Teammate</h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Cancel and close handoff dialog"
            onClick={close}
            disabled={submitting}
          >
            <X size={18} />
          </Button>
        </header>

        <form onSubmit={handleApproveAndHandoff} className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 p-3 bg-surface-error text-accent-red rounded text-[13px]"
            >
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {loading ? (
            <p className="text-[13px] text-ink-muted py-4">Checking team memberships…</p>
          ) : teams.length === 0 ? (
            <div className="text-center py-8 text-ink-muted text-[13px] space-y-2">
              <p>
                <strong>{sourceProfile.name}</strong> is not part of any team with available
                teammates.
              </p>
              <p className="text-[12px] text-ink-secondary">
                Use the Teams manager to group Vibers into a team before initiating a handoff.
              </p>
              <div className="pt-2">
                <Button type="button" variant="secondary" size="sm" onClick={close}>
                  Close
                </Button>
              </div>
            </div>
          ) : (
            <>
              {teams.length > 1 && (
                <div>
                  <label className="block text-[12px] font-medium text-ink-secondary mb-1">
                    Select Team
                  </label>
                  <select
                    className="w-full px-3 py-1.5 text-[13px] rounded bg-surface-elevated focus:outline-none"
                    value={selectedTeamId}
                    onChange={(e) => handleTeamChange(e.target.value)}
                    disabled={submitting}
                  >
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.members.length} members)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-[12px] font-medium text-ink-secondary mb-1.5">
                  Select Teammate in {currentTeam?.name}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {availableTeammates.map((teammate) => {
                    const isSelected = teammate.id === targetProfileId;
                    return (
                      <button
                        key={teammate.id}
                        type="button"
                        onClick={() => setTargetProfileId(teammate.id)}
                        disabled={submitting}
                        className={`flex items-center gap-2 p-2.5 rounded text-left transition-colors ${
                          isSelected
                            ? "bg-surface-selected font-medium text-ink-primary"
                            : "bg-surface-elevated hover:bg-surface-hover text-ink-secondary"
                        }`}
                      >
                        <ViberFace profile={teammate} compact />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] font-medium truncate">{teammate.name}</p>
                          <small className="text-[11px] text-ink-muted">
                            {teammate.execution.provider} · {teammate.execution.model || "default"}
                          </small>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[12px] font-medium text-ink-secondary">
                    Context Snapshot (Reviewed & Approved by User)
                  </label>
                  <span className="text-[11px] text-ink-muted">
                    {contextSnapshot.length} / 16,000
                  </span>
                </div>
                <textarea
                  className="w-full h-32 px-3 py-2 text-[12px] font-mono leading-relaxed rounded bg-surface-elevated focus:outline-none resize-y"
                  value={contextSnapshot}
                  onChange={(e) => setContextSnapshot(e.target.value)}
                  placeholder={
                    preparing
                      ? "Preparing sanitized context snapshot…"
                      : "User-approved context snapshot"
                  }
                  maxLength={16000}
                  disabled={submitting || preparing}
                  required
                />
                <p className="text-[11px] text-ink-muted mt-0.5">
                  Private memory facts and internal tool logs are strictly excluded by default.
                  Inspect and adjust the context snapshot above.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[12px] font-medium text-ink-secondary">
                    Handoff Task / Instruction for {targetProfile?.name || "Teammate"}
                  </label>
                  <span className="text-[11px] text-ink-muted">{instruction.length} / 16,000</span>
                </div>
                <textarea
                  className="w-full h-24 px-3 py-2 text-[13px] leading-relaxed rounded bg-surface-elevated focus:outline-none resize-y"
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  placeholder={`What would you like ${targetProfile?.name || "teammate"} to work on with this context?`}
                  maxLength={16000}
                  disabled={submitting}
                  required
                />
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-border-subtle">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={close}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="default"
                  size="sm"
                  busy={submitting}
                  disabled={!targetProfileId || !contextSnapshot.trim() || !instruction.trim()}
                >
                  Approve &amp; Handoff
                </Button>
              </div>
            </>
          )}
        </form>
      </div>
    </WorkspaceOverlay>
  );
};
