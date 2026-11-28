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
    items: group.items.filter((item) => {
      const labels =
        item.name === "General"
          ? "Viber Workspaces Permission Always ask Full permission Allow Vibers to talk with each other Enable Memory"
          : "";

      return `${group.label} ${item.name} ${labels}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
    }),
  }));

  return (
    <aside className="settings-sidebar flex flex-col min-h-0 p-[22px_14px_14px] [@media(max-width:700px)]:px-2 [@media(max-width:700px)]:py-4 [@media(max-width:450px)]:max-h-[190px]">
      <div className="text-[16px] font-semibold p-[0_10px_18px] [@media(max-width:450px)]:hidden">
        Settings
      </div>
      <label className="settings-search m-[0_0_18px] [@media(max-width:450px)]:mb-2.5">
        <Search size={15} className="shrink-0" aria-hidden="true" />
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
      <nav
        className="settings-nav min-h-0 overflow-y-auto overscroll-contain [@media(max-width:450px)]:flex [@media(max-width:450px)]:flex-wrap [@media(max-width:450px)]:gap-[8px_16px]"
        aria-label="Settings sections"
      >
        {visible.map(
          (group) =>
            group.items.length > 0 && (
              <div
                className="settings-nav-group mb-4.5 [@media(max-width:450px)]:mb-0 [@media(max-width:450px)]:flex-[1_0_130px]"
                key={group.label}
              >
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
          <p className="text-ink-muted p-2.5" role="status">
            No settings found.
          </p>
        )}
      </nav>
    </aside>
  );
};
