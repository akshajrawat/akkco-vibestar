export const terminalTheme = () => {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--background-app").trim() || undefined,
    foreground: styles.getPropertyValue("--text-primary").trim() || undefined,
    cursor: styles.getPropertyValue("--accent-blue").trim() || undefined,
    fontFamily: styles.getPropertyValue("--font-mono").trim() || "monospace",
  };
};
