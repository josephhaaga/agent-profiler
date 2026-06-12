import { useEffect, useMemo, useState } from "react";

const commands = [
  "Open sessions",
  "Open cache panel",
  "Open system prompt inspector",
  "Compare harnesses",
  "Search sessions",
  "Toggle live tail",
];

export function App() {
  const [omnibarOpen, setOmnibarOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOmnibarOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setOmnibarOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const matches = useMemo(
    () => commands.filter((command) => command.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">agent-profiler</div>
          <h1>Session-first agent harness analysis</h1>
        </div>
        <button className="ghost" onClick={() => setOmnibarOpen(true)}>
          Cmd+K
        </button>
      </header>

      <main className="grid">
        <section className="panel">
          <h2>Sessions</h2>
          <p>Connect the ingest pipeline next, then this becomes the primary explorer.</p>
        </section>
        <section className="panel">
          <h2>Insights</h2>
          <p>Cache misses, prompt bloat, model right-sizing, and latency attribution.</p>
        </section>
      </main>

      {omnibarOpen ? (
        <div className="omnibar-backdrop" onClick={() => setOmnibarOpen(false)}>
          <div className="omnibar" onClick={(event) => event.stopPropagation()}>
            <input
              autoFocus
              placeholder="Search commands, sessions, turns..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ul>
              {matches.map((command) => (
                <li key={command}>{command}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
