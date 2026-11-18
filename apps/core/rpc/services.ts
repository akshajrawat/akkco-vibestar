import type { AuthSessions } from "../execution/terminals/auth";
import type { Engine } from "../execution/engine";
import type { GitHubService } from "../github/service";
import type { StorageService } from "../storage/service";

/** Owned services supplied to domain dispatchers; callers never supply these capabilities. */
export interface RpcServices {
  engine: Engine;
  auth: AuthSessions;
  storage: StorageService;
  github: GitHubService;
}
