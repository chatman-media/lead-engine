import type { Style } from "@chatman-media/kb";
import { localBro } from "./local-bro.ts";
import { proRental } from "./pro-rental.ts";
import { safetyFirst } from "./safety-first.ts";

export const SCOOTER_STYLES: readonly Style[] = [
  localBro,
  proRental,
  safetyFirst,
];

export { localBro, proRental, safetyFirst };
