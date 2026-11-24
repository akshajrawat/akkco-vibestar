import { useEffect, useState } from "react";
import { Users, X, Plus, Trash2, Edit3, Check } from "lucide-react";

import type { AgentProfile } from "../../../core/vibers/contracts";
import type { ViberTeam } from "../../../core/vibers/teams-contracts";
import { Button } from "../../components/ui/button";
import { WorkspaceOverlay } from "../../components/ui/WorkspaceOverlay";
import { rpc, errorMessage } from "../../lib/api";
import { ViberFace } from "../vibers/ViberFace";

interface TeamsDialogProps {
  profiles: AgentProfile[];
  close: () => void;
}

export const TeamsDialog = ({ profiles, close }: TeamsDialogProps) => {
  const [teams, setTeams] = useState<ViberTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingTeam, setEditingTeam] = useState<ViberTeam | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form state
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const loadTeams = async () => {
    setLoading(true);
    setError("");
    try {
      const list = await rpc<ViberTeam[]>("viber.team.list");
      setTeams(list);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTeams();
  }, []);

  const openCreate = () => {
    setEditingTeam(null);
    setTeamName("");
    setTeamDescription("");
    setSelectedMemberIds(profiles.slice(0, 2).map((p) => p.id));
    setFormError("");
    setIsCreating(true);
  };

  const openEdit = (team: ViberTeam) => {
    setIsCreating(false);
    setEditingTeam(team);
    setTeamName(team.name);
    setTeamDescription(team.description || "");
    setSelectedMemberIds(team.members);
    setFormError("");
  };

  const cancelForm = () => {
    setIsCreating(false);
    setEditingTeam(null);
    setFormError("");
  };

  const toggleMember = (profileId: string) => {
    if (selectedMemberIds.includes(profileId)) {
      if (selectedMemberIds.length <= 2) {
        setFormError("A team must have at least 2 members.");
        return;
      }

      setSelectedMemberIds(selectedMemberIds.filter((id) => id !== profileId));
      setFormError("");
    } else {
      if (selectedMemberIds.length >= 8) {
        setFormError("A team can have at most 8 members.");
        return;
      }

      setSelectedMemberIds([...selectedMemberIds, profileId]);
      setFormError("");
    }
  };

  const saveTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim()) {
      setFormError("Team name is required.");
      return;
    }

    if (selectedMemberIds.length < 2) {
      setFormError("A team must have at least 2 members.");
      return;
    }

    if (selectedMemberIds.length > 8) {
      setFormError("A team can have at most 8 members.");
      return;
    }

    setFormBusy(true);
    setFormError("");
    try {
      await rpc("viber.team.save", {
        ...(editingTeam ? { id: editingTeam.id } : {}),
        name: teamName.trim(),
        description: teamDescription.trim() || undefined,
        member_ids: selectedMemberIds,
      });

      cancelForm();
      await loadTeams();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setFormBusy(false);
    }
  };

  const deleteTeam = async (teamId: string) => {
    if (!window.confirm("Are you sure you want to delete this team?")) {
      return;
    }

    try {
      await rpc("viber.team.delete", { team_id: teamId });
      if (editingTeam?.id === teamId) {
        cancelForm();
      }

      await loadTeams();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  return (
    <WorkspaceOverlay label="Viber Teams" className="teams-dialog-overlay" onClose={close}>
      <div className="flex flex-col h-full max-h-[85vh] w-[640px] max-w-[95vw] bg-surface-primary text-foreground rounded-lg overflow-hidden">
        <header className="flex items-center justify-between px-5 py-3.5 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2">
            <Users size={19} className="text-ink-secondary" aria-hidden="true" />
            <h2 className="text-[15px] font-semibold">Viber Teams</h2>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close teams dialog"
            onClick={close}
          >
            <X size={18} />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && (
            <p role="alert" className="text-accent-red text-[13px] bg-surface-error p-2.5 rounded">
              {error}
            </p>
          )}

          {!isCreating && !editingTeam && (
            <div className="flex items-center justify-between">
              <p className="text-[13px] text-ink-muted">
                Group Vibers into small teams (2 to 8 members) for user-directed teammate handoffs.
              </p>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={openCreate}
                disabled={profiles.length < 2}
                title={profiles.length < 2 ? "At least 2 Vibers required" : "Create new team"}
              >
                <Plus size={15} />
                New Team
              </Button>
            </div>
          )}

          {(isCreating || editingTeam) && (
            <form onSubmit={saveTeam} className="space-y-4 bg-surface-elevated p-4 rounded-lg">
              <h3 className="text-[14px] font-semibold">
                {isCreating ? "Create Team" : `Edit Team: ${editingTeam?.name}`}
              </h3>

              {formError && (
                <p role="alert" className="text-accent-red text-[12px]">
                  {formError}
                </p>
              )}

              <div>
                <label className="block text-[12px] font-medium text-ink-secondary mb-1">
                  Team Name
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-1.5 text-[13px] rounded bg-surface-primary focus:outline-none"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="e.g. Frontend Core, Reviewers"
                  maxLength={100}
                  required
                />
              </div>

              <div>
                <label className="block text-[12px] font-medium text-ink-secondary mb-1">
                  Description (optional)
                </label>
                <input
                  type="text"
                  className="w-full px-3 py-1.5 text-[13px] rounded bg-surface-primary focus:outline-none"
                  value={teamDescription}
                  onChange={(e) => setTeamDescription(e.target.value)}
                  placeholder="Team scope or purpose"
                  maxLength={500}
                />
              </div>

              <div>
                <label className="block text-[12px] font-medium text-ink-secondary mb-1">
                  Teammates ({selectedMemberIds.length} / 8 selected, min 2)
                </label>
                <div className="grid grid-cols-2 gap-2 mt-2 max-h-48 overflow-y-auto">
                  {profiles.map((profile) => {
                    const selected = selectedMemberIds.includes(profile.id);
                    return (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() => toggleMember(profile.id)}
                        className={`flex items-center gap-2 p-2 rounded text-left transition-colors ${
                          selected
                            ? "bg-surface-selected font-medium text-ink-primary"
                            : "bg-surface-primary hover:bg-surface-hover text-ink-secondary"
                        }`}
                      >
                        <ViberFace profile={profile} compact />
                        <span className="text-[13px] font-medium truncate flex-1">
                          {profile.name}
                        </span>
                        {selected && <Check size={14} className="text-accent" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={cancelForm}
                  disabled={formBusy}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="default" size="sm" busy={formBusy}>
                  {isCreating ? "Create Team" : "Save Changes"}
                </Button>
              </div>
            </form>
          )}

          {!isCreating && !editingTeam && (
            <div className="space-y-3">
              {loading && <p className="text-[13px] text-ink-muted">Loading teams…</p>}
              {!loading && teams.length === 0 && (
                <div className="text-center py-8 text-ink-muted text-[13px]">
                  <Users size={32} className="mx-auto mb-2 opacity-40" />
                  <p>No teams created yet.</p>
                  {profiles.length < 2 && (
                    <p className="text-[12px] mt-1 text-ink-secondary">
                      Create at least 2 Vibers before forming a team.
                    </p>
                  )}
                </div>
              )}

              {teams.map((team) => (
                <div
                  key={team.id}
                  className="flex items-center justify-between p-3.5 bg-surface-elevated rounded-lg"
                >
                  <div className="min-w-0 flex-1 pr-3">
                    <div className="flex items-center gap-2">
                      <strong className="text-[14px]">{team.name}</strong>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-primary text-ink-secondary">
                        {team.members.length} members
                      </span>
                    </div>
                    {team.description && (
                      <p className="text-[12px] text-ink-muted mt-0.5 truncate">
                        {team.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {team.members.map((memberId) => {
                        const member = profileMap.get(memberId);
                        return member ? (
                          <div
                            key={memberId}
                            className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-surface-primary text-[12px]"
                            title={member.name}
                          >
                            <ViberFace profile={member} compact />
                            <span className="truncate max-w-[120px]">{member.name}</span>
                          </div>
                        ) : null;
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit ${team.name}`}
                      onClick={() => openEdit(team)}
                    >
                      <Edit3 size={15} />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${team.name}`}
                      onClick={() => void deleteTeam(team.id)}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </WorkspaceOverlay>
  );
};
