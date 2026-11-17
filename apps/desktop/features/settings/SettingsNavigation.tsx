import { useState } from "react";
import { Database, FolderGit2, Plug, Search, Settings2, Terminal } from "lucide-react";

const groups = [
  { label: "Application", items: [{ name: "General", icon: Settings2 }] },
  {
    label: "AI & Agents",
    items: [{ name: "Providers", icon: Plug }],
  },
  {
    label: "Workspace",
    items: [
      { name: "Repositories", icon: FolderGit2 },
      { name: "Execution", icon: Terminal },
    ],
  },
  {
    label: "System",
    items: [{ name: "Storage", icon: Database }],
  },
] as const;

export type SettingsCategory = (typeof groups)[number]["items"][number]["name"];

export const SettingsNavigation = ({
  selected,
  select,
}: {
  selected: SettingsCategory;
  select: (category: SettingsCategory) => void;
}) => {
  const [query, setQuery] = useState("");

  const visible = groups.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      `${group.label} ${item.name}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  }));

  return (
    <aside className="settings-sidebar">
      <div className="settings-sidebar-heading">Settings</div>
      <label className="settings-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label="Search settings"
          placeholder="Search settings…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
      </label>
      <nav className="settings-nav" aria-label="Settings sections">
        {visible.map(
          (group) =>
            group.items.length > 0 && (
              <div className="settings-nav-group" key={group.label}>
                <h2>{group.label}</h2>
                {group.items.map(({ name, icon: Icon }) => (
                  <button
                    type="button"
                    key={name}
                    className={selected === name ? "selected" : ""}
                    aria-current={selected === name ? "page" : undefined}
                    aria-controls={`settings-${name.replaceAll(" ", "-")}`}
                    onClick={() => select(name)}
                  >
                    <Icon size={15} aria-hidden="true" />
                    {name}
                  </button>
                ))}
              </div>
            ),
        )}
        {visible.every((group) => !group.items.length) && (
          <p className="settings-no-results" role="status">
            No settings found.
          </p>
        )}
      </nav>
    </aside>
  );
};
