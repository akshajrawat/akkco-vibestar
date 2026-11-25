import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AdeError } from "../domain";
import { ViberMessageSnapshotSchema } from "../vibers/contracts";
import type { z } from "zod";

type Snapshot = z.infer<typeof ViberMessageSnapshotSchema>;

export const viberSnapshotKeyPath = (databasePath: string) => `${databasePath}.viber-key`;

const unavailable = () =>
  new AdeError("snapshot_key", "The private Viber snapshot key is unavailable.");

const ownerOnlyFile = (info: Stats) =>
  info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o777) === 0o600;

const stagedKeyPrefix = (path: string) => `${basename(path)}.tmp-`;
const stagedKeyId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const finishKeyPublication = async (path: string, info: Stats) => {
  const directory = dirname(path);
  const prefix = stagedKeyPrefix(path);
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !stagedKeyId.test(name.slice(prefix.length))) {
      continue;
    }

    const stagedPath = join(directory, name);

    const staged = await lstat(stagedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });

    if (staged && staged.dev === info.dev && staged.ino === info.ino) {
      // A racing loader can finish publication even if the original creator stopped.
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }

      await rm(stagedPath, { force: true });
      return;
    }
  }
};

const readViberSnapshotKey = async (path: string) => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    let info = await file.stat();
    if (ownerOnlyFile(info) && info.size === 32 && info.nlink === 2) {
      await finishKeyPublication(path, info);
      info = await file.stat();
    }

    if (ownerOnlyFile(info) && info.size === 32 && info.nlink === 1) {
      const bytes = await file.readFile();
      return bytes.length === 32 ? bytes : undefined;
    }
  } finally {
    await file.close();
  }
};

const createViberSnapshotKey = async (path: string) => {
  const stagedPath = join(dirname(path), `${stagedKeyPrefix(path)}${randomUUID()}`);
  const file = await open(stagedPath, "wx", 0o600);
  let published = false;
  try {
    try {
      const info = await file.stat();
      if (!ownerOnlyFile(info) || info.nlink !== 1) {
        return undefined;
      }

      await file.writeFile(randomBytes(32));
      await file.sync();
    } finally {
      await file.close();
    }

    try {
      await link(stagedPath, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  } finally {
    if (!published) {
      await rm(stagedPath, { force: true });
    }
  }

  return readViberSnapshotKey(path);
};

export const loadViberSnapshotKey = async (path: string, create: boolean) => {
  try {
    return await readViberSnapshotKey(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && create) {
      return createViberSnapshotKey(path);
    }
  }
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
