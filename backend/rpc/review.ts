import { z } from "zod";
import { AdeError } from "../domain";
import type { RpcServices } from "./services";
import { idInput } from "./validation";
export const reviewMethods = [
  "review.files",
  "review.reviewed",
  "review.questions",
  "review.ask",
  "review.list",
  "review.add",
  "review.remove",
  "review.send",
] as const;
/** Validates and dispatches review requests through their existing domain services. */
export const callReview = async (
  services: Pick<RpcServices, "review">,
  method: string,
  input: unknown,
) => {
  switch (method) {
    case "review.files":
      return services.review.files(idInput.strict().parse(input).id);
    case "review.reviewed":
      return services.review.reviewed(input);
    case "review.questions":
      return services.review.questions(idInput.strict().parse(input).id);
    case "review.ask":
      return services.review.ask(input);
    case "review.list":
      return services.review.list(idInput.parse(input).id);
    case "review.add":
      return services.review.add(input);
    case "review.remove":
      return services.review.remove(idInput.extend({ confirmed: z.literal(true) }).parse(input).id);
    case "review.send":
      return services.review.send(idInput.parse(input).id);
    default:
      throw new AdeError("invalid_method", `Unknown method: ${method}`);
  }
};
