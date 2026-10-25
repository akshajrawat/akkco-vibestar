// Decode literal command display words without evaluating shell syntax. This is
// only for evidence identity; executable recovery still uses verificationArgv.
const literalWords = (command: string) => {
  const words = [];
  let word = "";
  let started = false;
  let quote = "";
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote === "'") {
      if (character === "'") quote = "";
      else word += character;
      continue;
    }
    if (character === "\\") {
      const next = command[++index];
      if (next === undefined) return null;
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next))
        word += "\\";
      if (next !== "\n") word += next;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = "";
      else if (["$", "`"].includes(character)) return null;
      else word += character;
      continue;
    }
    if (["'", '"'].includes(character)) {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      if ("$`;&<>|()*?[]{}~#!".includes(character)) return null;
      word += character;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  return words;
};

export const verificationCommandText = (command: string) => {
  let words: string[] | null = null;
  try {
    const parsed: unknown = JSON.parse(command);
    if (
      Array.isArray(parsed) &&
      parsed.every((word) => typeof word === "string")
    )
      words = parsed;
  } catch {
    // Provider displays commonly wrap the literal script in shell quoting.
  }
  if (!words && /^(?:\/(?:usr\/)?bin\/)?(?:bash|sh)\s/.test(command))
    words = literalWords(command);
  return words?.length === 3 &&
    /^(?:\/(?:usr\/)?bin\/)?(?:bash|sh)$/.test(words[0]) &&
    ["-c", "-lc"].includes(words[1])
    ? words[2]
    : command;
};
