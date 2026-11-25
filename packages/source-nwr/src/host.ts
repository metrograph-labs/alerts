/**
 * The host check of the receiver. The receiver needs two programs on the `PATH` of the host: the tuner `rtl_fm` and the
 * decoder `multimon-ng`. The check finds each of them and does not throw for a missing program.
 */

import { shellWhich } from "@procedures/shell";
import { DECODER, TUNER } from "./programs.ts";

/** The function that finds a program on the `PATH`. It gives the path of the program, or `undefined` when the host does not have it. */
export type FindProgram = (name: string) => Promise<string | undefined>;

/** The result of the check of one program. */
export type ProgramCheck = { readonly name: string; readonly found: true; readonly path: string } | { readonly name: string; readonly found: false };

/** The result of the host check. */
export interface HostCheck {
  /** True when the host has each program. */
  readonly ready: boolean;
  /** The check of each program, the tuner first. */
  readonly programs: readonly ProgramCheck[];
  /** The names of the programs that the host does not have. */
  readonly missing: readonly string[];
}

/** This function finds a program with `shellWhich` of `@procedures/shell`. It starts no shell. */
export const findOnPath: FindProgram = async (name) => {
  const found = await shellWhich({ command: name });
  return found.found && found.path !== null ? found.path : undefined;
};

/**
 * This function tells which programs of the receiver the host has. A failure of the search of one program gives a
 * missing program, not an error.
 */
export async function checkHost(find: FindProgram = findOnPath): Promise<HostCheck> {
  const programs = await Promise.all(
    [TUNER, DECODER].map(async (name): Promise<ProgramCheck> => {
      const path = await find(name).catch(() => undefined);
      return path === undefined ? { name, found: false } : { name, found: true, path };
    }),
  );
  const missing = programs.filter((program) => !program.found).map((program) => program.name);
  return { ready: missing.length === 0, programs, missing };
}
