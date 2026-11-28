export const ViberGreeting = ({ name }: { name: string }) => (
  <article className="saved-assistant-message py-2">
    Hello, I’m <strong>{name}</strong>. What can I help you with?
  </article>
);
