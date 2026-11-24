import { AdeError } from "./domain";
import { AuthSessions } from "./execution/terminals/auth";
import type { Engine } from "./execution/engine";
import { GitHubService } from "./github/service";
import { callRepositories, repositoriesMethods } from "./rpc/repositories";
import { callStorage, storageMethods } from "./rpc/storage";
import { callSystem, systemMethods } from "./rpc/system";
import { callViberSessions, viberSessionMethods } from "./rpc/viber-sessions";
import { callViberTeams, viberTeamMethods } from "./rpc/viber-teams";
import { callProfiles, profileMethods } from "./rpc/profiles";
import { StorageService } from "./storage/service";

export class Rpc {
  private readonly handlers = new Map<
    string,
    (method: string, input: unknown) => Promise<unknown>
  >();

  private readonly auth: AuthSessions;

  readonly github: GitHubService;

  private readonly storage: StorageService;

  constructor(
    readonly engine: Engine,
    github?: GitHubService,
  ) {
    this.github = github || new GitHubService(engine);
    this.storage = new StorageService(engine);

    this.auth = new AuthSessions(engine.root, (event) => {
      engine.publish(event);
    });

    const services = {
      engine: this.engine,
      auth: this.auth,
      github: this.github,
      storage: this.storage,
    };

    for (const [methods, handler] of [
      [systemMethods, callSystem],
      [repositoriesMethods, callRepositories],
      [storageMethods, callStorage],
      [viberSessionMethods, callViberSessions],
      [viberTeamMethods, callViberTeams],
      [profileMethods, callProfiles],
    ] as const) {
      for (const method of methods) {
        this.handlers.set(method, (method, input) => handler(services, method, input));
      }
    }
  }

  /** Keeps transport dispatch narrow; domain handlers retain validation and ownership checks. */
  call = async (method: string, input: unknown) => {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
    }

    return handler(method, input);
  };

  close = async () => {
    this.auth.dispose();
    await this.github.close();
  };
}
