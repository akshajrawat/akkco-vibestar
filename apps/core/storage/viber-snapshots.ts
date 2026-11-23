import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { AdeError } from "../domain";
import { ViberMessageSnapshotSchema } from "../vibers/contracts";
import type { z } from "zod";

type Snapshot = z.infer<typeof ViberMessageSnapshotSchema>;

export const viberSnapshotVersion = 46;
export const viberSnapshotKeyPath = (databasePath: string) => `${databasePath}.viber-key`;

const unavailable = () =>
  new AdeError("snapshot_key", "The private Viber snapshot key is unavailable.");

const privateKeyFile = (info: Stats) =>
  info.isFile() &&
  info.uid === process.getuid?.() &&
  info.nlink === 1 &&
  (info.mode & 0o777) === 0o600;

export const loadViberSnapshotKey = async (path: string, create: boolean) => {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (privateKeyFile(info) && info.size === 32) {
        const bytes = await file.readFile();
        return bytes.length === 32 ? bytes : undefined;
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && create) {
      const key = randomBytes(32);
      const file = await open(path, "wx", 0o600);
      try {
        if (!privateKeyFile(await file.stat())) {
          return undefined;
        }

        await file.writeFile(key);
        await file.sync();
      } finally {
        await file.close();
      }

      const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }

      return key;
    }
  }

  return undefined;
};

const associatedData = (sessionId: string, messageId: string, continuation: string | null) =>
  Buffer.from(JSON.stringify(["viber-turn", 1, sessionId, messageId, continuation]));

export class ViberSnapshots {
  constructor(private readonly key?: Buffer) {}

  seal = (snapshot: Snapshot) => {
    if (!this.key) {
      throw unavailable();
    }

    const { request_id, session_id, continue_message_id } = snapshot.request;
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(associatedData(session_id, request_id, continue_message_id ?? null));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(snapshot)), cipher.final()]);

    return JSON.stringify({
      continue_message_id,
      sealed: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64"),
    });
  };

  read = (source: string, sessionId: string, messageId: string) => {
    if (!this.key) {
      throw unavailable();
    }

    try {
      const { sealed, continue_message_id: continuation = null } = JSON.parse(source);
      const payload = Buffer.from(sealed, "base64");

      const decipher = createDecipheriv("aes-256-gcm", this.key, payload.subarray(0, 12), {
        authTagLength: 16,
      });

      decipher.setAuthTag(payload.subarray(12, 28));
      decipher.setAAD(associatedData(sessionId, messageId, continuation));
      const plain = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]);
      return ViberMessageSnapshotSchema.parse(JSON.parse(plain.toString("utf8")));
    } catch {
      throw new AdeError("snapshot_integrity", "The saved Viber turn could not be verified.");
    }
  };
}
