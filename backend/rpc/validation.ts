import { z } from "zod";

export const idInput = z.object({ id: z.string().uuid() });
