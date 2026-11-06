/**
 * `kyoube connect claude` finished a Claude subscription sign-in in the Terminal: from 1.1 the core's
 * Connections showed a command that ran it, so the connection got a one-year `claude setup-token`
 * instead of the 8-hour login token. From core 2026.1023.0 the core runs `claude setup-token` itself,
 * in the browser: Connections opens Claude's sign-in link and takes the code back. The command stays
 * only to say so to someone following an older guide.
 */
export const RETIRED_MESSAGE =
  "Claude sign-in no longer needs the Terminal. In Connections, add a Claude subscription (or choose it on an agent's " +
  "Runtime tab), open the sign-in link it shows, then paste the code Claude gives you back into the browser.";

export async function runConnect(
  _positionals: string[],
  _flags: Record<string, string | true>,
  _env: NodeJS.ProcessEnv,
  log: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  log(RETIRED_MESSAGE);
  return 1;
}
